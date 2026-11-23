import { SettingsRows } from "../components/SettingsRows";
import "./AiScreens.css";

// Spec: APP-8
/** Settings: only rows, each leading to a page nested in it. */
export default function SettingsPage() {
  return (
    <div className="screen ai-screen">
      <h1>Settings</h1>
      <SettingsRows />
    </div>
  );
}
