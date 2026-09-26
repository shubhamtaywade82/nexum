# Plugin Sandbox & Isolation

Plugins registered directly on a `DefaultPluginHost` run in-process with full host trust — fine for plugins you wrote yourself, wrong for third-party code. The plugin sandbox adds two opt-in isolation tiers so a plugin you did not write can be mounted without handing it the keys to the kernel.

```
unsandboxed registration          sandboxed registration
┌──────────────────────┐          ┌─────────────────────────────────┐
│ DefaultPluginHost    │          │ DefaultPluginHost               │
│  └─ plugin.setup(ctx)│          │  └─ sandboxed plugin            │
│      full capability │          │      Tier 1: policy mediation   │
│      access          │          │      (allow-lists, caps,        │
└──────────────────────┘          │       timeboxes, audit)         │
                                  │      Tier 2: worker isolation   │
                                  │      (resourceLimits, message   │
                                  │       bridge, no shared objects)│
                                  └─────────────────────────────────┘
```

## Tier 1 — Policy mediation

`sandboxPlugin(plugin, policy)` wraps any in-process plugin. Every `PluginContext` operation the plugin performs is checked against the policy **before** reaching the host:

| Policy field     | Controls                          | Default              |
| ---------------- | --------------------------------- | -------------------- |
| `provide`        | Capability tokens it may provide  | `[]` (deny all)      |
| `lookup`         | Capability tokens it may read     | `[]` (deny all)      |
| `declare`        | Capability tags it may declare    | `[]` (deny all)      |
| `maxProvides`    | Cap on provide calls during setup | `16`                 |
| `setupTimeoutMs` | Setup timebox                     | `10_000` (`0` = off) |
| `startTimeoutMs` | Start timebox                     | `10_000`             |
| `stopTimeoutMs`  | Stop timebox                      | `5_000`              |
| `onViolation`    | Callback for denied operations    | —                    |

All three allow-lists use the same wildcard language as the MCP trust policy: `*` matches any run of characters, `?` matches one. Lists are **deny-by-default** — sandboxing a plugin without listing what it may do leaves it able to do nothing.

```ts
import { DefaultPluginHost, sandboxPlugin } from "@nemesis-oss/nexum";

const host = new DefaultPluginHost({ workspaceRoot });
host.register(
  sandboxPlugin(thirdPartyPlugin, {
    provide: ["nexum:tools:*"], // may register tool capabilities
    lookup: ["nexum:config:*"], // may read config capabilities
    declare: ["tools"], // may declare the "tools" tag
    maxProvides: 4,
    setupTimeoutMs: 5_000,
    onViolation: (v) => telemetry.count("sandbox.violation", v),
  }),
);
await host.start();
```

Denied operations throw `PluginSandboxViolation` (a normal error the host collects — the plugin transitions to `error`, the host keeps running). Every decision, allowed or denied, lands in the wrapper's audit trail:

```ts
const wrapped = sandboxPlugin(plugin, policy);
// ... after start()
wrapped.sandbox.audit();
// [{ operation: "lookup", target: "nexum:secrets:vault", decision: "denied", reason: "...", at: "..." }]
```

A hung `setup`/`start`/`stop` is converted into a `PluginSandboxTimeout` error when its timebox expires, so a wedged plugin can never stall host startup.

## Tier 2 — Worker isolation

`IsolatedPluginSandbox.load(file)` runs a plugin **module file** inside a `worker_threads` Worker instead of the host process:

- **Hard resource ceilings** — `resourceLimits` (default: 128 MB old-generation heap, 32 MB young generation, 16 MB code range, 4 MB stack). A plugin that exceeds them is killed by V8, not by goodwill.
- **No shared objects** — the plugin's `ctx` is a proxy over `postMessage`. It cannot reach host objects at all; values passed through `lookup` must be structured-cloneable (functions and class instances are refused with a clear error).
- **Crash containment** — `process.exit()`, infinite loops, and import-time crashes kill the worker, surface as a normal plugin `error` state, and never take the host down.
- **Hang termination** — lifecycle calls are timeboxed; a timeout terminates the worker for good.

```ts
import { DefaultPluginHost, IsolatedPluginSandbox } from "@nemesis-oss/nexum";

const plugin = await IsolatedPluginSandbox.load("/srv/plugins/analytics.mjs", {
  policy: { provide: ["nexum:telemetry:*"], lookup: ["nexum:config:plain"] },
  resourceLimits: { maxOldGenerationSizeMb: 64 },
  setupTimeoutMs: 15_000,
});

const host = new DefaultPluginHost({ workspaceRoot });
host.register(plugin); // registers like any plugin — manifest comes from the module
await host.start();
// host.stop() terminates the worker automatically
```

The plugin file itself only needs a default export:

```js
// analytics.mjs — runs inside the worker
export default {
  manifest: { id: "analytics", name: "Analytics", version: "1.0.0" },
  async setup(ctx) {
    const config = await ctx.lookup("nexum:config:plain"); // bridge round-trip
    await ctx.provide("nexum:telemetry:client", { endpoint: config.endpoint });
    await ctx.declareCapability("telemetry");
    ctx.log("info", "analytics plugin ready");
  },
};
```

Inside the worker, `ctx.provide/lookup/declareCapability` are async (they round-trip the bridge) — `await` them. The same `PluginSandboxPolicy` from Tier 1 is enforced **host-side** on every bridged operation, so both tiers compose: resource isolation from the worker, capability discipline from the policy.

### What Tier 2 does not do

A worker isolate still runs Node: it can use `fs` and the network unless the host process itself is constrained (seccomp, containers, `--permission`). Use Tier 2 together with process-level confinement for hostile code; use it alone for fault isolation and capability discipline.

## Choosing a tier

| Situation                                             | Tier                       |
| ----------------------------------------------------- | -------------------------- |
| Your own plugin, just want timeboxes + audit          | Tier 1                     |
| Vendored third-party plugin, in-process is acceptable | Tier 1 with tight lists    |
| Plugin from the marketplace, unknown author           | Tier 2 + Tier 1 policy     |
| Fully hostile code                                    | Tier 2 + container/seccomp |

Both tiers are non-breaking: plugins registered without `sandboxPlugin` / `IsolatedPluginSandbox` behave exactly as before.

## CLI

Trial-run a plugin through the full Tier-2 lifecycle without a live host:

```bash
nexum plugins sandbox ./plugin.mjs --allow-lookup "cache:*" --json
```

See the [Trust & Security CLI reference](/guide/security-cli) for all flags and exit codes.
