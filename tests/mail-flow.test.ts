import assert from "node:assert/strict";
import test from "node:test";
import { handleInboundEmail } from "../src/inbound.ts";
import { sendThreadReply } from "../src/reply.ts";
import { MailStore } from "../src/store.ts";
import type { Env } from "../src/types.ts";
import { fakeIncoming, rawEmail, setupDatabase } from "./helpers.ts";

test("archives inbound text, forwards the original and suppresses duplicate forwards", async () => {
  const { sqlite, d1 } = setupDatabase();
  const store = new MailStore(d1);
  try {
    await store.createMailbox({
      address: "support@example.test",
      label: "Example",
      senderName: "Example Support",
      forwardTo: "owner@example.com",
    });
    const first = fakeIncoming(rawEmail());
    await handleInboundEmail(first.message, { MAIL_DB: d1 } as Env);
    assert.deepEqual(first.forwarded, ["owner@example.com"]);
    assert.deepEqual(first.rejected, []);
    const page = await store.listThreads({ limit: 30 });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.latestStatus, "forwarded");

    const duplicate = fakeIncoming(rawEmail());
    await handleInboundEmail(duplicate.message, { MAIL_DB: d1 } as Env);
    assert.deepEqual(duplicate.forwarded, []);
    assert.equal((await store.listThreads({ limit: 30 })).items.length, 1);
  } finally { sqlite.close(); }
});

test("rejects unknown mailboxes and forwards archived aliases without storing", async () => {
  const { sqlite, d1 } = setupDatabase();
  const store = new MailStore(d1);
  try {
    const unknown = fakeIncoming(rawEmail(), { to: "missing@example.test" });
    await handleInboundEmail(unknown.message, { MAIL_DB: d1 } as Env);
    assert.equal(unknown.rejected.length, 1);

    const mailbox = await store.createMailbox({
      address: "support@example.test",
      label: "Example",
      senderName: "Example Support",
      forwardTo: "owner@example.com",
    });
    await store.archiveMailbox(mailbox.id);
    const archived = fakeIncoming(rawEmail());
    await handleInboundEmail(archived.message, { MAIL_DB: d1 } as Env);
    assert.deepEqual(archived.forwarded, ["owner@example.com"]);
    assert.equal((await store.listThreads({ limit: 30 })).items.length, 0);
  } finally { sqlite.close(); }
});

test("sends a threaded reply from the selected mailbox and is idempotent", async () => {
  const { sqlite, d1 } = setupDatabase();
  const sent: Array<Record<string, unknown>> = [];
  const env = {
    MAIL_DB: d1,
    EMAIL: {
      async send(message: Record<string, unknown>) {
        sent.push(message);
        return { messageId: "outbound-1@example.test" };
      },
    },
  } as unknown as Env;
  const store = new MailStore(d1);
  try {
    await store.createMailbox({
      address: "support@example.test",
      label: "Example",
      senderName: "Example Support",
      forwardTo: "owner@example.com",
    });
    const incoming = fakeIncoming(rawEmail());
    await handleInboundEmail(incoming.message, env);
    const thread = (await store.listThreads({ limit: 30 })).items[0]!;
    const request = {
      env,
      store,
      threadId: thread.id,
      clientRequestId: "02e2b2eb-b6d2-47c2-8aca-ff728a0c288f",
      subject: "Re: Custom support subject",
      text: "Thanks — we are looking into it.",
      images: [{ filename: "screenshot.png", type: "image/png", content: "aGVsbG8=", size: 5 }],
    };
    const first = await sendThreadReply(request);
    const duplicate = await sendThreadReply(request);
    assert.equal(first.message.deliveryStatus, "sent");
    assert.equal(duplicate.duplicate, true);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.from, { email: "support@example.test", name: "Example Support" });
    assert.equal(sent[0]?.to, "jane@example.com");
    assert.equal(sent[0]?.subject, "Re: Custom support subject");
    const attachments = sent[0]?.attachments as Array<Record<string, unknown>>;
    assert.equal(attachments[0]?.filename, "screenshot.png");
    assert.equal(attachments[0]?.type, "image/png");
    assert.equal(attachments[0]?.disposition, "attachment");
    assert.deepEqual(Array.from(attachments[0]?.content as Uint8Array), [104, 101, 108, 108, 111]);
    assert.deepEqual((sent[0]?.headers as Record<string, string>)["In-Reply-To"], "<incoming-1@example.com>");
    const detail = await store.getThread(thread.id);
    assert.equal(detail?.messages.length, 2);
    assert.deepEqual(detail?.messages.at(-1)?.attachments, [{ name: "screenshot.png", type: "image/png" }]);
  } finally { sqlite.close(); }
});
