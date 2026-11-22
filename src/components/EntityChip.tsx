import { useEffect, useState } from "react";
import { entityOf, type Entity } from "../lib/entities";
import { go } from "../lib/navigation";

// Spec: CHAT-7
/** An id in an assistant message, shown as its title; opens what it names. */
export function EntityChip(props: { id: string }) {
  const [entity, setEntity] = useState<Entity | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void entityOf(props.id).then((e) => {
      if (live) setEntity(e);
    });
    return () => {
      live = false;
    };
  }, [props.id]);
  if (entity === undefined) return <span className="entity-chip pending">…</span>;
  if (entity === null) return <code className="entity-chip missing" title="Not in the book or library (any more)">{props.id}</code>;
  return (
    <a
      href={entity.path}
      className={`entity-chip kind-${entity.kind.replace(" ", "-")}`}
      title={`${entity.kind}: ${entity.title}`}
      onClick={(e) => {
        e.preventDefault();
        go(entity.path);
      }}
    >
      {entity.title}
    </a>
  );
}
