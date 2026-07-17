import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Env } from "./types.ts";

const jwksByOrigin = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export class AccessError extends Error {
  readonly code: "ACCESS_NOT_CONFIGURED" | "ACCESS_DENIED";
  readonly status: 401 | 503;

  constructor(
    code: "ACCESS_NOT_CONFIGURED" | "ACCESS_DENIED",
    status: 401 | 503,
  ) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function accessOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".cloudflareaccess.com")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function accessEmailMatches(payload: JWTPayload, adminEmail: string): boolean {
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  return Boolean(email && email === adminEmail.trim().toLowerCase());
}

export async function authenticateAccess(request: Request, env: Env): Promise<{ email: string }> {
  const origin = accessOrigin(env.ACCESS_TEAM_DOMAIN ?? "");
  const audience = env.ACCESS_AUD?.trim();
  const adminEmail = env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!origin || !audience || !adminEmail) {
    throw new AccessError("ACCESS_NOT_CONFIGURED", 503);
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion")?.trim();
  if (!token) throw new AccessError("ACCESS_DENIED", 401);

  try {
    let jwks = jwksByOrigin.get(origin);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${origin}/cdn-cgi/access/certs`));
      jwksByOrigin.set(origin, jwks);
    }
    const { payload } = await jwtVerify(token, jwks, {
      audience,
      issuer: origin,
    });
    if (!accessEmailMatches(payload, adminEmail)) throw new Error("admin mismatch");
    return { email: adminEmail };
  } catch {
    throw new AccessError("ACCESS_DENIED", 401);
  }
}
