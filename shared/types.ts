export type MailboxStatus = "active" | "archived";
export type MessageDirection = "inbound" | "outbound";
export type DeliveryStatus =
  | "stored"
  | "forwarded"
  | "forward_failed"
  | "pending"
  | "sent"
  | "send_failed"
  | "send_unknown";

export interface Mailbox {
  id: string;
  address: string;
  label: string;
  senderName: string;
  forwardTo: string;
  status: MailboxStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentMetadata {
  name: string;
  type: string;
}

export interface MailMessage {
  id: string;
  direction: MessageDirection;
  fromAddress: string;
  fromName?: string;
  toAddress: string;
  subject: string;
  bodyText: string;
  bodyTruncated: boolean;
  attachments: AttachmentMetadata[];
  deliveryStatus: DeliveryStatus;
  errorCode?: string;
  createdAt: string;
}

export interface ThreadSummary {
  id: string;
  mailboxId: string;
  mailboxAddress: string;
  mailboxLabel: string;
  subject: string;
  participantEmail: string;
  participantName?: string;
  lastMessageAt: string;
  latestDirection: MessageDirection;
  latestStatus: DeliveryStatus;
  preview: string;
}

export interface ThreadDetail extends ThreadSummary {
  mailboxStatus: MailboxStatus;
  messages: MailMessage[];
}

export interface ThreadPage {
  items: ThreadSummary[];
  nextCursor?: string;
}

export interface ReplyResult {
  message: MailMessage;
  duplicate: boolean;
}

export type ApiSuccess<T> = { ok: true; data: T };
export type ApiFailure = { ok: false; error: { code: string; message: string } };
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
