import type { ReplyResult } from "../shared/types.ts";
import {
  buildReplyHeaders,
  cleanBody,
  escapeHtml,
  normalizeEmail,
  normalizeMessageId,
  normalizeReplySubject,
  safeJsonArray,
} from "./core.ts";
import { MailStore } from "./store.ts";
import type { Env, MessageRow } from "./types.ts";

export class ReplyError extends Error {
  readonly code: string;
  readonly status: 400 | 404 | 409 | 502;

  constructor(
    code: string,
    status: 400 | 404 | 409 | 502,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function emailErrorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && code ? code : "EMAIL_SEND_FAILED";
}

async function duplicateResult(store: MailStore, row: MessageRow): Promise<ReplyResult> {
  return store.replyResult(row, true);
}

export async function sendThreadReply(input: {
  env: Env;
  store: MailStore;
  threadId: string;
  clientRequestId: string;
  text: string;
}): Promise<ReplyResult> {
  const existing = await input.store.getMessageByClientRequestId(input.clientRequestId);
  if (existing) return duplicateResult(input.store, existing);

  const context = await input.store.getReplyContext(input.threadId);
  if (!context) throw new ReplyError("THREAD_NOT_FOUND", 404, "会话不存在或没有可回复的来信");
  if (context.mailbox.status !== "active") {
    throw new ReplyError("MAILBOX_ARCHIVED", 409, "该支持邮箱已归档，不能继续回复");
  }

  const recipient = normalizeEmail(context.latestInbound.replyToAddress)
    ?? normalizeEmail(context.latestInbound.fromAddress);
  if (!recipient) throw new ReplyError("INVALID_RECIPIENT", 409, "来信没有有效的回复地址");
  const text = cleanBody(input.text);
  if (!text) throw new ReplyError("EMPTY_REPLY", 400, "请输入回复内容");

  const subject = normalizeReplySubject(context.latestInbound.subject || context.thread.subject);
  const previousReferences = safeJsonArray<string>(context.latestInbound.referencesJson);
  const threadHeaders = buildReplyHeaders(context.latestInbound.rfcMessageId, previousReferences);
  const pending = await input.store.createPendingReply({
    context,
    clientRequestId: input.clientRequestId,
    recipient,
    subject,
    text,
    references: Object.values(threadHeaders),
    now: Date.now(),
  });
  if (pending.duplicate) return duplicateResult(input.store, pending.row);

  let sendResult: { messageId: string };
  try {
    sendResult = await input.env.EMAIL.send({
      to: recipient,
      from: { email: context.mailbox.address, name: context.mailbox.senderName },
      replyTo: context.mailbox.address,
      subject,
      text,
      html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.65;color:#17201d;white-space:normal">${escapeHtml(text).replaceAll("\n", "<br>")}</div>`,
      headers: {
        ...threadHeaders,
        "X-Support-Thread-ID": context.thread.id,
      },
    });
  } catch (error) {
    const code = emailErrorCode(error);
    await input.store.markReplyFailed(pending.row.id, "send_failed", code);
    throw new ReplyError(code, 502, "邮件发送失败，请检查 Email Service 配置后重试");
  }

  const rfcMessageId = normalizeMessageId(sendResult.messageId);
  if (!rfcMessageId) {
    const row = await input.store.markReplyFailed(
      pending.row.id,
      "send_unknown",
      "MISSING_MESSAGE_ID",
    );
    return input.store.replyResult(row, false);
  }

  try {
    const row = await input.store.markReplySent(pending.row.id, rfcMessageId);
    return input.store.replyResult(row, false);
  } catch (error) {
    console.error(JSON.stringify({
      event: "reply_state_update_failed",
      messageId: pending.row.id,
      code: emailErrorCode(error),
    }));
    throw new ReplyError(
      "SEND_STATE_UNKNOWN",
      502,
      "邮件已被服务接收，但本地状态未能确认；请先检查 Email Service 日志，避免重复发送",
    );
  }
}
