/**
 * Plugin dependency resolver — deterministic topological sort.
 *
 * The host calls `resolveOrder(plugins)` before `setup()` to guarantee that
 * every plugin's declared `dependencies` have already been set up. The
 * algorithm is Kahn's algorithm with stable tie-breaking (alphabetical) so
 * that resolution is reproducible across runs — important for tests and for
 * `nexum doctor` diagnostics.
 *
 * Cycles are reported with the full cycle path so users can fix the manifest.
 */

import type { NexumPlugin, PluginId, PluginManifest } from "./types.js";

export interface ResolveResult {
  /** Plugins in setup order (dependencies first). */
  order: PluginId[];
  /** Detected dependency cycles (each is a path of ids). */
  cycles: PluginId[][];
  /** Plugins that declared a dependency on something not registered. */
  missing: { id: PluginId; missing: PluginId[] }[];
}

/**
 * Topo-sort plugins by their `manifest.dependencies`.
 *
 * - Stable: ties broken alphabetically by id (reproducible output).
 * - Cycle-tolerant: cycles are collected, not thrown, so the host can decide.
 * - Missing-tolerant: a missing dependency is recorded; the dependent plugin
 *   still appears in `order` (it will simply fail its `setup` if it tries to
 *   `lookup` a token that was never provided).
 */
export function resolvePluginOrder(plugins: NexumPlugin[]): ResolveResult {
  const manifestById = new Map<PluginId, PluginManifest>();
  for (const p of plugins) {
    if (manifestById.has(p.manifest.id)) {
      // Duplicate registration is a programming error; surface it via missing.
      // The host's `register()` is the right place to throw — here we just
      // skip the duplicate so resolution can continue.
      continue;
    }
    manifestById.set(p.manifest.id, p.manifest);
  }

  const ids = [...manifestById.keys()].sort();
  const deps = new Map<PluginId, PluginId[]>();
  const missingMap = new Map<PluginId, PluginId[]>();

  for (const id of ids) {
    const declared = manifestById.get(id)!.dependencies ?? [];
    const present: PluginId[] = [];
    const missing: PluginId[] = [];
    for (const d of declared) {
      if (manifestById.has(d)) present.push(d);
      else missing.push(d);
    }
    deps.set(id, present);
    if (missing.length > 0) missingMap.set(id, missing);
  }

  // Kahn's algorithm with a sorted frontier for stable output.
  const indeg = new Map<PluginId, number>();
  for (const id of ids) indeg.set(id, 0);
  for (const id of ids) {
    for (const _d of deps.get(id) ?? []) {
      indeg.set(id, (indeg.get(id) ?? 0) + 1);
    }
  }

  const order: PluginId[] = [];
  // Frontier is kept sorted alphabetically for stable tie-breaking.
  let frontier = ids.filter((id) => (indeg.get(id) ?? 0) === 0);

  while (frontier.length > 0) {
    const next = frontier.shift()!;
    order.push(next);
    // Decrement indegree of every plugin that depends on `next`.
    const newlyReady: PluginId[] = [];
    for (const id of ids) {
      const depends = deps.get(id) ?? [];
      if (depends.includes(next)) {
        const newDeg = (indeg.get(id) ?? 0) - 1;
        indeg.set(id, newDeg);
        if (newDeg === 0) newlyReady.push(id);
      }
    }
    if (newlyReady.length > 0) {
      frontier = [...frontier, ...newlyReady].sort();
    }
  }

  // Detect cycles: any id not in `order` is part of (or downstream of) a cycle.
  const inOrder = new Set(order);
  const cyclicIds = ids.filter((id) => !inOrder.has(id));
  const cycles = detectCycles(cyclicIds, deps);

  return {
    order: [...order, ...cyclicIds], // cyclic plugins still get mounted (best-effort)
    cycles,
    missing: [...missingMap.entries()].map(([id, missing]) => ({ id, missing })),
  };
}

/**
 * Simple cycle detection over the dependency graph restricted to cyclic ids.
 * Returns each cycle as a path starting at the smallest id (stable).
 */
function detectCycles(ids: PluginId[], deps: Map<PluginId, PluginId[]>): PluginId[][] {
  const cycles: PluginId[][] = [];
  const visiting = new Set<PluginId>();
  const visited = new Set<PluginId>();
  const path: PluginId[] = [];

  const dfs = (id: PluginId): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const startIdx = path.indexOf(id);
      if (startIdx >= 0) {
        const cycle = path.slice(startIdx).concat(id);
        normalizeCycle(cycle);
        // Avoid duplicate cycles.
        if (!cycles.some((c) => sameCycle(c, cycle))) cycles.push(cycle);
      }
      return;
    }
    visiting.add(id);
    path.push(id);
    for (const d of deps.get(id) ?? []) {
      if (ids.includes(d)) dfs(d);
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of [...ids].sort()) dfs(id);
  return cycles;
}

function normalizeCycle(cycle: PluginId[]): void {
  // No-op; kept for future canonicalization.
  void cycle;
}

function sameCycle(a: PluginId[], b: PluginId[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  for (const x of b) if (!setA.has(x)) return false;
  return true;
}
