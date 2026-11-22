import { useEffect, useState } from "react";
import { NamePicker } from "./NamePicker";

/** An editable name, and "the same as…" to merge this record into another. */
export function EntityHeader(props: {
  name: string;
  kindLabel: string;
  others: readonly { id: string; name: string }[];
  onRename: (name: string) => void;
  onMerge: (intoId: string) => void;
}) {
  const [name, setName] = useState(props.name);
  const [merging, setMerging] = useState(false);
  useEffect(() => setName(props.name), [props.name]);
  return (
    <div className="entity-head">
      <input
        className="entity-name"
        value={name}
        aria-label="Name"
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          if (name.trim() && name !== props.name) props.onRename(name);
          else setName(props.name);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      {merging ? (
        <div className="merge-box">
          <span className="muted">The same {props.kindLabel} as…</span>
          <NamePicker
            autoFocus
            options={props.others}
            placeholder={`Search ${props.kindLabel}s`}
            onCancel={() => setMerging(false)}
            onPick={(id) => {
              setMerging(false);
              props.onMerge(id);
            }}
            onNew={() => undefined}
          />
          <button type="button" onClick={() => setMerging(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setMerging(true)}>
          Same {props.kindLabel} as…
        </button>
      )}
    </div>
  );
}
