/**
 * Brand constants — the single source of truth for the product identity.
 *
 * Nothing outside this file (and the migration code in workspace.ts /
 * environment.ts) may hardcode "Nexum"/"nexum"/"NEXUM" strings. Every banner,
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
  /** Legacy npm package (kept published as a deprecation pointer). */
  legacyPackage: "@nemesis-oss/devagent-ts",
  /** Canonical CLI command. */
  cli: "nexum",
  /** Deprecated CLI aliases, kept for one major version. */
  legacyCliAliases: ["devagent", "devagent-ts"],
  /** Workspace state directory (relative to workspace root). */
  configDir: ".nexum",
  /** Legacy workspace state directory — read + migrated, never deleted. */
  legacyConfigDir: ".devagent",
  /** Canonical environment-variable prefix. */
  envPrefix: "NEXUM_",
  /** Legacy environment-variable prefix (deprecated alias). */
  legacyEnvPrefix: "DEVAGENT_",
  /** Human-facing runtime identity. */
  runtimeTitle: "Nexum Agent Runtime",
  /** Human-facing harness identity. */
  harnessTitle: "Nexum Agent Harness",
  /** Default sandbox Docker image. */
  sandboxImage: "nexum-sandbox:latest",
  /** Legacy sandbox Docker image (fallback default). */
  legacySandboxImage: "devagent-sandbox:latest",
} as const;
