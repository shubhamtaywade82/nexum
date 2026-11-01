import { z } from "zod";
import type { CommandPort, GitHubPort } from "../application/ports.js";
import type { OpenPullRequest, PullRequestState, WorkflowRun } from "../domain/types.js";
import { ProtocolError } from "../errors.js";

const RUN_FIELDS = "databaseId,headBranch,headSha,workflowName,event,status,conclusion,attempt,createdAt,url";
const PR_LIST_FIELDS = "number,headRefName,baseRefName,headRefOid,isCrossRepository,isDraft";
const PR_VIEW_FIELDS = "number,state,headRefOid";

const runSchema = z.object({
  databaseId: z.number().int(),
  headBranch: z.string(),
  headSha: z.string(),
  workflowName: z
    .string()
    .nullish()
    .transform((value) => value ?? ""),
  event: z
    .string()
    .nullish()
    .transform((value) => value ?? ""),
  status: z.string(),
  conclusion: z
    .string()
    .nullish()
    .transform((value) => value ?? ""),
  attempt: z
    .number()
    .int()
    .nullish()
    .transform((value) => value ?? 1),
  createdAt: z
    .string()
    .nullish()
    .transform((value) => value ?? ""),
  url: z
    .string()
    .nullish()
    .transform((value) => value ?? ""),
});

const openPrSchema = z.object({
  number: z.number().int(),
  headRefName: z.string(),
  baseRefName: z.string(),
  headRefOid: z.string(),
  isCrossRepository: z.boolean(),
  isDraft: z.boolean(),
});

const prStateSchema = z.object({
  number: z.number().int(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  headRefOid: z.string(),
});

const defaultBranchSchema = z.object({
  defaultBranchRef: z.object({ name: z.string() }),
});

export interface GitHubCliOptions {
  command: CommandPort;
  /** owner/name */
  repo: string;
  cwd: string;
  timeoutMs?: number;
}

/**
 * GitHub access through the gh CLI, which holds the operator's credentials. Every
 * response is validated against a schema, so a changed gh output fails loudly as a
 * ProtocolError rather than being guessed at.
 */
export class GitHubCli implements GitHubPort {
  private readonly timeoutMs: number;

  constructor(private readonly options: GitHubCliOptions) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async defaultBranch(): Promise<string> {
    const data = parse(
      defaultBranchSchema,
      await this.json(["gh", "repo", "view", this.repo(), "--json", "defaultBranchRef"]),
      "default branch",
    );
    return data.defaultBranchRef.name;
  }

  async runsForBranch(branch: string, limit = 30): Promise<WorkflowRun[]> {
    const data = await this.json([
      "gh",
      "run",
      "list",
      "-R",
      this.repo(),
      "--branch",
      branch,
      "--limit",
      String(limit),
      "--json",
      RUN_FIELDS,
    ]);
    return parse(z.array(runSchema), data, `runs on ${branch}`);
  }

  async openPullRequests(): Promise<OpenPullRequest[]> {
    const data = await this.json([
      "gh",
      "pr",
      "list",
      "-R",
      this.repo(),
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      PR_LIST_FIELDS,
    ]);
    return parse(z.array(openPrSchema), data, "open PRs");
  }

  async pullRequest(number: number): Promise<PullRequestState> {
    const data = await this.json(["gh", "pr", "view", String(number), "-R", this.repo(), "--json", PR_VIEW_FIELDS]);
    return parse(prStateSchema, data, `PR #${number}`);
  }

  async failedLog(runId: number): Promise<string> {
    const result = await this.run(["gh", "run", "view", String(runId), "-R", this.repo(), "--log-failed"]);
    return result.stdout;
  }

  async createDraftPullRequest(input: { base: string; head: string; title: string; body: string }): Promise<number> {
    const result = await this.run(
      [
        "gh",
        "pr",
        "create",
        "-R",
        this.repo(),
        "--draft",
        "--base",
        input.base,
        "--head",
        input.head,
        "--title",
        input.title,
        "--body-file",
        "-",
      ],
      input.body,
    );
    const url = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .reverse()
      .find((line) => /\/pull\/\d+$/.test(line));
    if (!url) throw new ProtocolError(`gh pr create printed no PR URL: ${result.stdout.trim().slice(0, 200)}`);
    return Number(/\/pull\/(\d+)$/.exec(url)?.[1]);
  }

  private repo(): string {
    return this.options.repo;
  }

  private async run(argv: string[], stdin?: string) {
    return this.options.command.run(argv, { cwd: this.options.cwd, timeoutMs: this.timeoutMs, stdin });
  }

  private async json(argv: string[]): Promise<unknown> {
    const result = await this.run(argv);
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch (error) {
      throw new ProtocolError(`non-JSON output from ${argv.slice(0, 3).join(" ")}: ${(error as Error).message}`);
    }
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ProtocolError(`unexpected gh response for ${what}: ${result.error.issues[0]?.message ?? "invalid"}`);
  }
  return result.data;
}
