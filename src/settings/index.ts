/**
 * SettingsService — runtime-introspectable + mutable configuration.
 *
 * Nexum has configuration (CliConfig, env vars, .nexum/config.json) but it's
 * primarily an application-level mechanism loaded once at startup. The
 * SettingsService formalizes a runtime capability: live introspection of
 * settings grouped by namespace, controlled mutation with validation, and
 * notification of changes.
 *
 * Namespaces mirror DeepSeek Harness's settings UI:
 *   - model       (model selection, routing, providers)
 *   - tool        (tool selection, gateway behavior)
 *   - policy      (posture, rules, profiles)
 *   - sandbox     (docker image, timeouts, resource limits)
 *   - subagent    (max concurrent, max per session)
 *   - mcp         (server configs, transport)
 *   - workspace   (root, languages, project info)
 *   - ui          (theme, density, keybindings)
 *
 * Each setting has a typed key, a default, a validator, and optional
 * metadata (description, category, editable flag). Read-only settings
 * (e.g. workspaceRoot) are introspectable but reject mutation.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";

// ── Contracts ───────────────────────────────────────────────────────────────

export type SettingValue = string | number | boolean | string[] | Record<string, unknown>;
export type SettingNamespace = "model" | "tool" | "policy" | "sandbox" | "subagent" | "mcp" | "workspace" | "ui" | "custom";

export interface SettingSpec {
  /** Dotted path: "namespace.key" or "namespace.group.key". */
  key: string;
  /** Display label. */
  label: string;
  /** Long-form description. */
  description?: string;
  /** Default value. */
  default: SettingValue;
  /** Current value (computed from default + overrides; populated by service). */
  value?: SettingValue;
  /** Type tag for UI rendering. */
  type: "string" | "number" | "boolean" | "string[]" | "object";
  /** Namespace grouping. */
  namespace: SettingNamespace;
  /** Whether the setting can be mutated at runtime. */
  editable: boolean;
  /** Whether the setting requires a restart to take effect. */
  requiresRestart?: boolean;
  /** Optional validator (returns error string, or undefined if valid). */
  validate?: (value: SettingValue) => string | undefined;
  /** Optional tags for filtering. */
  tags?: string[];
  /** Whether the value contains secrets (redact on display). */
  secret?: boolean;
}

export interface SettingUpdate {
  key: string;
  value: SettingValue;
  /** Who/what is changing it (audit). */
  source?: string;
  /** ISO timestamp. */
  at?: string;
}

export interface SettingsChangeEvent {
  key: string;
  oldValue: SettingValue;
  newValue: SettingValue;
  source?: string;
  at: string;
}

export interface SettingsServiceOptions {
  /** Root directory for persisted settings (e.g. workspaceRoot/.nexum). */
  rootDir?: string;
  /** Disable fs writes (in-memory). */
  inMemory?: boolean;
  /** Initial spec registry (call .registerSpec to add). */
  specs?: SettingSpec[];
}

// ── SettingsService ──────────────────────────────────────────────────────────

export class SettingsService extends EventEmitter {
  private readonly specs = new Map<string, SettingSpec>();
  private readonly overrides = new Map<string, SettingValue>();
  private readonly history: SettingUpdate[] = [];
  private readonly settingsFile?: string;
  private readonly inMemory: boolean;

  constructor(opts: SettingsServiceOptions = {}) {
    super();
    this.inMemory = opts.inMemory ?? false;
    if (opts.rootDir && !this.inMemory) {
      this.settingsFile = join(opts.rootDir, "settings.json");
      this.loadOverrides();
    }
    for (const spec of opts.specs ?? []) {
      this.registerSpec(spec);
    }
  }

  /** Register a setting spec (must be called before get/set). */
  registerSpec(spec: SettingSpec): this {
    if (this.specs.has(spec.key)) {
      throw new Error(`setting "${spec.key}" already registered`);
    }
    this.specs.set(spec.key, { ...spec, value: this.overrides.get(spec.key) ?? spec.default });
    return this;
  }

