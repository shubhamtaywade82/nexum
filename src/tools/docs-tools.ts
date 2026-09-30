import { Tool } from "./tool.js";
import { DocsStore } from "../docs/store.js";
import { DOC_CATALOG, findCatalogEntry } from "../docs/catalog.js";
import { detectWorkspaceDocSources } from "../docs/workspace-detect.js";
import { LazyDocs } from "../docs/lazy.js";

const MAX_BODY_CHARS = 6000;

function resolveSlugs(ids: string[], store: DocsStore): string[] {
  const ingested = new Set(store.listSources().map((s) => s.slug));
  const slugs: string[] = [];
  for (const id of ids) {
    const slug = findCatalogEntry(id)?.slug ?? id;
    if (ingested.has(slug) && !slugs.includes(slug)) slugs.push(slug);
  }
  return slugs;
}

export class SearchDocsTool extends Tool {
  private readonly lazy: LazyDocs;

  constructor(
    private readonly store: DocsStore,
    private readonly workspaceRoot: string,
    lazy?: LazyDocs,
  ) {
    super();
    this.lazy = lazy ?? new LazyDocs(store);
  }

  get name(): string {
    return "search_docs";
  }

  get description(): string {
    return (
      "Full-text search over library/framework documentation (DevDocs). Searches the locally cached sources " +
      "relevant to this workspace (auto-detected from package.json/Gemfile/etc) and downloads a missing source " +
      "only when the query needs it (at most two per call). Pass `source` to search one specific doc set instead. " +
      "Use `list_doc_sources` to see what's cached."
    );
  }

  get tags(): string[] {
    return ["docs", "documentation", "reference", "search"];
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms" },
        source: {
          type: "string",
          description: 'Restrict to one doc id/slug (e.g. "react", "rails"). Omit to auto-scope to the workspace.',
        },
        limit: { type: "number", description: "Max results (default 8)" },
      },
      required: ["query"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = args.query as string;
    if (!query || !query.trim()) {
      return { error: "ArgumentError", message: "query is required" };
    }

    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 50) : 8;

    if (typeof args.source === "string" && args.source.trim()) {
      const source = args.source.trim();
      await this.lazy.ensure(source);
      const slugs = resolveSlugs([source], this.store);
      if (slugs.length === 0) {
        return {
          error: "UnknownSourceError",
          message: `"${source}" isn't a recognized DevDocs source and couldn't be fetched. Check list_doc_sources for available ids.`,
        };
      }
      return { scope: "explicit", sources: slugs, results: this.store.search(query, { slugs, limit }) };
    }

    const workspaceIds = detectWorkspaceDocSources(this.workspaceRoot);
    if (workspaceIds.length === 0) {
      return { scope: "all", sources: "all", results: this.store.search(query, { limit }) };
    }

    const outcome = await this.lazy.searchWorkspace(query, workspaceIds, limit);
    if (outcome.slugs.length === 0) {
      // Nothing cached and nothing fetchable (offline / cooling down): fall back to whatever is cached.
      return {
        scope: "all",
        sources: "all",
        results: this.store.search(query, { limit }),
        ...(outcome.skipped.length > 0 ? { skipped: outcome.skipped } : {}),
      };
    }
    return {
      scope: "workspace",
      sources: outcome.slugs,
      results: outcome.results,
      ...(outcome.fetched.length > 0 ? { fetched: outcome.fetched } : {}),
      ...(outcome.skipped.length > 0 ? { skipped: outcome.skipped } : {}),
    };
  }
}

export class GetDocTool extends Tool {
  constructor(private readonly store: DocsStore) {
    super();
  }

  get name(): string {
    return "get_doc";
  }

  get description(): string {
    return "Fetch the full content of one documentation section by source + path, as returned by search_docs.";
  }

  get tags(): string[] {
    return ["docs", "documentation", "reference"];
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        source: { type: "string", description: 'Doc id/slug (e.g. "react", "rails")' },
        path: { type: "string", description: "Section path, as returned by search_docs (may include a #anchor)" },
      },
      required: ["source", "path"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const source = args.source as string;
    const path = args.path as string;
    if (!source || !path) {
      return { error: "ArgumentError", message: "source and path are required" };
    }

    const slug = findCatalogEntry(source)?.slug ?? source;
    const section = this.store.getSection(slug, path);
    if (!section) {
      return { error: "NotFoundError", message: `no section "${path}" found in doc source "${source}"` };
    }

    const truncated = section.body.length > MAX_BODY_CHARS;
    return {
      source: slug,
      path: section.path,
      title: section.title,
      body: truncated ? section.body.slice(0, MAX_BODY_CHARS) : section.body,
      truncated,
    };
  }
}

export class ListDocSourcesTool extends Tool {
  constructor(
    private readonly store: DocsStore,
    private readonly workspaceRoot: string,
  ) {
    super();
  }

  get name(): string {
    return "list_doc_sources";
  }

  get description(): string {
    return "List documentation sources currently ingested and searchable, plus which ones this workspace uses by default.";
  }

  get tags(): string[] {
    return ["docs", "documentation", "reference"];
  }

  async call(): Promise<Record<string, unknown>> {
    const ingested = this.store.listSources();
    const workspaceIds = detectWorkspaceDocSources(this.workspaceRoot);
    const workspaceSlugs = resolveSlugs(workspaceIds, this.store);
    return {
      ingested,
      workspaceDefaultSources: workspaceSlugs,
      catalog: DOC_CATALOG,
    };
  }
}
