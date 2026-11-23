// Sync's start-up, imported once from main.tsx for its effects:
// - when the database opens, before anything writes to it, a copy of it
//   from elsewhere takes a new device id (src-tauri/src/sync/instance.rs);
// - then sync starts: listening, discovery, and syncing after every change;
// - another device's data arriving refreshes whatever the screens show.
//
// Outside the Tauri shell (a plain `bun run dev` in a browser) there is no
// backend to talk to; failures are logged and the app carries on.

import { getDb, onDatabaseOpen } from "./db";
import { notifyTablesChanged } from "./live";
import { followLeanChecks } from "./lean";
import { checkInstance, onSyncChanged, startSync } from "./sync";

onDatabaseOpen(async () => {
  try {
    await checkInstance();
  } catch (e) {
    console.warn("Checking the database's instance failed", e);
  }
  startSync().catch((e: unknown) => console.warn("Sync didn't start", e));
});

onSyncChanged(() => notifyTablesChanged("all"));
// Spec: LEAN-6
followLeanChecks();

// Open the database now, so sync starts even before a screen reads anything.
getDb().catch((e: unknown) => console.warn("The database didn't open", e));