  /** Get a setting value by key. */
  get(key: string): SettingValue | undefined {
    const spec = this.specs.get(key);
    if (!spec) return undefined;
    return this.overrides.get(key) ?? spec.default;
  }

  /** Get a setting spec (with metadata). */
  getSpec(key: string): SettingSpec | undefined {
    const spec = this.specs.get(key);
    if (!spec) return undefined;
    return { ...spec, value: this.overrides.get(key) ?? spec.default };
  }

  /** Require a setting (throws if missing). */
  require(key: string): SettingValue {
    const value = this.get(key);
    if (value === undefined) {
      throw new Error(
        `setting "${key}" not registered. Available: ${[...this.specs.keys()].sort().join(", ") || "(none)"}`,
      );
    }
    return value;
  }

  /** Set a setting value (validates + emits change event). */
  set(key: string, value: SettingValue, source?: string): void {
    const spec = this.specs.get(key);
    if (!spec) {
      throw new Error(`cannot set unknown setting "${key}"`);
    }
    if (!spec.editable) {
      throw new Error(`setting "${key}" is not editable`);
    }
    if (spec.validate) {
      const error = spec.validate(value);
      if (error) {
        throw new Error(`invalid value for "${key}": ${error}`);
      }
    }
    const oldValue = this.get(key)!;
    this.overrides.set(key, value);
    const update: SettingUpdate = {
      key,
      value,
      source,
      at: new Date().toISOString(),
    };
    this.history.push(update);
    this.persistOverrides();
    const event: SettingsChangeEvent = {
      key,
      oldValue,
      newValue: value,
      source,
      at: update.at!,
    };
    this.emit("change", event);
  }

  /** Reset a setting to its default. */
  reset(key: string, source?: string): void {
    const spec = this.specs.get(key);
    if (!spec) return;
    const oldValue = this.get(key)!;
    this.overrides.delete(key);
    this.persistOverrides();
    this.emit("change", {
      key,
      oldValue,
      newValue: spec.default,
      source,
      at: new Date().toISOString(),
    });
  }

  /** List all setting specs (optionally filtered by namespace). */
  list(namespace?: SettingNamespace): SettingSpec[] {
    const specs = [...this.specs.values()];
    const result = specs.map((s) => ({ ...s, value: this.overrides.get(s.key) ?? s.default }));
    return namespace ? result.filter((s) => s.namespace === namespace) : result;
  }

  /** List all settings in a namespace. */
  byNamespace(ns: SettingNamespace): SettingSpec[] {
    return this.list(ns);
  }

  /** Get the change history (audit log). */
  changes(): SettingUpdate[] {
    return [...this.history];
  }

  /** Get a redacted view of all settings (for `nexum settings list`). */
  redacted(): Array<{ key: string; label: string; value: SettingValue; namespace: SettingNamespace; editable: boolean }> {
    return this.list().map((s) => ({
      key: s.key,
      label: s.label,
      value: (s.secret ? "***REDACTED***" : (s.value ?? s.default)) as SettingValue,
      namespace: s.namespace,
      editable: s.editable,
    }));
  }

  /** Export overrides as JSON (for backup / migration). */
  exportOverrides(): Record<string, SettingValue> {
    return Object.fromEntries(this.overrides);
  }

  /** Import overrides from JSON (merges, doesn't replace). */
  importOverrides(data: Record<string, SettingValue>, source?: string): void {
    for (const [key, value] of Object.entries(data)) {
      const spec = this.specs.get(key);
      if (!spec) continue; // skip unknown keys
      if (!spec.editable) continue;
      try {
        this.set(key, value, source);
      } catch {
        // skip invalid
      }
    }
  }

  // ── internals ───────────────────────────────────────────────────────────

  private loadOverrides(): void {
    if (!this.settingsFile || !existsSync(this.settingsFile)) return;
    try {
      const data = JSON.parse(readFileSync(this.settingsFile, "utf8"));
      if (typeof data === "object" && data !== null) {
        for (const [k, v] of Object.entries(data)) {
          this.overrides.set(k, v as SettingValue);
        }
      }
    } catch {
      // corrupt file — start fresh
    }
  }

