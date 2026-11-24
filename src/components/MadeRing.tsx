// Spec: AUD-18
/**
 * How much of a section of a reading is made, as a ring that fills, a ✓ once
 * all of it is; a ring not full makes the section now when pressed (and
 * pulses while it's made).
 */
export function MadeRing(props: { title: string; made: number | null; making: boolean; onMake: () => void }) {
  const made = props.made ?? 0;
  if (made >= 1) {
    return (
      <span className="made-ring made" role="img" aria-label={`“${props.title}” is made`} title="Made">
        ✓
      </span>
    );
  }
  const r = 6.5;
  const around = 2 * Math.PI * r;
  return (
    <button
      type="button"
      className={props.making ? "made-ring making" : "made-ring"}
      aria-label={props.making ? `Making “${props.title}”` : `Make “${props.title}” now`}
      title={props.making ? "Making it…" : made > 0 ? `${Math.round(made * 100)}% made: make the rest now` : "Make it now"}
      disabled={props.making}
      onClick={props.onMake}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.6" />
        {made > 0 ? (
          <circle cx="9" cy="9" r={r} fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeDasharray={`${made * around} ${around}`} transform="rotate(-90 9 9)" />
        ) : null}
      </svg>
    </button>
  );
}
