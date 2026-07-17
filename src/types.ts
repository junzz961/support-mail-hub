import type { DeliveryStatus, MailboxStatus, MessageDirection } from "../shared/types.ts";

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface SendEmailBinding {
  send(message: {
    to: string | EmailAddress | Array<string | EmailAddress>;
    from: string | EmailAddress;
    replyTo?: string | EmailAddress;
    subject: string;
    html?: string;
    text?: string;
    attachments?: Array<{
      content: string | ArrayBuffer | ArrayBufferView;
      filename: string;
      type: string;
      disposition: "attachment" | "inline";
      contentId?: string;
    }>;
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

export interface Env {
  MAIL_DB: D1Database;
  EMAIL: SendEmailBinding;
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ADMIN_EMAIL?: string;
  RETENTION_DAYS?: string;
  MAX_BODY_BYTES?: string;
}

export interface MailboxRow {
  id: string;
  address: string;
  label: string;
  senderName: string;
  forwardTo: string;
  status: MailboxStatus;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadRow {
  id: string;
  mailboxId: string;
  subject: string;
  participantEmail: string;
  participantName: string | null;
  createdAt: number;
  lastMessageAt: number;
}

export interface MessageRow {
  id: string;
  threadId: string;
  mailboxId: string;
  direction: MessageDirection;
  rfcMessageId: string | null;
  dedupeKey: string;
  inReplyTo: string | null;
  referencesJson: string;
  fromAddress: string;
  fromName: string | null;
  replyToAddress: string | null;
  toAddress: string;
  subject: string;
  bodyText: string;
  bodyTruncated: number;
  attachmentsJson: string;
  rawSize: number;
  deliveryStatus: DeliveryStatus;
  errorCode: string | null;
  clientRequestId: string | null;
  createdAt: number;
}

export interface InboundRecord {
  mailbox: MailboxRow;
  rfcMessageId: string | null;
  dedupeKey: string;
  inReplyTo: string | null;
  references: string[];
  fromAddress: string;
  fromName: string | null;
  replyToAddress: string | null;
  subject: string;
  bodyText: string;
  bodyTruncated: boolean;
  attachments: Array<{ name: string; type: string }>;
  rawSize: number;
  receivedAt: number;
}

export interface ReplyContext {
  thread: ThreadRow;
  mailbox: MailboxRow;
  latestInbound: MessageRow;
}
