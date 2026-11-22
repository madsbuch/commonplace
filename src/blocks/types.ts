// A block type is defined once here, in its own module, and the registry
// (./index.ts) picks it up: how it is stored (the database's type name, props
// and content) and how the editor shows it. Every type shares the `blocks`
// table's columns, so adding one changes neither storage nor sync.
// Spec: BLK-1, BLK-2

/** A block as stored: the database's type name, props and content. */
export interface Stored {
  type: string;
  props: Record<string, unknown>;
  content: unknown;
}

/** A block as the editor holds it, apart from its id and children. */
export interface InEditor {
  type: string;
  props: Record<string, unknown>;
  content: unknown;
}

export interface BlockType {
  /** The type name in the database. Never changes once rows exist. */
  stored: string;
  /** The editor's block types this one is shown as. */
  editorTypes: readonly string[];
  toEditor(block: Stored): InEditor;
  fromEditor(block: InEditor): Stored;
}

/** A props object without the given keys. */
export function without(props: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(props).filter(([k]) => !keys.includes(k)));
}
