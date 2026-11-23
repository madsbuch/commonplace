// Spec: DIAG-4
// Which build this is: CI stamps the commit and when it built it
// (VITE_BUILD_COMMIT, VITE_BUILD_TIME in the workflows); a build made
// anywhere else says so. The diagnostics name it, so a pasted log always
// says which version it came from (as learn-polish does).

const commit = import.meta.env.VITE_BUILD_COMMIT;
const time = import.meta.env.VITE_BUILD_TIME;

/** "05b6ada, built 2026-11-23 17:20 UTC", or "a local build". */
export function buildLabel(): string {
  if (typeof commit !== "string" || commit === "") return "a local build";
  const short = commit.slice(0, 7);
  const when = typeof time === "string" && time ? time.replace("T", " ").replace(/:\d\dZ$/, " UTC") : null;
  return when ? `${short}, built ${when}` : short;
}
