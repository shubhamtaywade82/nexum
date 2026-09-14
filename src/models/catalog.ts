import { Provider, Tier } from "./adapters/provider.js";
import { loadModelPreferences } from "./catalog-data.js";
import type { ModelAvailabilityChecker } from "./router/availability.js";

export type Capability = "coding" | "vision" | "reasoning" | "quick" | "tools" | "agentic";

export interface ModelInfo {
  name: string;
  tier: Tier;
  capabilities: Capability[];
}

// Fallback only — used when real capability metadata isn't available (Ollama
// Cloud's OpenAI-compatible /v1/models doesn't expose it, matching the
// OpenAI models API shape). Local Ollama's /api/tags DOES report real
// capabilities per model (see capabilitiesFromLocalTag) — prefer that.
export function isEmbeddingModel(name: string): boolean {
  return /(embed|bge-|gte-|minilm|paraphrase)/i.test(name);
}

// Fallback only — used when real capability metadata isn't available (Ollama
// Cloud's OpenAI-compatible /v1/models doesn't expose it, matching the
// OpenAI models API shape). Local Ollama's /api/tags DOES report real
// capabilities per model (see capabilitiesFromLocalTag) — prefer that.
export function inferCapabilities(name: string): Capability[] {
  if (isEmbeddingModel(name)) return [];
  const n = name.toLowerCase();
  const caps: Capability[] = ["tools"];

  if (/(^|[^a-z])(vl|vision)([^a-z]|$)/.test(n)) caps.push("vision");
  if (/(r1|reason|thinking|qwq)/.test(n)) caps.push("reasoning");
  if (/(0\.5b|1b|2b|3b|4b|nano|mini|hermes|opencode)/.test(n)) caps.push("quick");
  if (/(hermes|openhermes|nous-hermes)/.test(n)) caps.push("agentic");
  if (!caps.includes("vision") && !caps.includes("reasoning")) caps.push("coding");

  return caps;
}

// Ollama's parameter_size is a free-form string like "4.7B" or "494.03M".
// Returns the size in billions of parameters, or null if unparseable.
function parseParameterSizeB(size: string | undefined): number | null {
  if (!size) return null;
  const m = size.match(/^([\d.]+)\s*([BMK])$/i);
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (Number.isNaN(value)) return null;
  const unit = m[2].toUpperCase();
  if (unit === "B") return value;
  if (unit === "M") return value / 1000;
  return value / 1_000_000; // K
}

const QUICK_MAX_PARAMS_B = 4;

interface LocalTagEntry {
  name?: string;
  model?: string;
  capabilities?: string[];
  details?: { parameter_size?: string };
}

// Local Ollama's /api/tags reports each model's real capabilities array
// (e.g. ["tools","vision","thinking","completion"]) and parameter_size —
// no heuristic guessing needed, unlike the cloud tier.
function capabilitiesFromLocalTag(entry: LocalTagEntry, name: string, quickPreferredName?: string): Capability[] {
  if (isEmbeddingModel(name)) return [];
  if (entry.capabilities && !entry.capabilities.includes("completion") && !entry.capabilities.includes("tools")) {
    return [];
  }
  if (!entry.capabilities) return inferCapabilities(name);

  const caps: Capability[] = [];
  const isPreferred = !!(quickPreferredName && name.toLowerCase().includes(quickPreferredName.toLowerCase()));
  if (entry.capabilities.includes("tools") || isPreferred || /minicpm/i.test(name)) caps.push("tools");
  if (entry.capabilities.includes("vision")) caps.push("vision");
  if (entry.capabilities.includes("thinking")) caps.push("reasoning");

  const sizeB = parseParameterSizeB(entry.details?.parameter_size);
  if (sizeB !== null && sizeB <= QUICK_MAX_PARAMS_B) caps.push("quick");

  // Embedding-only models (capabilities: ["embedding"], no "completion") can't
  // generate text at all — don't fall back to "coding" for them, they can't
  // chat regardless of how small or generically-named they are.
  const canGenerateText = entry.capabilities.includes("completion");
  if (canGenerateText && !caps.includes("vision") && !caps.includes("reasoning")) caps.push("coding");

  return caps;
}

function localTagEntries(data: unknown): LocalTagEntry[] {
  return (data as { models?: LocalTagEntry[] } | undefined)?.models ?? [];
}

function namesFromCloudModels(data: unknown): string[] {
  const items = (data as { data?: Array<{ id?: string }> } | undefined)?.data ?? [];
  return items.map((m) => m.id).filter((n): n is string => !!n);
}

