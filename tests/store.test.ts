import assert from "node:assert/strict";
import test from "node:test";
import { MailStore } from "../src/store.ts";
import type { InboundRecord } from "../src/types.ts";
import { setupDatabase } from "./helpers.ts";

async function seed() {
  const { sqlite, d1 } = setupDatabase();
  const store = new MailStore(d1);
  const mailbox = await store.createMailbox({
    address: "support@example.test",
    label: "Example",
    senderName: "Example Support",
    forwardTo: "owner@example.com",
  });
  const row = await store.getMailbox(mailbox.id);
  assert.ok(row);
  return { sqlite, store, mailbox: row };
}

function inbound(mailbox: NonNullable<Awaited<ReturnType<MailStore["getMailbox"]>>>, overrides: Partial<InboundRecord> = {}): InboundRecord {
  return {
    mailbox,
    rfcMessageId: "<inbound-1@example.com>",
    dedupeKey: "mid:<inbound-1@example.com>",
    inReplyTo: null,
    references: [],
    fromAddress: "jane@example.com",
    fromName: "Jane",
    replyToAddress: "jane+reply@example.com",
    subject: "Need help",
    bodyText: "Please help",
    bodyTruncated: false,
    attachments: [{ name: "screen.png", type: "image/png" }],
    rawSize: 100,
    receivedAt: Date.parse("2026-07-17T04:00:00Z"),
    ...overrides,
  };
}

test("stores, lists and deduplicates inbound conversations", async () => {
  const { sqlite, store, mailbox } = await seed();
  try {
    const first = await store.recordInbound(inbound(mailbox));
    const duplicate = await store.recordInbound(inbound(mailbox));
    assert.equal(duplicate.id, first.id);
    await store.updateInboundDelivery(first.id, "forwarded");

    const page = await store.listThreads({ limit: 30 });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.participantEmail, "jane+reply@example.com");
    assert.equal(page.items[0]?.latestStatus, "forwarded");
    const detail = await store.getThread(page.items[0]!.id);
    assert.equal(detail?.messages[0]?.attachments[0]?.name, "screen.png");
  } finally { sqlite.close(); }
});

test("matches replies by References and keeps thread boundaries", async () => {
  const { sqlite, store, mailbox } = await seed();
  try {
    const first = await store.recordInbound(inbound(mailbox));
    const second = await store.recordInbound(inbound(mailbox, {
      rfcMessageId: "<inbound-2@example.com>",
      dedupeKey: "mid:<inbound-2@example.com>",
      inReplyTo: first.rfcMessageId,
      references: [first.rfcMessageId!],
      bodyText: "Following up",
      receivedAt: Date.parse("2026-07-17T05:00:00Z"),
    }));
    assert.equal(second.threadId, first.threadId);
    const detail = await store.getThread(first.threadId);
    assert.equal(detail?.messages.length, 2);
  } finally { sqlite.close(); }
});

test("creates idempotent pending replies and purges old records", async () => {
  const { sqlite, store, mailbox } = await seed();
  try {
    const first = await store.recordInbound(inbound(mailbox));
    const context = await store.getReplyContext(first.threadId);
    assert.ok(context);
    const request = {
      context,
      clientRequestId: "02e2b2eb-b6d2-47c2-8aca-ff728a0c288f",
      recipient: "jane@example.com",
      subject: "Re: Need help",
      text: "We can help.",
      references: ["<inbound-1@example.com>"],
      now: Date.parse("2026-07-17T06:00:00Z"),
    };
    const pending = await store.createPendingReply(request);
    const duplicate = await store.createPendingReply(request);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.row.id, pending.row.id);
    const sent = await store.markReplySent(pending.row.id, "<outbound-1@example.test>");
    assert.equal(sent.deliveryStatus, "sent");

    const result = await store.purgeBefore(Date.parse("2026-07-18T00:00:00Z"));
    assert.equal(result.deletedMessages, 2);
    assert.equal(result.deletedThreads, 1);
  } finally { sqlite.close(); }
});
