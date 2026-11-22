import { useMemo, useState } from "react";
import { isTextModel, promptPricePerMillion } from "../lib/openrouter";
import type { ORModel } from "../lib/schemas";

/** "$3.00/M tokens", "free", or null when OpenRouter doesn't say. */
function priceLabel(m: ORModel): string | null {
  const p = promptPricePerMillion(m);
  if (p == null) return null;
  if (p === 0) return "free";
  return `$${p < 0.01 ? p.toFixed(3) : p.toFixed(2)}/M tokens in`;
}

/** The line under a model's name: its id, price and context. */
export function modelSub(m: ORModel): string {
  const parts: string[] = [m.id];
  const price = priceLabel(m);
  if (price) parts.push(price);
  if (m.context_length) parts.push(`${Math.round(m.context_length / 1000)}k context`);
  return parts.join(" · ");
}

/** How many rows to show at once; searching narrows the rest. */
const SHOWN = 80;

// Spec: AI-2
/** OpenRouter's models, searchable, with the chosen one marked. */
export function ModelPicker(props: { models: readonly ORModel[]; selected: string; onSelect: (id: string) => void }) {
  const { models, selected, onSelect } = props;
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return models
      .filter(isTextModel)
      .filter((m) => words.every((w) => m.id.toLowerCase().includes(w) || m.name.toLowerCase().includes(w)))
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.name.localeCompare(b.name));
  }, [models, query]);

  return (
    <div className="model-picker">
      <input
        type="search"
        className="ai-input"
        placeholder={`Search ${models.length} models…`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="model-list" role="listbox" aria-label="Models">
        {matches.slice(0, SHOWN).map((m) => (
          <button
            key={m.id}
            type="button"
            role="option"
            aria-selected={m.id === selected}
            className={m.id === selected ? "model-row selected" : "model-row"}
            onClick={() => onSelect(m.id)}
          >
            <span className="model-main">
              <span className="model-name">{m.name}</span>
              <span className="model-sub">{modelSub(m)}</span>
            </span>
            {m.id === selected && <span className="model-check">✓</span>}
          </button>
        ))}
        {matches.length === 0 && <p className="muted model-empty">No model matches.</p>}
        {matches.length > SHOWN && (
          <p className="muted model-empty">{matches.length - SHOWN} more; search to narrow the list.</p>
        )}
      </div>
    </div>
  );
}
