import { createReactBlockSpec } from "@blocknote/react";
import { canonical, parseContent, parseProps } from "../lib/bookModel";
import type { Stored } from "./types";

// Spec: BLK-3
/**
 * A block of a type this version of the app doesn't know (made by a newer
 * one, arriving through sync). It is shown as a placeholder and kept exactly
 * as stored: what it holds rides along in its props and is written back
 * unchanged, so the newer device's block survives the round trip.
 */
export const unknownBlockSpec = createReactBlockSpec(
  {
    type: "unknown",
    propSchema: {
      storedType: { default: "" },
      storedProps: { default: "{}" },
      storedContent: { default: "[]" },
    },
    content: "none",
  },
  {
    render: ({ block }) => (
      <div className="unknown-block" contentEditable={false}>
        A “{block.props.storedType}” block. It needs a newer version of My Book to show.
      </div>
    ),
  },
);

export function toUnknown(b: Stored) {
  return {
    type: "unknown",
    props: { storedType: b.type, storedProps: canonical(b.props), storedContent: canonical(b.content) },
    content: undefined,
  };
}

export function fromUnknown(props: Record<string, unknown>): Stored {
  const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
  return {
    type: str(props["storedType"], "unknown"),
    props: parseProps(str(props["storedProps"], "{}")),
    content: parseContent(str(props["storedContent"], "[]")),
  };
}
