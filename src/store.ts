import type {
  AttachmentMetadata,
  Mailbox,
  MailMessage,
  ReplyResult,
  ThreadDetail,
  ThreadPage,
  ThreadSummary,
} from "../shared/types.ts";
import { decodeCursor, encodeCursor, safeJsonArray } from "./core.ts";
import type { InboundRecord, MailboxRow, MessageRow, ReplyContext, ThreadRow } from "./types.ts";

type SqlValue = string | number | null;

interface ThreadSummaryRow extends ThreadRow {
  mailboxAddress: string;
  mailboxLabel: string;
  mailboxStatus: "active" | "archived";
  latestDirection: "inbound" | "outbound";
  latestStatus: ThreadSummary["latestStatus"];
  preview: string;
}

const iso = (value: number): string => new Date(value).toISOString();

export function toMailbox(row: MailboxRow): Mailbox {
  return {
    id: row.id,
    address: row.address,
    label: row.label,
    senderName: row.senderName,
    forwardTo: row.forwardTo,
    status: row.status,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toMessage(row: MessageRow): MailMessage {
  return {
    id: row.id,
    direction: row.direction,
    fromAddress: row.fromAddress,
    ...(row.fromName ? { fromName: row.fromName } : {}),
    toAddress: row.toAddress,
    subject: row.subject,
    bodyText: row.bodyText,
    bodyTruncated: row.bodyTruncated === 1,
    attachments: safeJsonArray<AttachmentMetadata>(row.attachmentsJson),
    deliveryStatus: row.deliveryStatus,
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    createdAt: iso(row.createdAt),
  };
}

function toThreadSummary(row: ThreadSummaryRow): ThreadSummary {
  return {
    id: row.id,
    mailboxId: row.mailboxId,
    mailboxAddress: row.mailboxAddress,
    mailboxLabel: row.mailboxLabel,
    subject: row.subject,
    participantEmail: row.participantEmail,
    ...(row.participantName ? { participantName: row.participantName } : {}),
    lastMessageAt: iso(row.lastMessageAt),
    latestDirection: row.latestDirection,
    latestStatus: row.latestStatus,
    preview: row.preview,
  };
}

const SUMMARY_SELECT = `
  SELECT t.*, mb.address AS mailboxAddress, mb.label AS mailboxLabel, mb.status AS mailboxStatus,
         lm.direction AS latestDirection, lm.deliveryStatus AS latestStatus,
         substr(replace(lm.bodyText, char(10), ' '), 1, 180) AS preview
  FROM threads t
  JOIN mailboxes mb ON mb.id = t.mailboxId
  JOIN messages lm ON lm.id = (
    SELECT m.id FROM messages m
    WHERE m.threadId = t.id
    ORDER BY m.createdAt DESC, m.id DESC LIMIT 1
  )`;

export class MailStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async listMailboxes(): Promise<Mailbox[]> {
    const rows = await this.db.prepare(
      "SELECT * FROM mailboxes ORDER BY status ASC, label COLLATE NOCASE ASC, address ASC",
    ).all<MailboxRow>();
    return rows.results.map(toMailbox);
  }

  async getMailbox(id: string): Promise<MailboxRow | null> {
    return this.db.prepare("SELECT * FROM mailboxes WHERE id = ?").bind(id).first<MailboxRow>();
  }

  async getMailboxByAddress(address: string): Promise<MailboxRow | null> {
    return this.db.prepare("SELECT * FROM mailboxes WHERE address = ? COLLATE NOCASE")
      .bind(address).first<MailboxRow>();
  }

  async createMailbox(input: {
    address: string;
    label: string;
    senderName: string;
    forwardTo: string;
  }): Promise<Mailbox> {
    const id = crypto.randomUUID();
    const now = Date.now();
    await this.db.prepare(
      `INSERT INTO mailboxes (id, address, label, senderName, forwardTo, status, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).bind(id, input.address, input.label, input.senderName, input.forwardTo, now, now).run();
    return toMailbox((await this.getMailbox(id))!);
  }

  async updateMailbox(id: string, input: {
    address: string;
    label: string;
    senderName: string;
    forwardTo: string;
  }): Promise<Mailbox | null> {
    const current = await this.getMailbox(id);
    if (!current) return null;
    await this.db.prepare(
      `UPDATE mailboxes SET address = ?, label = ?, senderName = ?, forwardTo = ?, updatedAt = ?
       WHERE id = ?`,
    ).bind(input.address, input.label, input.senderName, input.forwardTo, Date.now(), id).run();
    return toMailbox((await this.getMailbox(id))!);
  }

  async archiveMailbox(id: string): Promise<Mailbox | null> {
    const current = await this.getMailbox(id);
    if (!current) return null;
    await this.db.prepare(
      "UPDATE mailboxes SET status = 'archived', updatedAt = ? WHERE id = ?",
    ).bind(Date.now(), id).run();
    return toMailbox((await this.getMailbox(id))!);
  }

  async activateMailbox(id: string): Promise<Mailbox | null> {
    const current = await this.getMailbox(id);
    if (!current) return null;
    await this.db.prepare(
      "UPDATE mailboxes SET status = 'active', updatedAt = ? WHERE id = ?",
    ).bind(Date.now(), id).run();
    return toMailbox((await this.getMailbox(id))!);
  }

  async getMessageByDedupeKey(dedupeKey: string): Promise<MessageRow | null> {
    return this.db.prepare("SELECT * FROM messages WHERE dedupeKey = ?")
      .bind(dedupeKey).first<MessageRow>();
  }

  async getMessageByClientRequestId(clientRequestId: string): Promise<MessageRow | null> {
    return this.db.prepare("SELECT * FROM messages WHERE clientRequestId = ?")
      .bind(clientRequestId).first<MessageRow>();
  }

  async findThreadForReferences(mailboxId: string, references: string[]): Promise<string | null> {
    const ids = references.slice(-80);
    if (!ids.length) return null;
    const placeholders = ids.map(() => "?").join(",");
    const row = await this.db.prepare(
      `SELECT threadId FROM messages
       WHERE mailboxId = ? AND rfcMessageId IN (${placeholders})
       ORDER BY createdAt DESC LIMIT 1`,
    ).bind(mailboxId, ...ids).first<{ threadId: string }>();
    return row?.threadId ?? null;
  }

  async recordInbound(record: InboundRecord): Promise<MessageRow> {
    const existing = await this.getMessageByDedupeKey(record.dedupeKey);
    if (existing) return existing;

    const referencedThread = await this.findThreadForReferences(
      record.mailbox.id,
      [...record.references, ...(record.inReplyTo ? [record.inReplyTo] : [])],
    );
    const threadId = referencedThread ?? crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const participantEmail = record.replyToAddress ?? record.fromAddress;
    const statements: D1PreparedStatement[] = [];

    if (referencedThread) {
      statements.push(this.db.prepare(
        `UPDATE threads SET participantEmail = ?, participantName = ?, lastMessageAt = ? WHERE id = ?`,
      ).bind(participantEmail, record.fromName, record.receivedAt, threadId));
    } else {
      statements.push(this.db.prepare(
        `INSERT INTO threads
         (id, mailboxId, subject, participantEmail, participantName, createdAt, lastMessageAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        threadId,
        record.mailbox.id,
        record.subject,
        participantEmail,
        record.fromName,
        record.receivedAt,
        record.receivedAt,
      ));
    }

    statements.push(this.db.prepare(
      `INSERT INTO messages (
         id, threadId, mailboxId, direction, rfcMessageId, dedupeKey, inReplyTo,
         referencesJson, fromAddress, fromName, replyToAddress, toAddress, subject,
         bodyText, bodyTruncated, attachmentsJson, rawSize, deliveryStatus, createdAt
       ) VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stored', ?)`,
    ).bind(
      messageId,
      threadId,
      record.mailbox.id,
      record.rfcMessageId,
      record.dedupeKey,
      record.inReplyTo,
      JSON.stringify(record.references),
      record.fromAddress,
      record.fromName,
      record.replyToAddress,
      record.mailbox.address,
      record.subject,
      record.bodyText,
      record.bodyTruncated ? 1 : 0,
      JSON.stringify(record.attachments),
      record.rawSize,
      record.receivedAt,
    ));

    await this.db.batch(statements);
    return (await this.getMessageByDedupeKey(record.dedupeKey))!;
  }

  async updateInboundDelivery(id: string, status: "forwarded" | "forward_failed", errorCode?: string): Promise<void> {
    await this.db.prepare(
      "UPDATE messages SET deliveryStatus = ?, errorCode = ? WHERE id = ? AND direction = 'inbound'",
    ).bind(status, errorCode ?? null, id).run();
  }

  async listThreads(params: { mailboxId?: string; cursor?: string; limit: number }): Promise<ThreadPage> {
    const cursor = decodeCursor(params.cursor);
    const conditions: string[] = [];
    const values: SqlValue[] = [];
    if (params.mailboxId) {
      conditions.push("t.mailboxId = ?");
      values.push(params.mailboxId);
    }
    if (cursor) {
      conditions.push("(t.lastMessageAt < ? OR (t.lastMessageAt = ? AND t.id < ?))");
      values.push(cursor.timestamp, cursor.timestamp, cursor.id);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = await this.db.prepare(
      `${SUMMARY_SELECT}${where}
       ORDER BY t.lastMessageAt DESC, t.id DESC LIMIT ?`,
    ).bind(...values, params.limit + 1).all<ThreadSummaryRow>();

    const hasMore = rows.results.length > params.limit;
    const visible = hasMore ? rows.results.slice(0, params.limit) : rows.results;
    const last = visible.at(-1);
    return {
      items: visible.map(toThreadSummary),
      ...(hasMore && last ? { nextCursor: encodeCursor(last.lastMessageAt, last.id) } : {}),
    };
  }

  async getThread(id: string): Promise<ThreadDetail | null> {
    const summary = await this.db.prepare(
      `${SUMMARY_SELECT} WHERE t.id = ?`,
    ).bind(id).first<ThreadSummaryRow>();
    if (!summary) return null;
    const messages = await this.db.prepare(
      "SELECT * FROM messages WHERE threadId = ? ORDER BY createdAt ASC, id ASC",
    ).bind(id).all<MessageRow>();
    return {
      ...toThreadSummary(summary),
      mailboxStatus: summary.mailboxStatus,
      messages: messages.results.map(toMessage),
    };
  }

  async getReplyContext(threadId: string): Promise<ReplyContext | null> {
    const thread = await this.db.prepare("SELECT * FROM threads WHERE id = ?")
      .bind(threadId).first<ThreadRow>();
    if (!thread) return null;
    const mailbox = await this.getMailbox(thread.mailboxId);
    if (!mailbox) return null;
    const latestInbound = await this.db.prepare(
      `SELECT * FROM messages
       WHERE threadId = ? AND direction = 'inbound'
       ORDER BY createdAt DESC, id DESC LIMIT 1`,
    ).bind(threadId).first<MessageRow>();
    return latestInbound ? { thread, mailbox, latestInbound } : null;
  }

  async createPendingReply(input: {
    context: ReplyContext;
    clientRequestId: string;
    recipient: string;
    subject: string;
    text: string;
    attachments: Array<{ name: string; type: string }>;
    rawSize: number;
    references: string[];
    now: number;
  }): Promise<{ row: MessageRow; duplicate: boolean }> {
    const duplicate = await this.getMessageByClientRequestId(input.clientRequestId);
    if (duplicate) return { row: duplicate, duplicate: true };

    const id = crypto.randomUUID();
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO messages (
           id, threadId, mailboxId, direction, dedupeKey, inReplyTo, referencesJson,
           fromAddress, fromName, replyToAddress, toAddress, subject, bodyText,
           bodyTruncated, attachmentsJson, rawSize, deliveryStatus, clientRequestId, createdAt
         ) VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'pending', ?, ?)`,
      ).bind(
        id,
        input.context.thread.id,
        input.context.mailbox.id,
        `out:${input.clientRequestId}`,
        input.context.latestInbound.rfcMessageId,
        JSON.stringify(input.references),
        input.context.mailbox.address,
        input.context.mailbox.senderName,
        input.context.mailbox.address,
        input.recipient,
        input.subject,
        input.text,
        JSON.stringify(input.attachments),
        input.rawSize,
        input.clientRequestId,
        input.now,
      ),
      this.db.prepare("UPDATE threads SET lastMessageAt = ? WHERE id = ?")
        .bind(input.now, input.context.thread.id),
    ]);
    return { row: (await this.getMessageByClientRequestId(input.clientRequestId))!, duplicate: false };
  }

  async markReplySent(id: string, rfcMessageId: string): Promise<MessageRow> {
    await this.db.prepare(
      `UPDATE messages SET rfcMessageId = ?, deliveryStatus = 'sent', errorCode = NULL
       WHERE id = ? AND direction = 'outbound'`,
    ).bind(rfcMessageId, id).run();
    return (await this.db.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first<MessageRow>())!;
  }

  async markReplyFailed(id: string, status: "send_failed" | "send_unknown", errorCode: string): Promise<MessageRow> {
    await this.db.prepare(
      "UPDATE messages SET deliveryStatus = ?, errorCode = ? WHERE id = ? AND direction = 'outbound'",
    ).bind(status, errorCode.slice(0, 120), id).run();
    return (await this.db.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first<MessageRow>())!;
  }

  async replyResult(row: MessageRow, duplicate: boolean): Promise<ReplyResult> {
    return { message: toMessage(row), duplicate };
  }

  async purgeBefore(cutoff: number): Promise<{ deletedMessages: number; deletedThreads: number }> {
    const messageResult = await this.db.prepare("DELETE FROM messages WHERE createdAt < ?").bind(cutoff).run();
    const threadResult = await this.db.prepare(
      "DELETE FROM threads WHERE NOT EXISTS (SELECT 1 FROM messages WHERE messages.threadId = threads.id)",
    ).run();
    return {
      deletedMessages: messageResult.meta.changes ?? 0,
      deletedThreads: threadResult.meta.changes ?? 0,
    };
  }
}
