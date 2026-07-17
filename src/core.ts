const EMAIL_RE = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MESSAGE_ID_RE = /<[^<>\s]{1,500}>/gu;

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().toLowerCase();
  return cleaned.length <= 320 && EMAIL_RE.test(cleaned) ? cleaned : null;
}

export function validClientRequestId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function cleanSingleLine(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n\0]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

export function cleanBody(value: unknown, maxLength = 50_000): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n?/gu, "\n").replace(/\0/gu, "").trim().slice(0, maxLength);
}

export function normalizeReplySubject(subject: string): string {
  const cleaned = cleanSingleLine(subject, 998) || "(无主题)";
  return /^re\s*:/iu.test(cleaned) ? cleaned : `Re: ${cleaned}`.slice(0, 998);
}

export function normalizeMessageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > 502 || /[\r\n]/u.test(cleaned)) return null;
  const wrapped = cleaned.startsWith("<") && cleaned.endsWith(">") ? cleaned : `<${cleaned}>`;
  return /^<[^<>\s]+@[^<>\s]+>$/u.test(wrapped) ? wrapped : null;
}

export function extractMessageIds(...headers: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const header of headers) {
    for (const match of header?.match(MESSAGE_ID_RE) ?? []) {
      const id = normalizeMessageId(match);
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids.slice(-100);
}

export function buildReplyHeaders(latestMessageId: string | null, existingReferences: string[]): Record<string, string> {
  const latest = normalizeMessageId(latestMessageId);
  if (!latest) return {};

  const ids = extractMessageIds(...existingReferences, latest);
  while (ids.length > 100 || new TextEncoder().encode(ids.join(" ")).byteLength > 1_900) ids.shift();
  return {
    "In-Reply-To": latest,
    References: ids.join(" "),
  };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return named[entity.toLowerCase()] ?? whole;
  });
}

export function htmlToPlainText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/giu, "")
      .replace(/<br\s*\/?>/giu, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/giu, "\n")
      .replace(/<li[^>]*>/giu, "• ")
      .replace(/<[^>]+>/gu, ""),
  )
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return { value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, middle)).byteLength <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return { value: value.slice(0, low), truncated: true };
}

export async function sha256Hex(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function safeJsonArray<T>(value: unknown): T[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

export function encodeCursor(timestamp: number, id: string): string {
  return btoa(`${timestamp}:${id}`).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeCursor(value: string | undefined): { timestamp: number; id: string } | null {
  if (!value) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    const separator = decoded.indexOf(":");
    const timestamp = Number(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    return separator > 0 && Number.isSafeInteger(timestamp) && id.length > 0 ? { timestamp, id } : null;
  } catch {
    return null;
  }
}
