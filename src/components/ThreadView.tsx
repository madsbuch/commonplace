// ---------------------------------------------------------------------------
// A discussion thread in the library (LIB-31 to LIB-35): its story, then its
// comments nested under what they answer, as kept on this device. Opened
// while online it looks for new, edited and deleted comments (LIB-33);
// what arrived since it was last opened here is marked new. Deleted and
// removed comments stay, marked (LIB-34); edited ones keep their earlier
// texts, a tap away (LIB-35). Where it's scrolled to, the comment at the top,
// is the address's fragment (`#c<id>`, APP-10).
// ---------------------------------------------------------------------------

import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { replaceFragment } from "../lib/address";
import { messageOf, note } from "../lib/diagnostics";
import { removeItem, type LibraryItem } from "../lib/library";
import { useTablesVersion } from "../lib/live";
import { readThread, refreshThread, THREAD_TABLES } from "../lib/threads";
import { ago, earlierTexts, foundLine, isNew, parseHnId, threadTree, type SeenText, type StoredComment, type StoredThread, type ThreadNode } from "../lib/threadModel";
import { hostOf } from "../lib/webModel";
import { LinkedFrom } from "./LinkedFrom";
import { InfoButton } from "./InfoButton";
import { MoreMenu } from "./MoreMenu";

/** A thread checked this recently isn't fetched again on opening it. */
const FRESH_MS = 2 * 60 * 1000;
const openedKey = (id: string) => `thread-opened:${id}`;

const cleanCache = new Map<string, string>();
/** A comment's HTML as the site gives it, made safe: paragraphs, emphasis, code, links. */
function clean(html: string): string {
  const hit = cleanCache.get(html);
  if (hit !== undefined) return hit;
  const safe = DOMPurify.sanitize(html, { ALLOWED_TAGS: ["p", "a", "i", "em", "b", "strong", "pre", "code", "br"], ALLOWED_ATTR: ["href"] });
  if (cleanCache.size > 5000) cleanCache.clear();
  cleanCache.set(html, safe);
  return safe;
}

/** How a gone comment is marked. */
const GONE_WORDS = { deleted: "deleted on Hacker News", dead: "removed on Hacker News", missing: "no longer on Hacker News" } as const;

interface Shared {
  lastOpened: string | null;
  now: number;
  texts: ReadonlyMap<string, SeenText[]>;
  folded: ReadonlySet<string>;
  onFold: (sourceId: string) => void;
}