// Ordered preference lists per capability — first-matching substring wins.
// Applied as a secondary sort after local-first tier ordering.
/*
 * Curated preferences are CONFIGURATION now (review item 35): shipped
 * defaults in models/catalog-data.ts, overridable via env
 * (NEXUM_MODEL_PREFS_<CAPABILITY>) or a JSON file. The catalog consumes
 * the loaded table; scored routing (models/router/scored-router.ts) owns
 * primary selection.
 */
const CURATED_PREFERENCES: Partial<Record<Capability, string[]>> = loadModelPreferences();

export class ModelCatalog {
  private models: ModelInfo[] = [];

  constructor(
    private readonly local?: Provider,
    private readonly cloud?: Provider,
    // Preferred name (substring match, case-insensitive) for the "quick" capability,
    // e.g. "minicpm5" — wins over any other locally-installed quick-tagged model,
    // so a specific always-resident model is always tried before any other local
    // candidate or cloud fallback.
    private readonly quickPreferredName?: string,
  ) {}

  async refresh(): Promise<ModelInfo[]> {
    const results: ModelInfo[] = [];

    if (this.local) {
      try {
        const data = await this.local.availableModels();
        for (const entry of localTagEntries(data)) {
          const name = entry.name ?? entry.model;
          if (!name) continue;
          let entryCaps = entry.capabilities;
          if (entryCaps && !entryCaps.includes("tools") && this.local.showModel) {
            const show = await this.local.showModel(name);
            if (show?.capabilities) entryCaps = show.capabilities;
          }
          const capabilities = capabilitiesFromLocalTag(
            { ...entry, capabilities: entryCaps },
            name,
            this.quickPreferredName,
          );
          if (capabilities.length === 0) continue;
          results.push({ name, tier: "local", capabilities });
        }
      } catch {
        // local Ollama not running — leave local models empty
      }
    }

    if (this.cloud) {
      try {
        const data = await this.cloud.availableModels();
        for (const name of namesFromCloudModels(data)) {
          const capabilities = inferCapabilities(name);
          if (capabilities.length === 0) continue;
          results.push({ name, tier: "cloud", capabilities });
        }
      } catch {
        // no cloud API key / unreachable — leave cloud models empty
      }
    }

    this.models = results;
    return results;
  }

  all(): ModelInfo[] {
    return this.models;
  }

  // Local-first: local candidates before cloud candidates. Within "quick",
  // quickPreferredName (if set) additionally wins the tie within its tier.
  // Curated preference ordering applied as a secondary sort within each tier.
  modelsFor(capability: Capability): ModelInfo[] {
    const preferred = capability === "quick" ? this.quickPreferredName?.toLowerCase() : undefined;
    const prefs = CURATED_PREFERENCES[capability];
    return this.models
      .filter((m) => m.capabilities.includes(capability))
      .sort((a, b) => {
        // Tier: local always before cloud
        if (a.tier !== b.tier) return a.tier === "local" ? -1 : 1;
        // quickPreferredName wins within the quick capability
        if (capability === "quick" && preferred) {
          const aMatch = a.name.toLowerCase().includes(preferred);
          const bMatch = b.name.toLowerCase().includes(preferred);
          if (aMatch !== bMatch) return aMatch ? -1 : 1;
        }
        // Curated preference order within tier
        if (!prefs) return 0;
        const rank = (m: ModelInfo): number => {
          const idx = prefs.findIndex((p) => m.name.toLowerCase().includes(p.toLowerCase()));
          return idx === -1 ? 999 : idx;
        };
        return rank(a) - rank(b);
      });
  }

  /**
   * Like `modelsFor`, but filters out cloud models whose availability has not
   * been confirmed by the given `ModelAvailabilityChecker`. Local models are
   * always included. Falls back to `modelsFor` when checker/apiKeys are absent.
   */
  async availableModelsFor(
    capability: Capability,
    checker?: ModelAvailabilityChecker,
    apiKeys?: string[],
  ): Promise<ModelInfo[]> {
    const all = this.modelsFor(capability);
    if (!checker || !apiKeys?.length) return all;
    const result: ModelInfo[] = [];
    for (const m of all) {
      if (m.tier === "local") {
        result.push(m);
        continue;
      }
      for (const key of apiKeys) {
        if (await checker.isAvailable(key, m.name)) {
          result.push(m);
          break;
        }
      }
    }
    return result;
  }
}
