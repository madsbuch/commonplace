import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { filterSuggestionItems } from "@blocknote/core";
import { SideMenuExtension } from "@blocknote/core/extensions";
import {
  DragHandleMenu,
  RemoveBlockItem,
  SideMenu,
  SideMenuController,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  useBlockNoteEditor,
  useComponentsContext,
  useCreateBlockNote,
  useExtensionState,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { useLocation } from "react-router-dom";
import { fromEditorBlocks, schema, syntaxHighlighter, toEditorBlocks } from "../blocks";
import { dbId, editorId } from "../blocks/ids";
import { applySave, loadPage, moveBlockToPage, searchLinkTargets, type LoadedPage } from "../lib/book";
import { planSave, type DocBlock, type Snapshot } from "../lib/bookModel";
import { replaceFragment } from "../lib/address";
import { registerEditor, setDraggedBlock } from "../lib/editorBridge";
import { setCursorBlock } from "../lib/currentView";
import { useTablesVersion } from "../lib/live";
import { go, pagePath } from "../lib/navigation";
import { useColorScheme } from "../lib/theme";
import { PagePicker } from "./PagePicker";

/** How long typing pauses before it is saved. */
const SAVE_DELAY_MS = 600;

function sameSnapshot(a: ReadonlyMap<string, Snapshot>, b: ReadonlyMap<string, Snapshot>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, s] of a) {
    const o = b.get(id);
    if (!o || o.type !== s.type || o.parentId !== s.parentId || o.position !== s.position || o.props !== s.props || o.content !== s.content) {
      return false;
    }
  }
  return true;
}

/** A page with nothing typed yet: the editor's one empty paragraph. */
function isBlank(blocks: readonly DocBlock[]): boolean {
  const [only] = blocks;
  return blocks.length === 1 && only !== undefined && only.type === "paragraph" && only.children.length === 0 &&
    (!Array.isArray(only.content) || only.content.length === 0);
}

/** The "Move to page…" entry of a block's handle menu. */
function MoveToPageItem(props: { onPick: (editorBlockId: string) => void }) {
  const Components = useComponentsContext();
  const editor = useBlockNoteEditor(schema);
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  if (!Components || block === undefined) return null;
  return (
    <Components.Generic.Menu.Item className="bn-menu-item" onClick={() => props.onPick(block.id)}>
      Move to page…
    </Components.Generic.Menu.Item>
  );
}

// Spec: BOOK-7, BOOK-10, BLK-4
/**
 * A page's content in the block editor. Typing is saved a moment after it
 * pauses: only the blocks that changed are written, each with a revision.
 * Changes arriving from elsewhere (sync) are taken in when the editor isn't
 * being typed in, or as soon as it is left.
 */
