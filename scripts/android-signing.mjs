// Makes the generated Android project sign release builds with the keystore
// CI writes to src-tauri/gen/android/keystore.properties. Without a keystore
// the release APK stays unsigned, as before.
//
// `tauri android init` generates src-tauri/gen/android from Tauri's template,
// which has no signing config. Tally commits its generated project with this
// edit made by hand; until this project commits its own, CI generates it and
// runs this. It is idempotent, and fails loudly if the template has changed
// so much that the edit no longer fits.
//
// The debug build's own package (".dev") needs no edit: the template takes
// it from bundle.android.debugApplicationIdSuffix in tauri.conf.json.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = process.argv[2] ?? join(root, "src-tauri/gen/android/app/build.gradle.kts");
const MARKER = "// Release signing: scripts/android-signing.mjs";

let text = readFileSync(file, "utf8");
if (text.includes(MARKER)) {
  console.error(`${file}: release signing already set up.`);
  process.exit(0);
}

/** Inserts `insert` before (or after) the one occurrence of `anchor`. */
function put(anchor, insert, where) {
  const at = text.indexOf(anchor);
  if (at === -1 || text.indexOf(anchor, at + 1) !== -1) {
    console.error(`${file}: expected exactly one ${JSON.stringify(anchor)}; the template changed.`);
    process.exit(1);
  }
  const i = where === "after" ? at + anchor.length : at;
  text = text.slice(0, i) + insert + text.slice(i);
}

put("import java.util.Properties\n", "import java.io.FileInputStream\n", "after");
put(
  "\nandroid {\n",
  `
${MARKER}
val keyPropertiesFile = rootProject.file("keystore.properties")
val keyProperties = Properties().apply {
    if (keyPropertiesFile.exists()) {
        FileInputStream(keyPropertiesFile).use { load(it) }
    }
}
`,
  "before",
);
put(
  "    buildTypes {\n",
  `    signingConfigs {
        create("release") {
            if (keyPropertiesFile.exists()) {
                keyAlias = keyProperties["keyAlias"] as String
                keyPassword = keyProperties["password"] as String
                storeFile = file(keyProperties["storeFile"] as String)
                storePassword = keyProperties["password"] as String
            }
        }
    }
`,
  "before",
);
put(
  `        getByName("release") {\n`,
  `            if (keyPropertiesFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
`,
  "after",
);

writeFileSync(file, text);
console.error(`${file}: release signing set up.`);
