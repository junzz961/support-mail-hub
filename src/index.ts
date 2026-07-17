import { AccessError, authenticateAccess } from "./access.ts";
import { api } from "./api.ts";
import { handleInboundEmail } from "./inbound.ts";
import { MailStore } from "./store.ts";
import type { Env } from "./types.ts";

function accessFailure(request: Request, error: AccessError): Response {
  const isApi = new URL(request.url).pathname.startsWith("/api/");
  const message = error.code === "ACCESS_NOT_CONFIGURED"
    ? "Cloudflare Access 尚未配置完成"
    : "无权访问 Support Mail Hub";
  if (isApi) {
    return Response.json({ ok: false, error: { code: error.code, message } }, { status: error.status });
  }
  return new Response(message, {
    status: error.status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      await authenticateAccess(request, env);
    } catch (error) {
      if (error instanceof AccessError) return accessFailure(request, error);
      throw error;
    }

    const pathname = new URL(request.url).pathname;
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      const response = await api.fetch(request, env, ctx);
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      headers.set("x-content-type-options", "nosniff");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("cache-control", pathname.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-store");
    headers.set("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-content-type-options", "nosniff");
    headers.set("x-frame-options", "DENY");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },

  async email(message, env): Promise<void> {
    await handleInboundEmail(message, env);
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    const configured = Number(env.RETENTION_DAYS);
    const days = Number.isSafeInteger(configured) && configured >= 1 && configured <= 3_650 ? configured : 90;
    const cutoff = Date.now() - days * 86_400_000;
    ctx.waitUntil(
      new MailStore(env.MAIL_DB).purgeBefore(cutoff).then((result) => {
        console.log(JSON.stringify({ event: "retention_cleanup", ...result }));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
