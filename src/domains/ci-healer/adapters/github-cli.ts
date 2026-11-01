import { z } from "zod";
import type { CommandPort, GitHubPort } from "../application/ports.js";
import type { OpenPullRequest, PullRequestState, WorkflowRun } from "../domain/types.js";
import { ProtocolError } from "../errors.js";

/**
 * GitHub access through the REST API, via `gh api`. The GraphQL-backed commands
 * (`gh repo view`, `gh pr list`, `gh pr view`, `gh pr create`) are refused in some
 * sessions, so they are not used. Every response is validated against a schema, so a
 * changed shape fails as a ProtocolError rather than being guessed at.
 */

const PAGE_MAX = 100;
const MAX_PAGES = 5;
const MAX_FAILED_JOBS = 10;

const runSchema = z.object({
  id: z.number().int(),
  head_branch: z.string().nullish(),
  head_sha: z.string(),
  name: z.string().nullish(),
  event: z.string().nullish(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  run_attempt: z.number().int().nullish(),
  created_at: z.string().nullish(),
  html_url: z.string().nullish(),
});

const runsPageSchema = z.object({ workflow_runs: z.array(runSchema) });

const repoRef = z.object({ full_name: z.string() }).nullish();

const pullSchema = z.object({
  number: z.number().int(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean().nullish(),
  draft: z.boolean().nullish(),
  head: z.object({ ref: z.string(), sha: z.string(), repo: repoRef }),
  base: z.object({ ref: z.string(), repo: repoRef }),
});

const repositorySchema = z.object({ default_branch: z.string().min(1) });

const jobsSchema = z.object({
  jobs: z.array(z.object({ id: z.number().int(), name: z.string(), conclusion: z.string().nullish() })),
});

const createdPullSchema = z.object({ number: z.number().int() });

export interface GitHubCliOptions {
  command: CommandPort;
  /** owner/name */
  repo: string;
  cwd: string;
  timeoutMs?: number;
}

export class GitHubCli implements GitHubPort {
  private readonly timeoutMs: number;

  constructor(private readonly options: GitHubCliOptions) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async defaultBranch(): Promise<string> {
    const data = parse(repositorySchema, await this.json(`repos/${this.repo()}`), "repository");
    return data.default_branch;
  }

  async runsForBranch(branch: string, limit = 30): Promise<WorkflowRun[]> {
    const wanted = Math.max(1, limit);
    const perPage = Math.min(PAGE_MAX, wanted);
    const runs: WorkflowRun[] = [];
    for (let page = 1; page <= MAX_PAGES && runs.length < wanted; page += 1) {
      const path = `repos/${this.repo()}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=${perPage}&page=${page}`;
      const data = parse(runsPageSchema, await this.json(path), `runs on ${branch}`);
      runs.push(...data.workflow_runs.map(toRun));
      if (data.workflow_runs.length < perPage) break;
    }
    return runs.slice(0, wanted);
  }

  async openPullRequests(): Promise<OpenPullRequest[]> {
    const pulls: OpenPullRequest[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const path = `repos/${this.repo()}/pulls?state=open&per_page=${PAGE_MAX}&page=${page}`;
      const data = parse(z.array(pullSchema), await this.json(path), "open PRs");
      pulls.push(...data.map(toOpenPullRequest));
      if (data.length < PAGE_MAX) break;
    }
    return pulls;
  }

  async pullRequest(number: number): Promise<PullRequestState> {
    const pull = parse(pullSchema, await this.json(`repos/${this.repo()}/pulls/${number}`), `PR #${number}`);
    const state = pull.merged ? "MERGED" : pull.state === "open" ? "OPEN" : "CLOSED";
    return { number: pull.number, state, headRefOid: pull.head.sha };
  }

  /** Logs of the failed jobs in a run, one section per job. The REST logs endpoint for a whole run is a ZIP, so per-job logs are used. */
  async failedLog(runId: number): Promise<string> {
    const jobs = parse(
      jobsSchema,
      await this.json(`repos/${this.repo()}/actions/runs/${runId}/jobs?filter=latest&per_page=${PAGE_MAX}`),
      `jobs of run ${runId}`,
    );
    const failed = jobs.jobs
      .filter((job) => job.conclusion === "failure" || job.conclusion === "timed_out")
      .slice(0, MAX_FAILED_JOBS);
    const sections: string[] = [];
    for (const job of failed) {
      const log = await this.text(`repos/${this.repo()}/actions/jobs/${job.id}/logs`);
      sections.push(`=== job: ${job.name} ===\n${log}`);
    }
    return sections.join("\n");
  }

  async createDraftPullRequest(input: { base: string; head: string; title: string; body: string }): Promise<number> {
    const created = parse(
      createdPullSchema,
      await this.json(`repos/${this.repo()}/pulls`, {
        method: "POST",
        body: { title: input.title, head: input.head, base: input.base, body: input.body, draft: true },
      }),
      "created PR",
    );
    return created.number;
  }

  private repo(): string {
    return this.options.repo;
  }

  private async run(argv: string[], stdin?: string): Promise<string> {
    const result = await this.options.command.run(argv, {
      cwd: this.options.cwd,
      timeoutMs: this.timeoutMs,
      stdin,
    });
    return result.stdout;
  }

  private async json(path: string, options: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<unknown> {
    const method = options.method ?? "GET";
    const argv = ["gh", "api", "--method", method, path];
    const stdout =
      options.body === undefined
        ? await this.run(argv)
        : await this.run(
            [...argv, "-H", "Content-Type: application/json", "--input", "-"],
            JSON.stringify(options.body),
          );
    try {
      return JSON.parse(stdout) as unknown;
    } catch (error) {
      throw new ProtocolError(`non-JSON output from gh api ${path}: ${(error as Error).message}`);
    }
  }

  private text(path: string): Promise<string> {
    return this.run(["gh", "api", "--method", "GET", path]);
  }
}

function toRun(run: z.infer<typeof runSchema>): WorkflowRun {
  return {
    databaseId: run.id,
    headBranch: run.head_branch ?? "",
    headSha: run.head_sha,
    workflowName: run.name ?? "",
    event: run.event ?? "",
    status: run.status ?? "",
    conclusion: run.conclusion ?? "",
    attempt: run.run_attempt ?? 1,
    createdAt: run.created_at ?? "",
    url: run.html_url ?? "",
  };
}

function toOpenPullRequest(pull: z.infer<typeof pullSchema>): OpenPullRequest {
  return {
    number: pull.number,
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
    headRefOid: pull.head.sha,
    // A deleted fork has no head repository, which is also treated as cross-repository.
    isCrossRepository: pull.head.repo?.full_name !== pull.base.repo?.full_name,
    isDraft: pull.draft === true,
  };
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ProtocolError(`unexpected GitHub response for ${what}: ${result.error.issues[0]?.message ?? "invalid"}`);
  }
  return result.data;
}
