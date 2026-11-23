import { Menu } from "@mantine/core";
import { useState } from "react";

export interface MoreAction {
  label: string;
  onClick: () => void;
  /** Asks first: the item turns into this question, and a second press does it. */
  confirm?: string;
  danger?: boolean;
}

// Spec: APP-12
/**
 * A thing's less common actions, behind ⋯ on its own screen: deleting among
 * them, never as a button in a list. An action that can't be undone asks first.
 */
export function MoreMenu(props: { label: string; actions: readonly MoreAction[] }) {
  const [asking, setAsking] = useState<string | null>(null);
  return (
    <Menu position="bottom-end" shadow="md" withinPortal onClose={() => setAsking(null)}>
      <Menu.Target>
        <button type="button" className="more-button" aria-label={props.label}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="19" cy="12" r="1.8" />
          </svg>
        </button>
      </Menu.Target>
      <Menu.Dropdown>
        {props.actions.map((a) => {
          const waiting = a.confirm !== undefined && asking !== a.label;
          return (
            <Menu.Item
              key={a.label}
              {...(a.danger ? { color: "red" } : {})}
              closeMenuOnClick={!waiting}
              onClick={waiting ? () => setAsking(a.label) : a.onClick}
            >
              {asking === a.label && a.confirm ? a.confirm : a.label}
            </Menu.Item>
          );
        })}
      </Menu.Dropdown>
    </Menu>
  );
}
