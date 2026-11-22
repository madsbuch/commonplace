// What the open page's editor offers the rest of the app: finishing a save
// before something reads the page (the assistant, a page switch), and moving
// one of its blocks out to another page (a block dropped on the sidebar).

interface OpenEditor {
  pageId: string;
  /** Resolves once everything typed so far is saved. */
  flush: () => Promise<void>;
  /** Moves a block (by the editor's id) out of this page into another. */
  moveBlockOut: (editorBlockId: string, targetPageId: string) => Promise<void>;
}

let open: OpenEditor | null = null;

/** The block being dragged by its handle, while it is. */
let dragged: { editorBlockId: string; pageId: string } | null = null;

export function registerEditor(e: OpenEditor): () => void {
  open = e;
  return () => {
    if (open === e) open = null;
  };
}

export async function flushOpenEditor(): Promise<void> {
  await open?.flush();
}

export function setDraggedBlock(d: { editorBlockId: string; pageId: string } | null): void {
  dragged = d;
}

export function draggedBlock(): { editorBlockId: string; pageId: string } | null {
  return dragged;
}

// Spec: BLK-4
/** Moves the dragged block into `targetPageId`, if a block is being dragged from another page. */
export async function dropDraggedBlockOn(targetPageId: string): Promise<boolean> {
  const d = dragged;
  dragged = null;
  if (!d || !open || open.pageId !== d.pageId || d.pageId === targetPageId) return false;
  await open.moveBlockOut(d.editorBlockId, targetPageId);
  return true;
}
