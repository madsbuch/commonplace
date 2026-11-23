/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The commit CI built (src/lib/build.ts); absent in a local build. */
  readonly VITE_BUILD_COMMIT?: string;
  /** When CI built it, ISO 8601 in UTC. */
  readonly VITE_BUILD_TIME?: string;
}
