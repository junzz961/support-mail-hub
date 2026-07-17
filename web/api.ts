import type {
  ApiResponse,
  Mailbox,
  ReplyResult,
  ThreadDetail,
  ThreadPage,
} from "../shared/types.ts";

export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = await response.json().catch(() => null) as ApiResponse<T> | null;
  if (!response.ok || !payload?.ok) {
    const error = payload && !payload.ok ? payload.error : null;
    throw new ApiError(error?.code ?? "REQUEST_FAILED", response.status, error?.message ?? "请求失败");
  }
  return payload.data;
}

export interface MailboxInput {
  address: string;
  label: string;
  senderName: string;
  forwardTo: string;
}

export interface ReplyImageInput {
  filename: string;
  type: string;
  content: string;
}

export const hubApi = {
  mailboxes: () => request<Mailbox[]>("/api/mailboxes"),
  createMailbox: (input: MailboxInput) => request<Mailbox>("/api/mailboxes", {
    method: "POST",
    body: JSON.stringify(input),
  }),
  updateMailbox: (id: string, input: MailboxInput) => request<Mailbox>(`/api/mailboxes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  }),
  archiveMailbox: (id: string) => request<Mailbox>(`/api/mailboxes/${encodeURIComponent(id)}/archive`, {
    method: "POST",
    body: "{}",
  }),
  threads: (mailboxId?: string, cursor?: string) => {
    const query = new URLSearchParams({ limit: "30" });
    if (mailboxId) query.set("mailboxId", mailboxId);
    if (cursor) query.set("cursor", cursor);
    return request<ThreadPage>(`/api/threads?${query}`);
  },
  thread: (id: string) => request<ThreadDetail>(`/api/threads/${encodeURIComponent(id)}`),
  reply: (id: string, clientRequestId: string, subject: string, text: string, images: ReplyImageInput[]) => request<ReplyResult>(
    `/api/threads/${encodeURIComponent(id)}/replies`,
    { method: "POST", body: JSON.stringify({ clientRequestId, subject, text, images }) },
  ),
};
