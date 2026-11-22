import { setThemePref, useThemePref, type ThemePref } from "../lib/theme";
import { AutoIcon, MoonIcon, SunIcon } from "./Icons";

const CHOICES: { pref: ThemePref; label: string; icon: () => React.JSX.Element }[] = [
  { pref: "light", label: "Light", icon: SunIcon },
  { pref: "system", label: "Follow the system", icon: AutoIcon },
  { pref: "dark", label: "Dark", icon: MoonIcon },
];

// Spec: APP-4, APP-5
/** Light, dark, or as the system is; the new theme grows out of the button pressed. */
export function ThemeSwitch() {
  const pref = useThemePref();
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Theme">
      {CHOICES.map(({ pref: p, label, icon: I }) => (
        <button
          key={p}
          type="button"
          role="radio"
          aria-checked={pref === p}
          aria-label={label}
          title={label}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setThemePref(p, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
          }}
        >
          <I />
        </button>
      ))}
    </div>
  );
}
