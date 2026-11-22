// A picture of the screen for the assistant (ATL-1, ATL-8): the app's layout
// drawn from the DOM (so it works alike in every WebView, and sees what's
// under the assistant's sheet on a phone), without the assistant itself, at
// most `assistant.screenshot-width` wide, as a JPEG data URL.

import { domToJpeg } from "modern-screenshot";

// Spec: ATL-8
/** `assistant.screenshot-width` in the spec. */
export const SCREENSHOT_WIDTH = 1280;
const TIMEOUT_MS = 8_000;

/** Parts of the layout that aren't "what the author is looking at". */
const LEFT_OUT = [".assistant", ".dock-toggle", ".sidebar-scrim", ".sidebar-toggle"];

// Spec: ATL-1, ATL-8
/** The screen as a JPEG data URL, or null when it can't be drawn. */
export async function captureScreen(): Promise<string | null> {
  const root = document.querySelector<HTMLElement>(".layout");
  if (!root) return null;
  const width = root.clientWidth || window.innerWidth;
  const scale = Math.min(1, SCREENSHOT_WIDTH / width);
  const background = getComputedStyle(document.body).backgroundColor;
  const shot = domToJpeg(root, {
    scale,
    quality: 0.82,
    backgroundColor: background,
    timeout: TIMEOUT_MS,
    filter: (node) => !(node instanceof Element && LEFT_OUT.some((s) => node.matches(s))),
  });
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS + 1_000));
  try {
    const url = await Promise.race([shot, timeout]);
    return url && url.startsWith("data:image/") ? url : null;
  } catch (e) {
    console.warn("Couldn't draw the screen for the assistant", e);
    return null;
  }
}
