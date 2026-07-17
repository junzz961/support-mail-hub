PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  label TEXT NOT NULL,
  senderName TEXT NOT NULL,
  forwardTo TEXT NOT NULL COLLATE NOCASE,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')) DEFAULT 'active',
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  mailboxId TEXT NOT NULL REFERENCES mailboxes(id),
  subject TEXT NOT NULL,
  participantEmail TEXT NOT NULL COLLATE NOCASE,
  participantName TEXT,
  createdAt INTEGER NOT NULL,
  lastMessageAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS threads_mailbox_activity_idx
  ON threads(mailboxId, lastMessageAt DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  threadId TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  mailboxId TEXT NOT NULL REFERENCES mailboxes(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  rfcMessageId TEXT,
  dedupeKey TEXT NOT NULL UNIQUE,
  inReplyTo TEXT,
  referencesJson TEXT NOT NULL DEFAULT '[]',
  fromAddress TEXT NOT NULL COLLATE NOCASE,
  fromName TEXT,
  replyToAddress TEXT,
  toAddress TEXT NOT NULL COLLATE NOCASE,
  subject TEXT NOT NULL,
  bodyText TEXT NOT NULL,
  bodyTruncated INTEGER NOT NULL DEFAULT 0 CHECK (bodyTruncated IN (0, 1)),
  attachmentsJson TEXT NOT NULL DEFAULT '[]',
  rawSize INTEGER NOT NULL DEFAULT 0,
  deliveryStatus TEXT NOT NULL CHECK (deliveryStatus IN (
    'stored', 'forwarded', 'forward_failed', 'pending', 'sent', 'send_failed', 'send_unknown'
  )),
  errorCode TEXT,
  clientRequestId TEXT UNIQUE,
  createdAt INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS messages_rfc_message_id_idx
  ON messages(rfcMessageId) WHERE rfcMessageId IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_thread_created_idx
  ON messages(threadId, createdAt ASC);
CREATE INDEX IF NOT EXISTS messages_mailbox_created_idx
  ON messages(mailboxId, createdAt DESC);