export function PageEditor(props: { loaded: LoadedPage; editable?: boolean }) {
  const pageId = props.loaded.page.id;
  const scheme = useColorScheme();
  const snapshot = useRef<Map<string, Snapshot>>(props.loaded.snapshot);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stale = useRef<LoadedPage | null>(null);
  const [moving, setMoving] = useState<string | null>(null);

  const editor = useCreateBlockNote(
    {
      schema,
      extensions: [syntaxHighlighter],
      ...(props.loaded.blocks.length > 0 ? { initialContent: toEditorBlocks(props.loaded.blocks) } : {}),
    },
    [pageId],
  );

  const saveNow = useCallback(async () => {
    const docs = fromEditorBlocks(editor.document);
    if (snapshot.current.size === 0 && isBlank(docs)) return;
    const plan = planSave(pageId, snapshot.current, docs);
    if (plan.writes.length === 0 && plan.removed.length === 0) return;
    snapshot.current = await applySave(pageId, snapshot.current, plan);
  }, [editor, pageId]);

  const flush = useCallback((): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    chain.current = chain.current.then(saveNow).catch((e: unknown) => console.error("Saving the page failed", e));
    return chain.current;
  }, [saveNow]);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  }, [flush]);

  /** Shows the page as the database now has it. */
  const apply = useCallback(
    (fresh: LoadedPage) => {
      snapshot.current = fresh.snapshot;
      const blocks = toEditorBlocks(fresh.blocks);
      editor.replaceBlocks(editor.document, blocks.length > 0 ? blocks : [{ type: "paragraph" }]);
    },
    [editor],
  );

  // Save what's pending when leaving the page, and when the app goes to the background.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      void flush();
    };
  }, [flush]);

  // Spec: BLK-4
  /** Moves a block (and what's nested in it) out of this page into another. */
  const moveOut = useCallback(
    async (editorBlockId: string, targetPageId: string) => {
      await flush();
      // Out of the snapshot and the editor first: then neither a save nor a
      // reload set off by the move itself can bring it back or trip over it.
      const gone = new Set<string>();
      const collect = (id: string) => {
        gone.add(id);
        for (const [child, s] of snapshot.current) if (s.parentId === id) collect(child);
      };
      collect(dbId(editorBlockId));
      for (const id of gone) snapshot.current.delete(id);
      if (editor.getBlock(editorBlockId)) editor.removeBlocks([editorBlockId]);
      await moveBlockToPage(dbId(editorBlockId), targetPageId);
    },
    [editor, flush],
  );

  // Offer flushing and moving blocks out to the rest of the app.
  useEffect(() => registerEditor({ pageId, flush, moveBlockOut: moveOut }), [flush, moveOut, pageId]);

  // Take in changes from elsewhere.
  const version = useTablesVersion(["blocks"]);
  useEffect(() => {
    if (version === 0) return;
    let live = true;
    void (async () => {
      await chain.current;
      if (timer.current) return;
      const fresh = await loadPage(pageId);
      if (!live || !fresh || sameSnapshot(fresh.snapshot, snapshot.current)) return;
      if (editor.isFocused()) stale.current = fresh;
      else apply(fresh);
    })();
    return () => {
      live = false;
    };
  }, [version, pageId, editor, apply]);

  // Remember which block a drag started from, for a drop on the sidebar.
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const hovered = useRef<string | null>(null);
  hovered.current = block?.id ?? null;
  useEffect(() => {
    const onDragStart = (e: DragEvent) => {
      if (e.target instanceof Element && e.target.closest(".bn-side-menu") && hovered.current) {
        setDraggedBlock({ editorBlockId: hovered.current, pageId });
      }
    };
    const onDragEnd = () => setTimeout(() => setDraggedBlock(null), 0);
    document.addEventListener("dragstart", onDragStart, true);
    document.addEventListener("dragend", onDragEnd, true);
    return () => {
      document.removeEventListener("dragstart", onDragStart, true);
      document.removeEventListener("dragend", onDragEnd, true);
    };
  }, [pageId]);

  // Spec: PAGE-6, LNK-2
  // Scroll the block the address names (`#blk_…`) to the top, once it's
  // there, and again on each navigation (a link to another block of this
  // page, Back). Scrolling itself writes the address past the router.
  const location = useLocation();
  useEffect(() => {
    const target = decodeURIComponent(location.hash.slice(1));
    if (!target) return;
    const find = () => document.querySelector(`.bn-editor [data-id="${editorId(target)}"]`);
    const el = find();
    if (!(el instanceof HTMLElement)) return;
    // Found afresh each time: the editor may have redrawn the block meanwhile.
    const align = () => find()?.scrollIntoView({ block: "start" });
    align();
    el.classList.add("block-flash");
    const unflash = setTimeout(() => el.classList.remove("block-flash"), 1600);
    // What's above it may still be laying out (code, maths, page blocks):
    // keep it at the top for a moment, until the author scrolls themselves.
    const ro = new ResizeObserver(align);
    const root = document.querySelector(".main")?.firstElementChild;
    if (root) ro.observe(root);
    const stop = () => ro.disconnect();
    const settle = setTimeout(stop, 2000);
    const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    for (const e of events) window.addEventListener(e, stop, { once: true, passive: true });
    return () => {
      stop();
      clearTimeout(settle);
      clearTimeout(unflash);
      el.classList.remove("block-flash");
      for (const e of events) window.removeEventListener(e, stop);
    };
  }, [editor, location.key, location.hash]);

  // Spec: PAGE-6, APP-10
  // Where the page is scrolled to goes in the address: the innermost block at
  // the top of the view, or nothing at the page's top.
  useEffect(() => {
    const main = document.querySelector(".main");
    if (!(main instanceof HTMLElement)) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!window.location.pathname.startsWith(`/page/${pageId}`)) return;
        if (main.scrollTop < 40) {
          replaceFragment("");
          return;
        }
        const line = main.getBoundingClientRect().top + 8;
        let best: HTMLElement | null = null;
        for (const el of main.querySelectorAll<HTMLElement>(".bn-editor .bn-block-outer[data-id]")) {
          const b = el.getBoundingClientRect();
          if (b.bottom <= line) continue;
          // Blocks come in document order, a block before those nested in it:
          // the last one across the line is the innermost.
          if (b.top <= line) {
            best = el;
            continue;
          }
          best ??= el;
          break;
        }
        const id = best?.dataset["id"];
        if (id) replaceFragment(dbId(id));
      });
    };
    main.addEventListener("scroll", onScroll, { passive: true });
    // Content above can grow or shrink without a scroll (a save, a sync, code
    // being highlighted): the block at the top changes then too.
    const ro = new ResizeObserver(onScroll);
    if (main.firstElementChild) ro.observe(main.firstElementChild);
    return () => {
      main.removeEventListener("scroll", onScroll);
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [pageId]);

  const slashItems = useCallback(
    async (query: string): Promise<DefaultReactSuggestionItem[]> => {
      const items: DefaultReactSuggestionItem[] = [
        ...getDefaultReactSlashMenuItems(editor),
        {
          title: "Page",
          subtext: "A new page inside this one",
          aliases: ["page", "subpage"],
          group: "Book",
          onItemClick: () => {
            const at = editor.getTextCursorPosition().block;
            const [inserted] = editor.insertBlocks([{ type: "page", props: { title: "" } }], at, "after");
            if (!inserted) return;
            void flush().then(() => go(pagePath(dbId(inserted.id))));
          },
        },
        {
          title: "Inline maths",
          subtext: "LaTeX in the text (or type $…$)",
          aliases: ["math", "maths", "latex", "tex"],
          group: "Book",
          onItemClick: () => editor.insertInlineContent([{ type: "math", props: { latex: "" } }]),
        },
        {
          title: "Link to a page",
          subtext: "Or type @",
          aliases: ["link", "page link", "mention"],
          group: "Book",
          onItemClick: () => editor.insertInlineContent(["@"]),
        },
      ];
      return filterSuggestionItems(items, query);
    },
    [editor, flush],
  );

  // Spec: LNK-1, LNK-2
  const linkItems = useCallback(
    async (query: string): Promise<DefaultReactSuggestionItem[]> => {
      const targets = await searchLinkTargets(query);
      return targets
        .filter((t) => t.pageId !== pageId || t.blockId !== null)
        .map((t) => ({
          title: t.blockId ? (t.snippet ?? "") : t.title,
          subtext: t.blockId ? `in ${t.title}` : "Page",
          group: t.blockId ? "Blocks" : "Pages",
          onItemClick: () =>
            editor.insertInlineContent([{ type: "pageLink", props: { pageId: t.pageId, blockId: t.blockId ?? "" } }, " "]),
        }));
    },
    [editor, pageId],
  );

  const dragHandleMenu = useMemo(
    () =>
      function BookDragHandleMenu() {
        return (
          <DragHandleMenu>
            <RemoveBlockItem>Delete</RemoveBlockItem>
            <MoveToPageItem onPick={setMoving} />
          </DragHandleMenu>
        );
      },
    [],
  );

  return (
    <>
      <BlockNoteView
        editor={editor}
        editable={props.editable ?? true}
        theme={scheme}
        slashMenu={false}
        sideMenu={false}
        onChange={schedule}
        onSelectionChange={() => {
          // Spec: ATL-1
          try {
            setCursorBlock(dbId(editor.getTextCursorPosition().block.id));
          } catch {
            setCursorBlock(null);
          }
        }}
        onBlur={() => {
          const s = stale.current;
          stale.current = null;
          if (s) void flush().then(() => apply(s));
        }}
      >
        <SuggestionMenuController triggerCharacter="/" getItems={slashItems} />
        <SuggestionMenuController triggerCharacter="@" getItems={linkItems} />
        <SideMenuController sideMenu={(p) => <SideMenu {...p} dragHandleMenu={dragHandleMenu} />} />
      </BlockNoteView>
      {moving !== null ? (
        <PagePicker
          title="Move block to page"
          exclude={pageId}
          onClose={() => setMoving(null)}
          onPick={(target) => {
            const id = moving;
            setMoving(null);
            void moveOut(id, target);
          }}
        />
      ) : null}
    </>
  );
}
