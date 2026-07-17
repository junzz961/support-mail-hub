import { Hono } from "hono";
import type { ApiFailure, ApiSuccess } from "../shared/types.ts";
import { cleanSingleLine, normalizeEmail, validClientRequestId } from "./core.ts";
import { ReplyError, sendThreadReply } from "./reply.ts";
import { MailStore } from "./store.ts";
import type { Env } from "./types.ts";

type AppEnv = { Bindings: Env };

const app = new Hono<AppEnv>();

function success<T>(data: T): ApiSuccess<T> {
  return { ok: true, data };
}

function failure(code: string, message: string): ApiFailure {
  return { ok: false, error: { code, message } };
}

function isJson(request: Request): boolean {
  return request.headers.get("content-type")?.toLowerCase().startsWith("application/json") ?? false;
}

function mailboxInput(value: unknown): {
  address: string;
  label: string;
  senderName: string;
  forwardTo: string;
} | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const address = normalizeEmail(body.address);
  const forwardTo = normalizeEmail(body.forwardTo);
  const label = cleanSingleLine(body.label, 80);
  const senderName = cleanSingleLine(body.senderName, 100);
  return address && forwardTo && address !== forwardTo && label && senderName
    ? { address, label, senderName, forwardTo }
    : null;
}

app.use("*", async (c, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
    const requestOrigin = c.req.header("origin");
    if (!requestOrigin || requestOrigin !== new URL(c.req.url).origin) {
      return c.json(failure("INVALID_ORIGIN", "请求来源无效"), 403);
    }
  }
  await next();
});

app.get("/api/health", (c) => c.json(success({ status: "ok", at: new Date().toISOString() })));

app.get("/api/mailboxes", async (c) => {
  return c.json(success(await new MailStore(c.env.MAIL_DB).listMailboxes()));
});

app.post("/api/mailboxes", async (c) => {
  if (!isJson(c.req.raw)) return c.json(failure("INVALID_CONTENT_TYPE", "请求必须使用 JSON"), 415);
  const input = mailboxInput(await c.req.json().catch(() => null));
  if (!input) return c.json(failure("INVALID_MAILBOX", "请填写有效的项目名、邮箱地址、显示名和转发邮箱"), 400);
  try {
    const mailbox = await new MailStore(c.env.MAIL_DB).createMailbox(input);
    return c.json(success(mailbox), 201);
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) {
      return c.json(failure("MAILBOX_EXISTS", "该支持邮箱已经存在"), 409);
    }
    throw error;
  }
});

app.patch("/api/mailboxes/:id", async (c) => {
  if (!isJson(c.req.raw)) return c.json(failure("INVALID_CONTENT_TYPE", "请求必须使用 JSON"), 415);
  const input = mailboxInput(await c.req.json().catch(() => null));
  if (!input) return c.json(failure("INVALID_MAILBOX", "请填写有效的项目名、邮箱地址、显示名和转发邮箱"), 400);
  try {
    const mailbox = await new MailStore(c.env.MAIL_DB).updateMailbox(c.req.param("id"), input);
    return mailbox
      ? c.json(success(mailbox))
      : c.json(failure("MAILBOX_NOT_FOUND", "支持邮箱不存在"), 404);
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) {
      return c.json(failure("MAILBOX_EXISTS", "该支持邮箱已经存在"), 409);
    }
    throw error;
  }
});

app.post("/api/mailboxes/:id/archive", async (c) => {
  const mailbox = await new MailStore(c.env.MAIL_DB).archiveMailbox(c.req.param("id"));
  return mailbox
    ? c.json(success(mailbox))
    : c.json(failure("MAILBOX_NOT_FOUND", "支持邮箱不存在"), 404);
});

app.get("/api/threads", async (c) => {
  const rawLimit = Number(c.req.query("limit"));
  const limit = Number.isSafeInteger(rawLimit) ? Math.min(50, Math.max(1, rawLimit)) : 30;
  const mailboxId = cleanSingleLine(c.req.query("mailboxId"), 100) || undefined;
  const cursor = c.req.query("cursor");
  if (cursor && cursor.length > 1_000) return c.json(failure("INVALID_CURSOR", "分页参数无效"), 400);
  const page = await new MailStore(c.env.MAIL_DB).listThreads({ mailboxId, cursor, limit });
  return c.json(success(page));
});

app.get("/api/threads/:id", async (c) => {
  const thread = await new MailStore(c.env.MAIL_DB).getThread(c.req.param("id"));
  return thread
    ? c.json(success(thread))
    : c.json(failure("THREAD_NOT_FOUND", "会话不存在"), 404);
});

app.post("/api/threads/:id/replies", async (c) => {
  if (!isJson(c.req.raw)) return c.json(failure("INVALID_CONTENT_TYPE", "请求必须使用 JSON"), 415);
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || !validClientRequestId(body.clientRequestId)) {
    return c.json(failure("INVALID_REQUEST_ID", "发送请求标识无效"), 400);
  }
  if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 50_000) {
    return c.json(failure("INVALID_REPLY", "回复内容应为 1–50,000 个字符"), 400);
  }
  try {
    const result = await sendThreadReply({
      env: c.env,
      store: new MailStore(c.env.MAIL_DB),
      threadId: c.req.param("id"),
      clientRequestId: body.clientRequestId,
      text: body.text,
    });
    return c.json(success(result));
  } catch (error) {
    if (error instanceof ReplyError) {
      return c.json(failure(error.code, error.message), error.status);
    }
    throw error;
  }
});

app.notFound((c) => c.json(failure("NOT_FOUND", "接口不存在"), 404));

app.onError((error, c) => {
  const requestId = crypto.randomUUID();
  console.error(JSON.stringify({ event: "api_error", requestId, message: String(error) }));
  return c.json(failure("INTERNAL_ERROR", `服务暂时不可用（${requestId}）`), 500);
});

export const api = app;