  private persistOverrides(): void {
    if (this.inMemory || !this.settingsFile) return;
    try {
      const dir = join(this.settingsFile, "..");
      mkdirSync(dir, { recursive: true });
      const tmp = `${this.settingsFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.overrides), null, 2));
      renameSync(tmp, this.settingsFile);
    } catch {
      // best-effort
    }
  }
}

// ── Default setting specs ───────────────────────────────────────────────────

/** Register a default set of setting specs (model/tool/policy/sandbox/etc.). */
export function registerDefaultSpecs(service: SettingsService): void {
  // Model
  service.registerSpec({
    key: "model.routingStrategy",
    label: "Model Routing Strategy",
    description: "How models are selected for a given capability.",
    default: "scored",
    type: "string",
    namespace: "model",
    editable: true,
    validate: (v) => (["scored", "local-first", "cloud-first"].includes(String(v)) ? undefined : "must be scored|local-first|cloud-first"),
  });
  service.registerSpec({
    key: "model.maxConcurrent",
    label: "Max Concurrent Model Calls",
    default: 8,
    type: "number",
    namespace: "model",
    editable: true,
    validate: (v) => (typeof v === "number" && v > 0 ? undefined : "must be a positive number"),
  });

  // Tool
  service.registerSpec({
    key: "tool.selectionMode",
    label: "Tool Selection Mode",
    default: "static",
    type: "string",
    namespace: "tool",
    editable: true,
    validate: (v) => (["static", "dynamic", "llm"].includes(String(v)) ? undefined : "must be static|dynamic|llm"),
  });
  service.registerSpec({
    key: "tool.maxActive",
    label: "Max Active Tools",
    default: 64,
    type: "number",
    namespace: "tool",
    editable: true,
  });

  // Policy
  service.registerSpec({
    key: "policy.posture",
    label: "Policy Posture",
    default: "standard",
    type: "string",
    namespace: "policy",
    editable: true,
    validate: (v) => (["parity", "standard", "restricted"].includes(String(v)) ? undefined : "must be parity|standard|restricted"),
  });
  service.registerSpec({
    key: "policy.autoApprove",
    label: "Auto-Approve Destructive Actions",
    default: false,
    type: "boolean",
    namespace: "policy",
    editable: true,
  });

  // Sandbox
  service.registerSpec({
    key: "sandbox.image",
    label: "Sandbox Docker Image",
    default: "nexum-sandbox:latest",
    type: "string",
    namespace: "sandbox",
    editable: true,
  });
  service.registerSpec({
    key: "sandbox.timeoutSec",
    label: "Sandbox Timeout (seconds)",
    default: 120,
    type: "number",
    namespace: "sandbox",
    editable: true,
  });

  // Subagent
  service.registerSpec({
    key: "subagent.maxConcurrent",
    label: "Max Concurrent Subagents",
    default: 8,
    type: "number",
    namespace: "subagent",
    editable: true,
  });
  service.registerSpec({
    key: "subagent.maxPerSession",
    label: "Max Subagents Per Session",
    default: 32,
    type: "number",
    namespace: "subagent",
    editable: true,
  });

  // Workspace
  service.registerSpec({
    key: "workspace.root",
    label: "Workspace Root",
    default: process.cwd(),
    type: "string",
    namespace: "workspace",
    editable: false,
  });

  // UI
  service.registerSpec({
    key: "ui.theme",
    label: "UI Theme",
    default: "default",
    type: "string",
    namespace: "ui",
    editable: true,
  });
  service.registerSpec({
    key: "ui.density",
    label: "UI Density",
    default: "comfortable",
    type: "string",
    namespace: "ui",
    editable: true,
    validate: (v) => (["compact", "comfortable", "spacious"].includes(String(v)) ? undefined : "must be compact|comfortable|spacious"),
  });
}