// Spec: LIB-34, LIB-35
/** A comment's (or the story's) text, with what's known of its history. */
function Body(props: { comment: StoredComment; texts: readonly SeenText[] }) {
  const { comment } = props;
  const earlier = useMemo(() => earlierTexts(comment, props.texts), [comment, props.texts]);
  const [showEarlier, setShowEarlier] = useState(false);
  return (
    <>
      {comment.text !== null ? (
        <div className="thread-text" dangerouslySetInnerHTML={{ __html: clean(comment.text) }} />
      ) : comment.gone !== null ? (
        <p className="thread-text muted">Deleted before it was kept.</p>
      ) : null}
      {earlier.length > 0 ? (
        <div className="thread-earlier">
          <button type="button" className="thread-badge edited" aria-expanded={showEarlier} onClick={() => setShowEarlier((s) => !s)}>
            Edited · {earlier.length === 1 ? "1 earlier text" : `${earlier.length} earlier texts`}
          </button>
          {showEarlier ? (
            <ol className="thread-versions">
              {earlier.map((t) => (
                <li key={t.seenAt + t.text.length}>
                  <span className="muted thread-version-when">Seen {new Date(t.seenAt).toLocaleString()}</span>
                  <div className="thread-text" dangerouslySetInnerHTML={{ __html: clean(t.text) }} />
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

// Spec: LIB-32, LIB-33, LIB-34
/** One comment and what answers it; folded, only its line shows. */
const Comment = memo(function Comment(props: { node: ThreadNode; depth: number; shared: Shared }) {
  const { node, depth, shared } = props;
  const c = node.comment;
  const folded = shared.folded.has(c.sourceId);
  const fresh = isNew(c, shared.lastOpened);
  const classes = ["thread-comment", fresh ? "new" : "", c.gone ? "gone" : "", folded ? "folded" : ""].filter(Boolean).join(" ");
  return (
    <li id={`c${c.sourceId}`} className={classes} data-depth={Math.min(depth, 8)}>
      <div className="thread-comment-head">
        <button
          type="button"
          className="thread-fold"
          aria-expanded={!folded}
          aria-label={folded ? `Unfold ${c.author ?? "this comment"}'s comment` : `Fold ${c.author ?? "this comment"}'s comment`}
          onClick={() => shared.onFold(c.sourceId)}
        >
          {folded ? "▸" : "▾"}
        </button>
        <span className="thread-author">{c.author ?? "[deleted]"}</span>
        {c.postedAt ? <time dateTime={c.postedAt}>{ago(c.postedAt, shared.now)}</time> : null}
        {fresh ? <span className="thread-badge new">new</span> : null}
        {c.gone ? <span className="thread-badge gone">{GONE_WORDS[c.gone]}</span> : null}
        {folded && node.under > 0 ? <span className="muted thread-hidden">{node.under === 1 ? "1 reply" : `${node.under} replies`}</span> : null}
      </div>
      {folded ? null : (
        <>
          <Body comment={c} texts={shared.texts.get(c.id) ?? []} />
          {node.replies.length > 0 ? (
            <ol className="thread-comments">
              {node.replies.map((r) => (
                <Comment key={r.comment.id} node={r} depth={depth + 1} shared={shared} />
              ))}
            </ol>
          ) : null}
        </>
      )}
    </li>
  );
});

type Check = { state: "idle" } | { state: "checking" } | { state: "done"; line: string } | { state: "failed"; problem: string };

// Spec: LIB-31, LIB-32, LIB-33, LIB-34, LIB-35, APP-10
export function ThreadScreen(props: { item: LibraryItem }) {
  const { item } = props;
  const navigate = useNavigate();
  const location = useLocation();
  const version = useTablesVersion(THREAD_TABLES);
  const [data, setData] = useState<{ thread: StoredThread | null; comments: StoredComment[]; texts: SeenText[] } | null>(null);
  useEffect(() => {
    let live = true;
    void readThread(item.id).then((d) => {
      if (live) setData(d);
    });
    return () => {
      live = false;
    };
  }, [item.id, version]);

  // Spec: LIB-33
  // When it was last opened on this device: what arrived since is new. This opening counts from now.
  const [lastOpened] = useState<string | null>(() => {
    try {
      return localStorage.getItem(openedKey(item.id));
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(openedKey(item.id), new Date().toISOString());
    } catch {
      // A convenience only.
    }
  }, [item.id]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  // Spec: LIB-33
  // Looks for new comments: on opening, unless just checked or offline, and when asked.
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const lookAgain = useCallback(() => {
    setCheck({ state: "checking" });
    refreshThread(item.id)
      .then((plan) => {
        setCheck({ state: "done", line: foundLine(plan) });
        setNow(Date.now());
      })
      .catch((e: unknown) => {
        note("warning", "library", `Looking for new comments on “${item.title}” failed: ${messageOf(e)}`);
        setCheck({ state: "failed", problem: messageOf(e) });
      });
  }, [item.id, item.title]);
  const autoChecked = useRef(false);
  const checkedAt = data?.thread?.checkedAt ?? null;
  useEffect(() => {
    if (autoChecked.current || data === null) return;
    autoChecked.current = true;
    if (data.thread === null || navigator.onLine === false) return;
    if (checkedAt && Date.now() - Date.parse(checkedAt) < FRESH_MS) return;
    lookAgain();
  }, [data, checkedAt, lookAgain]);

  const tree = useMemo(() => (data?.thread ? threadTree(data.comments, data.thread.storyId) : null), [data]);
  const texts = useMemo(() => {
    const m = new Map<string, SeenText[]>();
    for (const t of data?.texts ?? []) m.set(t.commentId, [...(m.get(t.commentId) ?? []), t]);
    return m;
  }, [data]);
  const newCount = useMemo(() => (lastOpened ? (data?.comments ?? []).filter((c) => c.sourceId !== data?.thread?.storyId && isNew(c, lastOpened)).length : 0), [data, lastOpened]);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const onFold = useCallback((id: string) => {
    setFolded((f) => {
      const next = new Set(f);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const shared = useMemo<Shared>(() => ({ lastOpened, now, texts, folded, onFold }), [lastOpened, now, texts, folded, onFold]);

  // Spec: APP-10
  // The comment at the top of the view is the fragment; opening (or a later navigation) with one goes there.
  const scroller = useRef<HTMLDivElement>(null);
  const goTo = (hash: string) => {
    const id = /^#c(\d+)$/.exec(hash)?.[1];
    if (!id) return false;
    const el = scroller.current?.querySelector(`#c${id}`);
    if (!el) return false;
    el.scrollIntoView({ block: "start" });
    return true;
  };
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (opened.current || !tree) return;
    opened.current = true;
    goTo(location.hash);
    // Opening counts once: later moves come by navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree]);
  const firstKey = useRef(location.key);
  useEffect(() => {
    if (location.key !== firstKey.current) goTo(location.hash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);
  const frame = useRef(0);
  const atTop = useRef<string | null>(null);
  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const s = scroller.current;
      if (!s) return;
      const line = s.getBoundingClientRect().top + 8;
      // In document order a comment starts below the one before it: the last that starts above the line is the one at the top.
      const all = s.querySelectorAll<HTMLElement>("li.thread-comment");
      let lo = 0;
      let hi = all.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const el = all[mid];
        if (el && el.getBoundingClientRect().top <= line) {
          found = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      const at = found >= 0 && s.scrollTop > 20 ? (all[found]?.id ?? null) : null;
      if (at === atTop.current) return;
      atTop.current = at;
      replaceFragment(at ?? "");
    });
  };

  // Links within the thread move within it; others open in the system browser.
  const onClick = (e: React.MouseEvent) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    e.preventDefault();
    const id = parseHnId(href);
    if (id !== null && goTo(`#c${id}`)) return;
    if (/^https?:\/\//.test(href)) void openUrl(href);
  };

  const thread = data?.thread ?? null;
  const story = tree?.story ?? null;
  const hnUrl = item.filename;

  return (
    <div className="library-item thread-screen">
      <div className="library-item-bar">
        <Link to="/library" aria-label="Library">
          ←<span className="back-word"> Library</span>
        </Link>
        <span className="library-item-title" title={item.title}>
          {item.title}
        </span>
        <div className="page-actions">
          {/* Spec: LIB-8, LIB-33, APP-12 */}
          <MoreMenu
            label="More for this thread"
            actions={[
              { label: "Look for new comments", onClick: lookAgain },
              { label: "Open on Hacker News", onClick: () => void openUrl(hnUrl) },
              ...(thread?.url ? [{ label: `Open ${hostOf(thread.url)}`, onClick: () => void (thread.url ? openUrl(thread.url) : undefined) }] : []),
              {
                label: "Remove from the library",
                confirm: "Really remove it?",
                danger: true,
                onClick: () => void removeItem(item.id).then(() => navigate("/library", { replace: true })),
              },
            ]}
          />
        </div>
      </div>
      <div className="thread-scroll" ref={scroller} onScroll={onScroll} onClick={onClick}>
        <article className="thread">
          <header className="thread-story">
            <h1>{item.title}</h1>
            <p className="muted thread-meta">
              {[
                thread?.score !== null && thread?.score !== undefined ? `${thread.score} points` : null,
                story?.author ? `by ${story.author}` : null,
                story?.postedAt ? ago(story.postedAt, now) : null,
                tree ? `${tree.count} comments` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              {thread?.url ? (
                <>
                  {" · "}
                  <a href={thread.url}>{hostOf(thread.url)}</a>
                </>
              ) : null}
            </p>
            {/* Spec: LIB-33 */}
            <p className="thread-status with-info" role="status">
              <span>
                {check.state === "checking" ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Looking for new comments…
                  </>
                ) : check.state === "failed" ? (
                  `Couldn't reach Hacker News${checkedAt ? `; as of ${ago(checkedAt, now)}` : ""}.`
                ) : (
                  [checkedAt ? `Checked ${ago(checkedAt, now)}` : null, check.state === "done" ? check.line : null, newCount > 0 ? `${newCount} new since you last opened it` : null]
                    .filter(Boolean)
                    .join(" · ")
                )}
              </span>
              {check.state !== "checking" ? (
                <button type="button" className="ai-link" onClick={lookAgain}>
                  {check.state === "failed" ? "Try again" : "Check now"}
                </button>
              ) : null}
              <InfoButton title="Keeping a thread" tone={check.state === "failed" ? "warning" : undefined}>
                <p>The whole thread is kept on this device and syncs to your others, so it reads offline.</p>
                <p>Each time it opens while online (or when you press Check now), it looks on Hacker News for new comments, edits and deletions. Comments that arrived since you last opened it here are marked new.</p>
                <p>A comment deleted or removed on Hacker News stays here as it was, marked. An edited one shows its latest text, and every earlier text seen is kept under Edited.</p>
                {check.state === "failed" ? <p>The last try failed: {check.problem}</p> : null}
              </InfoButton>
            </p>
            <LinkedFrom itemId={item.id} />
            {story ? <Body comment={story} texts={texts.get(story.id) ?? []} /> : null}
          </header>
          {data !== null && thread === null ? <p className="muted">This thread hasn't fully reached this device yet. It arrives with the next sync.</p> : null}
          {tree ? (
            <ol className="thread-comments thread-top">
              {tree.replies.map((n) => (
                <Comment key={n.comment.id} node={n} depth={0} shared={shared} />
              ))}
            </ol>
          ) : null}
        </article>
      </div>
    </div>
  );
}
