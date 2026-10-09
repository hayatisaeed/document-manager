import { useCallback, useEffect, useMemo, useState } from "react";
import { api, qs } from "../api";
import FilePicker from "../components/FilePicker";
import { toastError } from "../components/Toast";
import { t } from "../i18n";
import { fmtNum, relativeTime } from "../prefs";
import type { CommentAnchor, CommentThread, FileLink, FileLinks } from "../types";
import { formatDate } from "../util";
import { useWorkspace } from "./context";

export type SideTab = "comments" | "links";

/** Which side panel is open (remembered between documents). */
export function useSideTab(): [SideTab | null, (tab: SideTab | null) => void] {
  const [tab, setTabState] = useState<SideTab | null>(() => {
    try {
      const v = localStorage.getItem("dm:side");
      return v === "comments" || v === "links" ? v : null;
    } catch {
      return null;
    }
  });
  const setTab = useCallback((v: SideTab | null) => {
    setTabState(v);
    try {
      localStorage.setItem("dm:side", v ?? "");
    } catch {
      /* storage unavailable */
    }
  }, []);
  return [tab, setTab];
}

/** Comment threads of one file, with the operations on them. */
export function useComments(path: string, enabled = true) {
  const { p, refreshStatus } = useWorkspace();
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const url = p("comments/");

  const reload = useCallback(async () => {
    if (!enabled) return;
    setThreads(await api.get<CommentThread[]>(url + qs({ path })));
  }, [url, path, enabled]);

  useEffect(() => {
    reload().catch(() => setThreads([]));
  }, [reload]);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        await reload();
        refreshStatus().catch(() => {});
        return true;
      } catch (e) {
        toastError(e);
        return false;
      }
    },
    [reload, refreshStatus],
  );

  return {
    threads,
    reload,
    add: (anchor: CommentAnchor, text: string) =>
      run(() => api.post<CommentThread>(url, { path, anchor, text })),
    reply: (id: string, text: string) => run(() => api.post(`${url}${id}/`, { path, text })),
    resolve: (id: string, resolved: boolean) => run(() => api.patch(`${url}${id}/`, { path, resolved })),
    reanchor: (id: string, anchor: CommentAnchor) => run(() => api.patch(`${url}${id}/`, { path, anchor })),
    edit: (id: string, commentId: string, text: string) =>
      run(() => api.patch(`${url}${id}/`, { path, comment_id: commentId, text })),
    remove: (id: string, commentId?: string) =>
      run(() => api.del(`${url}${id}/` + qs({ path, comment_id: commentId }))),
  };
}

export type Comments = ReturnType<typeof useComments>;

/** Buttons that open the side panels, for the document header. */
export function SideToggles({
  tab,
  setTab,
  openComments,
  withComments = true,
}: {
  tab: SideTab | null;
  setTab: (t: SideTab | null) => void;
  openComments?: number;
  withComments?: boolean;
}) {
  return (
    <>
      {withComments && (
        <button className={`btn btn-sm ${tab === "comments" ? "btn-active" : ""}`} onClick={() => setTab(tab === "comments" ? null : "comments")}>
          {t("Comments")} {!!openComments && <span className="count">{fmtNum(openComments)}</span>}
        </button>
      )}
      <button className={`btn btn-sm ${tab === "links" ? "btn-active" : ""}`} onClick={() => setTab(tab === "links" ? null : "links")}>
        {t("Links")}
      </button>
    </>
  );
}

