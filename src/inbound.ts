import PostalMime from "postal-mime";
import {
  cleanSingleLine,
  extractMessageIds,
  htmlToPlainText,
  normalizeEmail,
  normalizeMessageId,
  sha256Hex,
  truncateUtf8,
} from "./core.ts";
import { MailStore } from "./store.ts";
import type { InboundRecord, MailboxRow, MessageRow, Env } from "./types.ts";

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && code ? code.slice(0, 120) : "INBOUND_PROCESSING_FAILED";
}

function maxBodyBytes(env: Env): number {
  const configured = Number(env.MAX_BODY_BYTES);
  return Number.isSafeInteger(configured) && configured >= 16_384 && configured <= 500_000
    ? configured
    : 102_400;
}

async function forwardOriginal(
  message: ForwardableEmailMessage,
  mailbox: MailboxRow,
  store?: MailStore,
  stored?: MessageRow | null,
): Promise<boolean> {
  try {
    await message.forward(mailbox.forwardTo);
  } catch (error) {
    const code = errorCode(error);
    console.error(JSON.stringify({ event: "inbound_forward_failed", mailboxId: mailbox.id, code }));
    if (store && stored) {
      try {
        await store.updateInboundDelivery(stored.id, "forward_failed", code);
      } catch {
        // The original forwarding error remains the actionable failure.
      }
    }
    return false;
  }
  if (store && stored) {
    try {
      await store.updateInboundDelivery(stored.id, "forwarded");
    } catch (error) {
      console.error(JSON.stringify({
        event: "inbound_forward_state_update_failed",
        mailboxId: mailbox.id,
        messageId: stored.id,
        code: errorCode(error),
      }));
    }
  }
  return true;
}

export async function handleInboundEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const store = new MailStore(env.MAIL_DB);
  const recipient = normalizeEmail(message.to);
  const mailbox = recipient ? await store.getMailboxByAddress(recipient) : null;
  if (!mailbox) {
    message.setReject("Support mailbox is not configured");
    return;
  }

  if (mailbox.status === "archived") {
    console.warn(JSON.stringify({ event: "mail_received_for_archived_mailbox", mailboxId: mailbox.id }));
    if (!await forwardOriginal(message, mailbox)) {
      message.setReject("Archived mailbox forwarding failed");
    }
    return;
  }

  const rfcMessageId = normalizeMessageId(message.headers.get("message-id"));
  const preliminaryDedupeKey = rfcMessageId ? `mid:${rfcMessageId}` : null;
  if (preliminaryDedupeKey) {
    const duplicate = await store.getMessageByDedupeKey(preliminaryDedupeKey);
    if (duplicate) {
      if (duplicate.deliveryStatus !== "forwarded") {
        await forwardOriginal(message, mailbox, store, duplicate);
      }
      return;
    }
  }

  let raw: ArrayBuffer | null = null;
  let parsed: Awaited<ReturnType<typeof PostalMime.parse>> | null = null;
  try {
    raw = await new Response(message.raw).arrayBuffer();
    parsed = await PostalMime.parse(raw);
  } catch (error) {
    console.error(JSON.stringify({ event: "inbound_parse_failed", mailboxId: mailbox.id, code: errorCode(error) }));
  }

  const dedupeKey = preliminaryDedupeKey
    ?? (raw ? `sha256:${await sha256Hex(raw)}` : `fallback:${crypto.randomUUID()}`);
  const duplicate = await store.getMessageByDedupeKey(dedupeKey);
  if (duplicate) {
    if (duplicate.deliveryStatus !== "forwarded") await forwardOriginal(message, mailbox, store, duplicate);
    return;
  }

  const headerFrom = normalizeEmail(parsed?.from?.address);
  const envelopeFrom = normalizeEmail(message.from);
  const fromAddress = headerFrom ?? envelopeFrom ?? "unknown-sender@invalid.local";
  const replyToAddress = parsed?.replyTo
    ?.map((address) => normalizeEmail(address.address))
    .find((address): address is string => Boolean(address))
    ?? null;
  const subject = cleanSingleLine(parsed?.subject ?? message.headers.get("subject"), 998) || "(无主题)";
  const plain = parsed?.text?.trim()
    || (typeof parsed?.html === "string" ? htmlToPlainText(parsed.html) : "");
  const body = truncateUtf8(plain, maxBodyBytes(env));
  const inReplyTo = extractMessageIds(message.headers.get("in-reply-to")).at(-1) ?? null;
  const references = extractMessageIds(message.headers.get("references"));
  const attachments = (parsed?.attachments ?? []).map((attachment) => ({
    name: cleanSingleLine(attachment.filename || "未命名附件", 240),
    type: cleanSingleLine(attachment.mimeType || "application/octet-stream", 120),
  }));

  const record: InboundRecord = {
    mailbox,
    rfcMessageId,
    dedupeKey,
    inReplyTo,
    references,
    fromAddress,
    fromName: cleanSingleLine(parsed?.from?.name, 160) || null,
    replyToAddress,
    subject,
    bodyText: body.value,
    bodyTruncated: body.truncated,
    attachments,
    rawSize: message.rawSize,
    receivedAt: Date.now(),
  };

  let stored: MessageRow | null = null;
  try {
    stored = await store.recordInbound(record);
  } catch (error) {
    console.error(JSON.stringify({ event: "inbound_store_failed", mailboxId: mailbox.id, code: errorCode(error) }));
    stored = await store.getMessageByDedupeKey(dedupeKey).catch(() => null);
    if (stored?.deliveryStatus === "forwarded") return;
  }

  const forwarded = await forwardOriginal(message, mailbox, store, stored);
  if (!stored && !forwarded) message.setReject("Support mail processing failed");
}
