import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { D1Database } from "@cloudflare/workers-types";

class TestStatement {
  private values: Array<string | number | null> = [];
  private readonly statement: StatementSync;

  constructor(statement: StatementSync) {
    this.statement = statement;
  }

  bind(...values: Array<string | number | null>) {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, number> }> {
    return { results: this.statement.all(...this.values) as T[], success: true, meta: {} };
  }

  async run(): Promise<{ results: never[]; success: true; meta: { changes: number } }> {
    const result = this.statement.run(...this.values);
    return { results: [], success: true, meta: { changes: Number(result.changes) } };
  }
}

export function setupDatabase(): { sqlite: DatabaseSync; d1: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  const here = dirname(fileURLToPath(import.meta.url));
  sqlite.exec(readFileSync(resolve(here, "../migrations/0001_init.sql"), "utf8"));
  const d1 = {
    prepare(sql: string) {
      return new TestStatement(sqlite.prepare(sql));
    },
    async batch(statements: TestStatement[]) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { sqlite, d1 };
}

export function rawEmail(input: {
  from?: string;
  to?: string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  body?: string;
  contentType?: string;
} = {}): string {
  return [
    `From: ${input.from ?? "Jane Example <jane@example.com>"}`,
    `To: ${input.to ?? "support@example.test"}`,
    `Subject: ${input.subject ?? "Need help"}`,
    `Message-ID: ${input.messageId ?? "<incoming-1@example.com>"}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references ? [`References: ${input.references}`] : []),
    `Date: Fri, 17 Jul 2026 04:00:00 +0000`,
    `Content-Type: ${input.contentType ?? "text/plain; charset=utf-8"}`,
    "",
    input.body ?? "Hello, I need help with my video.",
  ].join("\r\n");
}

export function fakeIncoming(raw: string, input: { from?: string; to?: string } = {}) {
  const bytes = new TextEncoder().encode(raw);
  const headers = new Headers();
  const headerBlock = raw.split("\r\n\r\n", 1)[0] ?? "";
  for (const line of headerBlock.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) headers.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  const forwarded: string[] = [];
  const rejected: string[] = [];
  const message = {
    from: input.from ?? "jane@example.com",
    to: input.to ?? "support@example.test",
    headers,
    raw: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    rawSize: bytes.byteLength,
    canBeForwarded: true,
    async forward(destination: string) {
      forwarded.push(destination);
      return { messageId: "forwarded-id" };
    },
    async reply() { return { messageId: "reply-id" }; },
    setReject(reason: string) { rejected.push(reason); },
  } as unknown as ForwardableEmailMessage;
  return { message, forwarded, rejected };
}
