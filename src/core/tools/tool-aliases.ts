/**
 * Canonical tool names + compatibility aliases (review item 36).
 *
 * Canonical ids (the ToolDefinition id the model should see and the
 * registry indexes by) are authoritative. Aliases exist ONLY so models
 * trained on other tool vocabularies keep working: the gateway resolves
 * any alias to the canonical name before anything else happens.
 *
 * This module is the single source of truth — the legacy Registry and the
 * ToolGateway both import it (previously the table was duplicated).
 */

/**
 * alias → canonical. Ordered longest-prefix-independent (exact map lookup).
 * Keep entries lowercase; resolution lowercases the input.
 */
export const TOOL_ALIASES: Readonly<Record<string, string>> = {
  // filesystem
  open_file: "read_file",
  cat_file: "read_file",
  view_file: "read_file",
  print_tree: "list_dir",
  tree: "list_dir",
  ls: "list_dir",
  // search
  search_codebase: "search_code",
  find_code: "search_code",
  // process
  execute_command: "run_shell",
  bash: "run_shell",
  sh: "run_shell",
  // editing (legacy primitive names → canonical apply-patch vocabulary)
  patch_file: "apply_patch",
  edit_file: "edit_file_lines",
};

/** Vendor/function-call namespace prefixes stripped before lookup. */
const NAMESPACE_PREFIXES = [/^functions\./i, /^tools__/i, /^tool_/i, /^mcp_/i];

/** Vendor bracket wrappers some providers emit. */
const WRAPPERS = [/^tools\[(.+)\]$/i, /^\[(.+)\]$/];

/**
 * Resolve any emitted name (aliases, namespaces, wrappers) to the
 * canonical tool name. Pure: no registry access.
 */
export function canonicalToolName(rawName: string): string {
  let name = rawName.trim();
  for (const wrapper of WRAPPERS) {
    const m = name.match(wrapper);
    if (m) name = m[1];
  }
  for (const prefix of NAMESPACE_PREFIXES) {
    name = name.replace(prefix, "");
  }
  const clean = name.trim();
  return TOOL_ALIASES[clean] ?? TOOL_ALIASES[clean.toLowerCase()] ?? clean;
}
