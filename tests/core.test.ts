import assert from "node:assert/strict";
import test from "node:test";
import type { JWTPayload } from "jose";
import { accessEmailMatches } from "../src/access.ts";
import {
  buildReplyHeaders,
  decodeCursor,
  encodeCursor,
  extractMessageIds,
  htmlToPlainText,
  normalizeEmail,
  normalizeMessageId,
  normalizeReplySubject,
  truncateUtf8,
} from "../src/core.ts";

test("normalizes addresses, subjects and RFC message IDs", () => {
  assert.equal(normalizeEmail(" Owner@Example.COM "), "owner@example.com");
  assert.equal(normalizeEmail("not-an-email"), null);
  assert.equal(normalizeMessageId("abc@example.com"), "<abc@example.com>");
  assert.equal(normalizeMessageId("bad\r\nBcc:x@example.com"), null);
  assert.equal(normalizeReplySubject("Status update"), "Re: Status update");
  assert.equal(normalizeReplySubject("RE: Status update"), "RE: Status update");
});

test("extracts, deduplicates and bounds thread headers", () => {
  assert.deepEqual(extractMessageIds("<a@example.com> <a@example.com>", "<b@example.com>"), [
    "<a@example.com>", "<b@example.com>",
  ]);
  const many = Array.from({ length: 140 }, (_, index) => `<${index}@example.com>`);
  const headers = buildReplyHeaders("<latest@example.com>", many);
  assert.equal(headers["In-Reply-To"], "<latest@example.com>");
  assert.ok((headers.References.match(/</gu) ?? []).length <= 100);
  assert.ok(new TextEncoder().encode(headers.References).byteLength <= 1_900);
  assert.ok(headers.References.endsWith("<latest@example.com>"));
});

test("converts untrusted HTML to text and truncates on UTF-8 boundaries", () => {
  assert.equal(
    htmlToPlainText("<style>bad</style><p>Hello&nbsp;<b>world</b></p><script>alert(1)</script><div>Next</div>"),
    "Hello world\nNext",
  );
  const result = truncateUtf8("你好世界", 7);
  assert.equal(result.value, "你好");
  assert.equal(result.truncated, true);
});

test("round trips pagination cursors and fails closed for Access email", () => {
  const cursor = encodeCursor(123456, "thread-id");
  assert.deepEqual(decodeCursor(cursor), { timestamp: 123456, id: "thread-id" });
  assert.equal(decodeCursor("%%%"), null);
  assert.equal(accessEmailMatches({ email: "Owner@Example.com" } as JWTPayload, "owner@example.com"), true);
  assert.equal(accessEmailMatches({ email: "other@example.com" } as JWTPayload, "owner@example.com"), false);
});
