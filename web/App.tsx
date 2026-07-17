import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DeliveryStatus,
  Mailbox,
  MailMessage,
  ThreadDetail,
  ThreadSummary,
} from "../shared/types.ts";
import { ApiError, hubApi, type MailboxInput } from "./api.ts";

type Screen = "mail" | "settings";
type LoadState = "loading" | "ready" | "error";

const EMPTY_MAILBOX: MailboxInput = {
  label: "",
  address: "",
  senderName: "",
  forwardTo: "",
};

const statusText: Record<DeliveryStatus, string> = {
  stored: "已存档",
  forwarded: "已转发",
  forward_failed: "转发失败",
  pending: "发送中",
  sent: "已发送",
  send_failed: "发送失败",
  send_unknown: "状态待确认",
};

function formatTime(value: string, compact = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat("zh-CN", sameDay && compact
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(date);
}

function senderLabel(thread: ThreadSummary): string {
  return thread.participantName || thread.participantEmail;
}

function StateView({ state, onRetry }: { state: LoadState; onRetry: () => void }) {
  if (state === "loading") return <div className="state-card"><span className="spinner" />正在载入邮件…</div>;
  return (
    <div className="state-card error-state">
      <span className="state-mark">!</span>
      <div><strong>暂时无法读取邮件</strong><p>请检查网络、Access 和 Worker 配置。</p></div>
      <button className="button secondary" onClick={onRetry}>重试</button>
    </div>
  );
}

export function App() {
  const [screen, setScreen] = useState<Screen>("mail");
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [mailboxId, setMailboxId] = useState<string>("");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [selected, setSelected] = useState<ThreadDetail>();
  const [state, setState] = useState<LoadState>("loading");
  const [threadLoading, setThreadLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const activeMailboxes = useMemo(() => mailboxes.filter((mailbox) => mailbox.status === "active"), [mailboxes]);

  const loadMailboxes = useCallback(async () => {
    const items = await hubApi.mailboxes();
    setMailboxes(items);
    return items;
  }, []);

  const loadThreads = useCallback(async (targetMailboxId: string) => {
    setState("loading");
    try {
      const page = await hubApi.threads(targetMailboxId || undefined);
      setThreads(page.items);
      setNextCursor(page.nextCursor);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  const boot = useCallback(async () => {
    setState("loading");
    try {
      await Promise.all([loadMailboxes(), loadThreads("")]);
    } catch {
      setState("error");
    }
  }, [loadMailboxes, loadThreads]);

  useEffect(() => { void boot(); }, [boot]);

  const chooseMailbox = (id: string) => {
    setMailboxId(id);
    setSelectedId(undefined);
    setSelected(undefined);
    void loadThreads(id);
  };

  const openThread = async (id: string) => {
    setSelectedId(id);
    setThreadLoading(true);
    try { setSelected(await hubApi.thread(id)); }
    finally { setThreadLoading(false); }
  };

  const reloadSelected = useCallback(async () => {
    if (selectedId) setSelected(await hubApi.thread(selectedId));
    const page = await hubApi.threads(mailboxId || undefined);
    setThreads(page.items);
    setNextCursor(page.nextCursor);
  }, [mailboxId, selectedId]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await hubApi.threads(mailboxId || undefined, nextCursor);
      setThreads((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } finally { setLoadingMore(false); }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setScreen("mail")} aria-label="返回邮件列表">
          <span className="brand-mark">M</span>
          <span><strong>Support Mail Hub</strong><small>多项目支持邮箱</small></span>
        </button>
        <div className="topbar-actions">
          <span className="secure-pill"><span />Cloudflare Access 已保护</span>
          <button className={`nav-button ${screen === "settings" ? "active" : ""}`} onClick={() => setScreen("settings")}>邮箱设置</button>
        </div>
      </header>

      {screen === "settings" ? (
        <Settings mailboxes={mailboxes} onChanged={loadMailboxes} onBack={() => setScreen("mail")} />
      ) : (
        <div className={`workspace ${selectedId ? "thread-open" : ""}`}>
          <aside className="mailbox-rail">
            <div className="rail-label">收件箱</div>
            <button className={!mailboxId ? "active" : ""} onClick={() => chooseMailbox("")}>
              <span className="mailbox-dot all" />全部邮箱<span className="rail-count">{threads.length}</span>
            </button>
            {activeMailboxes.map((mailbox) => (
              <button key={mailbox.id} className={mailboxId === mailbox.id ? "active" : ""} onClick={() => chooseMailbox(mailbox.id)}>
                <span className="mailbox-dot" />
                <span className="rail-mailbox"><strong>{mailbox.label}</strong><small>{mailbox.address}</small></span>
              </button>
            ))}
            {!activeMailboxes.length && <p className="rail-empty">请先添加一个支持邮箱。</p>}
          </aside>

          <section className="thread-list-panel">
            <div className="panel-heading">
              <div><span className="eyebrow">CONVERSATIONS</span><h1>{mailboxId ? mailboxes.find((item) => item.id === mailboxId)?.label : "全部会话"}</h1></div>
              <button className="icon-button" title="刷新" onClick={() => void loadThreads(mailboxId)} aria-label="刷新会话">↻</button>
            </div>
            {state !== "ready" ? <StateView state={state} onRetry={() => void boot()} /> : (
              <div className="thread-list">
                {!threads.length && (
                  <div className="empty-state"><span>✦</span><strong>还没有支持邮件</strong><p>配置 Email Routing 后，新来信会出现在这里并完整转发到个人邮箱。</p></div>
                )}
                {threads.map((thread) => (
                  <button key={thread.id} className={`thread-row ${selectedId === thread.id ? "active" : ""}`} onClick={() => void openThread(thread.id)}>
                    <span className="avatar">{senderLabel(thread).slice(0, 1).toUpperCase()}</span>
                    <span className="thread-copy">
                      <span className="thread-line"><strong>{senderLabel(thread)}</strong><time>{formatTime(thread.lastMessageAt, true)}</time></span>
                      <span className="subject">{thread.subject}</span>
                      <span className="preview">{thread.preview || "（无文本正文）"}</span>
                      <span className="thread-meta"><em>{thread.mailboxLabel}</em>{thread.latestStatus.includes("failed") && <b>需要处理</b>}</span>
                    </span>
                  </button>
                ))}
                {nextCursor && <button className="load-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "载入中…" : "载入更多"}</button>}
              </div>
            )}
          </section>

          <main className="conversation-panel">
            {threadLoading ? <div className="conversation-placeholder"><span className="spinner" />载入会话…</div>
              : selected ? <Conversation thread={selected} onBack={() => { setSelectedId(undefined); setSelected(undefined); }} onSent={reloadSelected} />
              : <div className="conversation-placeholder"><span className="placeholder-mark">↗</span><h2>选择一段会话</h2><p>查看最近 90 天的文本记录，并从正确的支持地址回复。</p></div>}
          </main>
        </div>
      )}
    </div>
  );
}

function DeliveryBadge({ message }: { message: MailMessage }) {
  const failed = message.deliveryStatus.includes("failed") || message.deliveryStatus === "send_unknown";
  return <span className={`delivery ${failed ? "failed" : ""}`}>{statusText[message.deliveryStatus]}{message.errorCode ? ` · ${message.errorCode}` : ""}</span>;
}

function Conversation({ thread, onBack, onSent }: { thread: ThreadDetail; onBack: () => void; onSent: () => Promise<void> }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    setError("");
    setNotice("");
    try {
      const result = await hubApi.reply(thread.id, crypto.randomUUID(), text);
      setText("");
      setNotice(result.message.deliveryStatus === "sent" ? "回复已发送" : "邮件已提交，但发送状态需要确认");
      await onSent();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "发送失败，请稍后重试");
      await onSent().catch(() => undefined);
    } finally { setSending(false); }
  };

  return (
    <div className="conversation">
      <header className="conversation-header">
        <button className="back-button" onClick={onBack}>←</button>
        <div><span className="mailbox-chip">{thread.mailboxAddress}</span><h2>{thread.subject}</h2><p>{thread.participantName ? `${thread.participantName} · ` : ""}{thread.participantEmail}</p></div>
      </header>
      <div className="message-stream">
        {thread.messages.map((message) => (
          <article key={message.id} className={`message ${message.direction}`}>
            <div className="message-card">
              <header><strong>{message.direction === "inbound" ? (message.fromName || message.fromAddress) : thread.mailboxLabel}</strong><time>{formatTime(message.createdAt)}</time></header>
              <p className="address-line">{message.direction === "inbound" ? `回复至 ${message.toAddress}` : `发送至 ${message.toAddress}`}</p>
              <div className="message-body">{message.bodyText || "（无文本正文，请在个人邮箱查看完整邮件）"}</div>
              {message.bodyTruncated && <p className="message-note">正文较长，Hub 仅保留前 100 KB。</p>}
              {!!message.attachments.length && (
                <div className="attachments">
                  {message.attachments.map((attachment, index) => <span key={`${attachment.name}-${index}`}>附件 · {attachment.name}</span>)}
                  <small>附件内容请在完整转发的个人邮箱中查看</small>
                </div>
              )}
              <DeliveryBadge message={message} />
            </div>
          </article>
        ))}
      </div>
      <form className="reply-box" onSubmit={submit}>
        <div className="reply-meta"><span>发件人 <strong>{thread.mailboxAddress}</strong></span><span>收件人 {thread.participantEmail}</span></div>
        <textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={50_000} rows={5} disabled={thread.mailboxStatus !== "active" || sending} placeholder={thread.mailboxStatus === "active" ? "输入纯文本回复…" : "该邮箱已归档，不能回复"} aria-label="回复正文" />
        {(error || notice) && <p className={error ? "form-message error" : "form-message success"}>{error || notice}</p>}
        <div className="reply-actions"><span>{text.length.toLocaleString()} / 50,000</span><button className="button primary" disabled={!text.trim() || sending || thread.mailboxStatus !== "active"}>{sending ? "发送中…" : "发送回复"}</button></div>
      </form>
    </div>
  );
}

function Settings({ mailboxes, onChanged, onBack }: { mailboxes: Mailbox[]; onChanged: () => Promise<Mailbox[]>; onBack: () => void }) {
  const [editing, setEditing] = useState<Mailbox>();
  const [form, setForm] = useState<MailboxInput>(EMPTY_MAILBOX);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);

  const beginCreate = () => {
    setEditing(undefined);
    setForm(EMPTY_MAILBOX);
    setError("");
    setShowForm(true);
  };

  const beginEdit = (mailbox: Mailbox) => {
    setEditing(mailbox);
    setForm({ address: mailbox.address, label: mailbox.label, senderName: mailbox.senderName, forwardTo: mailbox.forwardTo });
    setError("");
    setShowForm(true);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (editing) await hubApi.updateMailbox(editing.id, form);
      else await hubApi.createMailbox(form);
      await onChanged();
      setShowForm(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "保存失败");
    } finally { setSaving(false); }
  };

  const archive = async (mailbox: Mailbox) => {
    if (!window.confirm(`归档 ${mailbox.address}？请先确认 Cloudflare 中对应的路由规则已移除。`)) return;
    try { await hubApi.archiveMailbox(mailbox.id); await onChanged(); }
    catch (caught) { setError(caught instanceof ApiError ? caught.message : "归档失败"); }
  };

  return (
    <main className="settings-page">
      <div className="settings-heading">
        <div><button className="text-button" onClick={onBack}>← 返回收件箱</button><span className="eyebrow">MAILBOX SETTINGS</span><h1>支持邮箱</h1><p>这里保存 Hub 的邮箱映射；Cloudflare 域名与路由仍需在 Dashboard 中配置。</p></div>
        <button className="button primary" onClick={beginCreate}>添加邮箱</button>
      </div>

      <section className="setup-guide">
        <div className="guide-number">4</div>
        <div><strong>每个邮箱上线前检查</strong><p>域名已启用 Email Routing 和 Email Sending · 转发目标已验证 · 路由规则指向 support-mail-hub Worker · 已使用外部邮箱完成真实收发测试</p></div>
      </section>

      {error && !showForm && <p className="form-message error">{error}</p>}
      <section className="mailbox-grid">
        {!mailboxes.length && <div className="settings-empty"><strong>还没有邮箱映射</strong><p>先添加 TransCast 的支持邮箱，再配置测试路由。</p></div>}
        {mailboxes.map((mailbox) => (
          <article className={`mailbox-card ${mailbox.status}`} key={mailbox.id}>
            <header><span className="mailbox-card-mark">{mailbox.label.slice(0, 1).toUpperCase()}</span><span className={`status-pill ${mailbox.status}`}>{mailbox.status === "active" ? "使用中" : "已归档"}</span></header>
            <h2>{mailbox.label}</h2><p className="mailbox-address">{mailbox.address}</p>
            <dl><div><dt>发件显示名</dt><dd>{mailbox.senderName}</dd></div><div><dt>完整转发至</dt><dd>{mailbox.forwardTo}</dd></div></dl>
            <footer><button className="button secondary" onClick={() => beginEdit(mailbox)}>编辑</button>{mailbox.status === "active" && <button className="text-button danger" onClick={() => void archive(mailbox)}>归档</button>}</footer>
          </article>
        ))}
      </section>

      {showForm && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setShowForm(false); }}>
          <form className="modal" onSubmit={save}>
            <div className="modal-heading"><div><span className="eyebrow">{editing ? "EDIT MAILBOX" : "NEW MAILBOX"}</span><h2>{editing ? "编辑支持邮箱" : "添加支持邮箱"}</h2></div><button type="button" className="icon-button" onClick={() => setShowForm(false)} aria-label="关闭">×</button></div>
            <label>项目名称<input required maxLength={80} value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} placeholder="TransCast" /></label>
            <label>支持邮箱地址<input required type="email" value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} placeholder="support@example.com" /></label>
            <label>发件显示名<input required maxLength={100} value={form.senderName} onChange={(event) => setForm({ ...form, senderName: event.target.value })} placeholder="Example Support" /></label>
            <label>完整原件转发至<input required type="email" value={form.forwardTo} onChange={(event) => setForm({ ...form, forwardTo: event.target.value })} placeholder="your-private-inbox@example.com" /><small>该地址必须先在 Cloudflare Email Routing 中验证。</small></label>
            {error && <p className="form-message error">{error}</p>}
            <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setShowForm(false)}>取消</button><button className="button primary" disabled={saving}>{saving ? "保存中…" : "保存邮箱"}</button></div>
          </form>
        </div>
      )}
    </main>
  );
}
