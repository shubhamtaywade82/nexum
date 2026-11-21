/**
 * Brand constants — the single source of truth for the product identity.
 *
 * Nothing outside this file may hardcode "Nexum"/"nexum"/"NEXUM" strings. Every banner,
 * path, env prefix, and doc reference derives from BRAND so that a future
 * name change is a one-file edit (see docs/REBRANDING.md).
 */

export const BRAND = {
  /** Product display name. */
  name: "Nexum",
  /** Owning organization. */
  organization: "Nemesis OSS",
  /** Canonical npm package. */
  package: "@nemesis-oss/nexum",
  /** Canonical CLI command. */
  cli: "nexum",
  /** Workspace state directory (relative to workspace root). */
  configDir: ".nexum",
  /** Canonical environment-variable prefix. */
  envPrefix: "NEXUM_",
  /** Human-facing runtime identity. */
  runtimeTitle: "Nexum Agent Runtime",
  /** Human-facing harness identity. */
  harnessTitle: "Nexum Agent Harness",
  /** Default sandbox Docker image. */
  sandboxImage: "nexum-sandbox:latest",
} as const;
