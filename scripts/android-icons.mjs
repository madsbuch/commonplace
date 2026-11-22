// Puts the app's Android icons (src-tauri/icons/android) into the generated
// Android project, over the template's defaults. `tauri android init` doesn't
// copy them, so without this an APK shows Tauri's icon. Run after generating
// the project (CI does, in android-apk.yml); running it again changes nothing.
//
// The icons: an adaptive icon (mipmap-anydpi-v26: the mark in
// ic_launcher_foreground over ic_launcher_background, the logo's ink blue),
// with ic_launcher (the logo) and ic_launcher_round for older launchers.
// Sources: src/assets/logo.svg, logo-android-foreground.svg, logo-round.svg.

import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "src-tauri/icons/android");
const to = join(root, "src-tauri/gen/android/app/src/main/res");

if (!existsSync(to)) {
  console.error(`${to} doesn't exist: generate the Android project first (bun run tauri android init).`);
  process.exit(1);
}
cpSync(from, to, { recursive: true });
console.error(`Android icons copied into ${to}.`);
