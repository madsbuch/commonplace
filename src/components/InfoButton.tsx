/**
 * Help that stays out of the way until it's wanted (APP-9), as in Tally.
 *
 * An ⓘ sits beside what it explains, and the words live in a sheet behind it.
 * What belongs in one: anything true of the app ("the details are read by a
 * model"), not the state of things today, which stays on the screen. The ⓘ
 * can carry a little state of its own: it pulses while something it explains
 * is under way, and turns the warning colour when that failed.
 */
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

function InfoSheet(props: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);
  // At the body, not where the ⓘ sits: inside a heading it would take on the heading's style.
  return createPortal(
    <div className="dialog-backdrop info-backdrop" onClick={props.onClose}>
      <div className="dialog info-sheet" role="dialog" aria-label={props.title} onClick={(e) => e.stopPropagation()}>
        <h2>{props.title}</h2>
        <div className="info-body">{props.children}</div>
        <div className="dialog-actions">
          <button type="button" className="button-primary" autoFocus onClick={props.onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Spec: APP-9
/** An ⓘ; `children` is what it says when pressed. */
export function InfoButton(props: { title: string; children: ReactNode; tone?: "busy" | "warning" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`info-btn${props.tone ? ` ${props.tone}` : ""}`}
        aria-label={`About ${props.title.toLowerCase()}`}
        title={props.title}
        onClick={() => setOpen(true)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <circle cx="12" cy="12" r="9.25" />
          <path d="M12 10.5v6" strokeLinecap="round" />
          <circle cx="12" cy="7.4" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {open ? (
        <InfoSheet title={props.title} onClose={() => setOpen(false)}>
          {props.children}
        </InfoSheet>
      ) : null}
    </>
  );
}
