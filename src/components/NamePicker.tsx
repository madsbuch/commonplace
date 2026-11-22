import { useMemo, useState } from "react";
import { normalizeName } from "../lib/peopleModel";

/** A text field that suggests existing names: pick one, or press Enter to use what's typed. */
export function NamePicker(props: {
  options: readonly { id: string; name: string }[];
  placeholder: string;
  onPick: (id: string) => void;
  onNew: (name: string) => void;
  autoFocus?: boolean;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState("");
  const [active, setActive] = useState(0);
  const matches = useMemo(() => {
    const q = normalizeName(value);
    if (q === "") return [];
    return props.options.filter((o) => normalizeName(o.name).includes(q)).slice(0, 8);
  }, [value, props.options]);

  const exact = matches.find((m) => normalizeName(m.name) === normalizeName(value));
  const choose = (i: number) => {
    const m = matches[i];
    if (m) props.onPick(m.id);
    else if (value.trim()) props.onNew(value.trim());
    setValue("");
    setActive(0);
  };

  return (
    <div className="name-picker">
      <input
        value={value}
        placeholder={props.placeholder}
        autoFocus={props.autoFocus}
        onChange={(e) => {
          setValue(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, matches.length));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(active < matches.length ? active : -1);
          } else if (e.key === "Escape") {
            setValue("");
            props.onCancel?.();
          }
        }}
      />
      {value.trim() ? (
        <ul className="name-picker-list">
          {matches.map((m, i) => (
            <li key={m.id}>
              <button type="button" className={i === active ? "active" : undefined} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(i)}>
                {m.name}
              </button>
            </li>
          ))}
          {!exact ? (
            <li>
              <button
                type="button"
                className={active === matches.length ? "active" : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(-1)}
              >
                Add “{value.trim()}”
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
