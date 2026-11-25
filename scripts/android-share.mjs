// Spec: LIB-30
// Puts the app in Android's share sheet: the generated project's main
// activity gets filters for a shared text (a web address) and shared PDFs.
// The share-target plugin (src-tauri/plugins/share-target) takes what
// arrives. Run after generating the project (CI does, in android-apk.yml);
// running it again changes nothing, and it fails loudly if the template has
// changed so much that the edit no longer fits.
//
// The filters go on the app's own activity, not one of the plugin's: a
// share then reaches the running app as a new intent (the activity is
// singleTask), with the grant to read its files.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = process.argv[2] ?? join(root, "src-tauri/gen/android/app/src/main/AndroidManifest.xml");
const MARKER = "<!-- Sharing to the app: scripts/android-share.mjs -->";

let text = readFileSync(file, "utf8");
if (text.includes(MARKER)) {
  console.error(`${file}: sharing already set up.`);
  process.exit(0);
}

const anchor = "        </activity>\n";
const at = text.indexOf(anchor);
if (at === -1 || text.indexOf(anchor, at + 1) !== -1 || !text.slice(0, at).includes('android:name=".MainActivity"')) {
  console.error(`${file}: expected exactly one activity, the main one; the template changed.`);
  process.exit(1);
}

const filters = `            ${MARKER}
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="text/plain" />
                <data android:mimeType="application/pdf" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND_MULTIPLE" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="application/pdf" />
            </intent-filter>
`;
text = text.slice(0, at) + filters + text.slice(at);
writeFileSync(file, text);
console.error(`${file}: the app is in the share sheet.`);