export function DocSide({
  path,
  tab,
  setTab,
  comments,
  draft,
  onCancelDraft,
  active,
  setActive,
  located,
  describeAnchor,
}: {
  path: string;
  tab: SideTab;
  setTab: (t: SideTab | null) => void;
  comments?: Comments;
  /** A new thread waiting for its first comment (the user just selected text and pressed Comment). */
  draft?: CommentAnchor | null;
  onCancelDraft?: () => void;
  active?: string | null;
  setActive?: (id: string | null) => void;
  /** Threads whose anchor was found in the current text (others show as "text changed"). */
  located?: Set<string>;
  describeAnchor?: (a: CommentAnchor) => string;
}) {
  return (
    <aside className="doc-side">
      <div className="tabs" role="tablist">
        {comments && (
          <button role="tab" className={tab === "comments" ? "active" : ""} onClick={() => setTab("comments")}>
            {t("Comments")}
          </button>
        )}
        <button role="tab" className={tab === "links" ? "active" : ""} onClick={() => setTab("links")}>
          {t("Links")}
        </button>
        <button className="side-close" onClick={() => setTab(null)} title={t("Close")}>
          ×
        </button>
      </div>
      <div className="side-content">
        {tab === "comments" && comments ? (
          <CommentsPanel
            comments={comments}
            draft={draft ?? null}
            onCancelDraft={onCancelDraft}
            active={active ?? null}
            setActive={setActive ?? (() => {})}
            located={located}
            describeAnchor={describeAnchor}
          />
        ) : (
          <LinksPanel path={path} />
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- comments

function CommentsPanel({
  comments,
  draft,
  onCancelDraft,
  active,
  setActive,
  located,
  describeAnchor,
}: {
  comments: Comments;
  draft: CommentAnchor | null;
  onCancelDraft?: () => void;
  active: string | null;
  setActive: (id: string | null) => void;
  located?: Set<string>;
  describeAnchor?: (a: CommentAnchor) => string;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const [text, setText] = useState("");
  const open = comments.threads.filter((th) => !th.resolved);
  const resolved = comments.threads.filter((th) => th.resolved);
  const shown = showResolved ? comments.threads : open;
  const quote = (a: CommentAnchor) => describeAnchor?.(a) ?? (a.type === "text" ? a.quote : a.cell);

  useEffect(() => {
    if (!active) return;
    document.getElementById(`thread-${active}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  return (
    <div className="comments">
      {draft && (
        <form
          className="thread thread-draft"
          onSubmit={async (e) => {
            e.preventDefault();
            if (text.trim() && (await comments.add(draft, text))) {
              setText("");
              onCancelDraft?.();
            }
          }}
        >
          <blockquote className="thread-quote" dir="auto">
            {quote(draft)}
          </blockquote>
          <textarea
            autoFocus
            rows={3}
            dir="auto"
            value={text}
            placeholder={t("Write a comment…")}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) (e.currentTarget.form as HTMLFormElement).requestSubmit();
              if (e.key === "Escape") onCancelDraft?.();
            }}
          />
          <div className="row end">
            <button type="button" className="btn btn-sm" onClick={onCancelDraft}>
              {t("Cancel")}
            </button>
            <button className="btn btn-sm btn-primary" disabled={!text.trim()}>
              {t("Comment")}
            </button>
          </div>
        </form>
      )}
      {!draft && comments.threads.length === 0 && (
        <p className="muted pad small">{t("Select some text and press Comment (Ctrl+Alt+M) to start a discussion about it.")}</p>
      )}
      {shown.map((th) => (
        <Thread
          key={th.id}
          thread={th}
          comments={comments}
          active={active === th.id}
          lost={located !== undefined && !located.has(th.id) && th.anchor.type === "text"}
          quote={quote(th.anchor)}
          onSelect={() => setActive(active === th.id ? null : th.id)}
        />
      ))}
      {resolved.length > 0 && (
        <button className="link small pad" onClick={() => setShowResolved((s) => !s)}>
          {showResolved ? t("Hide resolved") : t("Show {n} resolved", { n: resolved.length })}
        </button>
      )}
    </div>
  );
}

function Thread({
  thread,
  comments,
  active,
  lost,
  quote,
  onSelect,
}: {
  thread: CommentThread;
  comments: Comments;
  active: boolean;
  lost: boolean;
  quote: string;
  onSelect: () => void;
}) {
  const [reply, setReply] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  return (
    <div id={`thread-${thread.id}`} className={`thread ${active ? "active" : ""} ${thread.resolved ? "resolved" : ""}`} onClick={onSelect}>
      <blockquote className="thread-quote" dir="auto" title={lost ? t("This text has changed or was removed.") : undefined}>
        {lost && <span className="badge">{t("text changed")}</span>} {quote}
      </blockquote>
      {thread.comments.map((c, i) => (
        <div key={c.id} className="comment">
          <div className="comment-head">
            <strong dir="auto">{c.author}</strong>
            <span className="muted small" title={formatDate(c.date)}>
              {relativeTime(c.date)}
              {c.edited && ` · ${t("edited")}`}
            </span>
            <span className="spacer" />
            <span className="comment-actions" onClick={(e) => e.stopPropagation()}>
              {i === 0 && (
                <button className="link small" onClick={() => comments.resolve(thread.id, !thread.resolved)}>
                  {thread.resolved ? t("Reopen") : t("Resolve")}
                </button>
              )}
              <button
                className="link small"
                onClick={() => {
                  setEditing(c.id);
                  setEditText(c.text);
                }}
              >
                {t("Edit")}
              </button>
              <button
                className="link small danger"
                onClick={() => confirm(i === 0 ? t("Delete this whole thread?") : t("Delete this reply?")) && comments.remove(thread.id, c.id)}
              >
                {t("Delete")}
              </button>
            </span>
          </div>
          {editing === c.id ? (
            <form
              onClick={(e) => e.stopPropagation()}
              onSubmit={async (e) => {
                e.preventDefault();
                if (await comments.edit(thread.id, c.id, editText)) setEditing(null);
              }}
            >
              <textarea rows={3} dir="auto" value={editText} onChange={(e) => setEditText(e.target.value)} autoFocus />
              <div className="row end">
                <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>
                  {t("Cancel")}
                </button>
                <button className="btn btn-sm btn-primary" disabled={!editText.trim()}>
                  {t("Save")}
                </button>
              </div>
            </form>
          ) : (
            <p className="comment-text" dir="auto">
              {c.text}
            </p>
          )}
        </div>
      ))}
      {active && !thread.resolved && (
        <form
          className="reply"
          onClick={(e) => e.stopPropagation()}
          onSubmit={async (e) => {
            e.preventDefault();
            if (reply.trim() && (await comments.reply(thread.id, reply))) setReply("");
          }}
        >
          <textarea
            rows={2}
            dir="auto"
            value={reply}
            placeholder={t("Reply…")}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && (e.currentTarget.form as HTMLFormElement).requestSubmit()}
          />
          <div className="row end">
            <button className="btn btn-sm btn-primary" disabled={!reply.trim()}>
              {t("Reply")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- links

function LinksPanel({ path }: { path: string }) {
  const { p, tree, manifest, openFile, refresh } = useWorkspace();
  const [links, setLinks] = useState<FileLinks | null>(null);
  const [picking, setPicking] = useState(false);
  const titles = useMemo(() => Object.fromEntries(Object.entries(manifest.files).map(([k, v]) => [k, v.title])), [manifest]);

  const load = useCallback(() => {
    api.get<FileLinks>(p("links/") + qs({ path })).then(setLinks).catch(toastError);
  }, [p, path]);
  // Reload when the manifest changes (links added elsewhere) or the file is saved (tree refresh).
  useEffect(load, [load, manifest, tree]);

  const change = async (target: string, add: boolean) => {
    try {
      const body = { from: path, to: target };
      setLinks(add ? await api.post<FileLinks>(p("links/"), body) : await api.del<FileLinks>(p("links/") + qs(body)));
      await refresh();
    } catch (e) {
      toastError(e);
    }
  };

  const row = (l: FileLink, outgoing: boolean) => (
    <li key={l.path}>
      <button className="tree-row" onClick={() => openFile(l.path)} title={l.path}>
        <span className="tree-name" dir="auto">
          {l.title || l.path}
          {l.title && <span className="muted small mono"> {l.path}</span>}
        </span>
        {l.kinds.map((k) => (
          <span key={k} className={`badge link-kind-${k}`} title={k === "manual" ? t("Added in the Links panel") : t("Written in the text")}>
            {k === "manual" ? t("manual") : t("in text")}
          </span>
        ))}
      </button>
      {outgoing && l.kinds.includes("manual") && (
        <button className="link danger small" title={t("Remove link")} onClick={() => change(l.path, false)}>
          ×
        </button>
      )}
    </li>
  );

  return (
    <div className="links-panel">
      <div className="side-head">
        <span>{t("Links from this file")}</span>
        <button className="btn btn-sm" onClick={() => setPicking(true)}>
          {t("+ Link")}
        </button>
      </div>
      <ul className="link-list">
        {links?.outgoing.map((l) => row(l, true))}
        {links && links.outgoing.length === 0 && <li className="muted small pad">{t("No links yet.")}</li>}
      </ul>
      <div className="side-head">
        <span>{t("Backlinks (files linking here)")}</span>
      </div>
      <ul className="link-list">
        {links?.incoming.map((l) => row(l, false))}
        {links && links.incoming.length === 0 && <li className="muted small pad">{t("Nothing links here yet.")}</li>}
      </ul>
      <p className="muted small pad">
        {t("Links written in documents (Markdown, rich text, LaTeX, links on drawing shapes) show up here automatically. Use + Link to connect any two files, such as a chapter and its data spreadsheet.")}
      </p>
      {picking && (
        <FilePicker
          title={t("Link to…")}
          tree={tree}
          titles={titles}
          exclude={[path, ...(links?.outgoing.filter((l) => l.kinds.includes("manual")).map((l) => l.path) ?? [])]}
          onClose={() => setPicking(false)}
          onPick={(target) => {
            setPicking(false);
            change(target, true);
          }}
        />
      )}
    </div>
  );
}
