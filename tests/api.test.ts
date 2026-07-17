import assert from "node:assert/strict";
import test from "node:test";
import { api } from "../src/api.ts";
import type { Env } from "../src/types.ts";
import { setupDatabase } from "./helpers.ts";

test("mutation APIs enforce same-origin requests", async () => {
  const { sqlite, d1 } = setupDatabase();
  try {
    const response = await api.request("https://hub.example/api/mailboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "Example",
        address: "support@example.com",
        senderName: "Example Support",
        forwardTo: "owner@example.com",
      }),
    }, { MAIL_DB: d1 } as Env);
    assert.equal(response.status, 403);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "INVALID_ORIGIN");
  } finally { sqlite.close(); }
});

test("mailbox settings reject forwarding loops and create valid mappings", async () => {
  const { sqlite, d1 } = setupDatabase();
  const env = { MAIL_DB: d1 } as Env;
  const request = (body: Record<string, string>) => api.request("https://hub.example/api/mailboxes", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://hub.example" },
    body: JSON.stringify(body),
  }, env);
  try {
    const loop = await request({
      label: "Loop",
      address: "support@example.com",
      senderName: "Support",
      forwardTo: "support@example.com",
    });
    assert.equal(loop.status, 400);

    const created = await request({
      label: "Example",
      address: "support@example.com",
      senderName: "Example Support",
      forwardTo: "owner@example.com",
    });
    assert.equal(created.status, 201);
    const payload = await created.json() as { data: { address: string; status: string } };
    assert.equal(payload.data.address, "support@example.com");
    assert.equal(payload.data.status, "active");
  } finally { sqlite.close(); }
});
