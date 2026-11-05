import { spawn } from "node:child_process";
import { Tool } from "./tool.js";
import { agentWorkspaceGuard } from "./path-utils.js";
import type { WorkspaceGuard } from "../core/fs/workspace-guard.js";

/**
 * `gh` runs on the host with the user's GitHub token, so this tool is an
 * allowlist per subcommand verb rather than a verb blocklist:
 *   - read verbs everywhere; writes limited to creating/commenting/editing
 *     issues and PRs (no merge, close, delete, approve, release publishing,
 *     repo create/fork/clone/edit/archive, run/release downloads);
 *   - `gh api` is read-only: GET/HEAD, no request body (fields/--input make
 *     it a write), no graphql (always POST), no other hosts;
 *   - body/template files must be workspace files the guard lets the agent
 *     read (never secrets or paths outside the workspace).
 */
const VERBS: Record<string, ReadonlySet<string>> = {
  pr: new Set(["list", "view", "diff", "checks", "status", "create", "comment", "edit", "review", "ready"]),
  issue: new Set(["list", "view", "status", "create", "comment", "edit"]),
  release: new Set(["list", "view"]),
  repo: new Set(["view"]),
  run: new Set(["list", "view", "rerun"]),
};

/** Flags whose value is a file gh reads and sends to GitHub. */
const FILE_FLAGS = new Set(["--body-file", "-F", "--template", "-T"]);

/** Per "subcommand verb": flags that turn an allowed verb into something the tool must not do unattended. */
const BLOCKED_FLAGS: Record<string, Record<string, string>> = {
  "pr review": {
    "--approve": "approving pull requests is left to humans",
    "-a": "approving pull requests is left to humans",
  },
};

const API_VALUE_FLAGS = new Set([
  "-X",
  "--method",
  "-H",
  "--header",
  "-q",
  "--jq",
  "-t",
  "--template",
  "-p",
  "--preview",
  "--cache",
]);
const API_BOOL_FLAGS = new Set(["--paginate", "--slurp", "-i", "--include", "--silent"]);
const API_HEADERS = new Set(["accept", "x-github-api-version"]);

type Plan = { ok: true } | { ok: false; message: string };

export class GitHubTool extends Tool {
  private readonly guard: WorkspaceGuard;

  constructor(private readonly root: string) {
    super();
    this.guard = agentWorkspaceGuard(root);
  }

  get name(): string {
    return "github";
  }

  get description(): string {
    return (
      "Run a `gh` (GitHub CLI) subcommand. Allowed: pr list/view/diff/checks/status/create/comment/edit/review/ready, " +
      "issue list/view/status/create/comment/edit, release list/view, repo view, run list/view/rerun, and read-only " +
      "`gh api` (GET, no fields). Merging, closing, deleting, approving, publishing releases and repo changes are " +
      "left to the user. --body-file must be a workspace file."
    );
  }

  get tags(): string[] {
    return ["github", "git", "pr", "issue"];
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { args: { type: "array", items: { type: "string" } } },
      required: ["args"],
    };
  }

  /** Validate a gh invocation without running it. */
  plan(ghArgs: string[]): Plan {
    const [subcommand, ...rest] = ghArgs;
    if (subcommand === "api") return this.planApi(rest);
    const verbs = VERBS[subcommand];
    if (!verbs) {
      return {
        ok: false,
        message: `gh ${subcommand} is not on the allowlist (${[...Object.keys(VERBS), "api"].join(", ")})`,
      };
    }
    const verb = rest[0];
    if (!verb || !verbs.has(verb)) {
      return {
        ok: false,
        message: `gh ${subcommand} ${verb ?? ""} is not allowed (allowed: ${[...verbs].join(", ")})`,
      };
    }
    const blocked = BLOCKED_FLAGS[`${subcommand} ${verb}`] ?? {};
    for (let i = 1; i < rest.length; i++) {
      const arg = rest[i];
      let name = arg;
      let inline: string | undefined;
      if (arg.startsWith("--") && arg.includes("=")) {
        name = arg.slice(0, arg.indexOf("="));
        inline = arg.slice(arg.indexOf("=") + 1);
      } else if (/^-[A-Za-z]./.test(arg) && FILE_FLAGS.has(arg.slice(0, 2))) {
        // stuck short form: -F/path/to/file
        name = arg.slice(0, 2);
        inline = arg.slice(2).replace(/^=/, "");
      }
      if (blocked[name]) return { ok: false, message: `gh ${subcommand} ${verb} ${name}: ${blocked[name]}` };
      if (FILE_FLAGS.has(name)) {
        const file = inline ?? rest[++i];
        if (file === undefined || file === "-") return { ok: false, message: `${name} needs a workspace file path` };
        const verdict = this.guard.check("read", file);
        if (!verdict.allowed) return { ok: false, message: `${name} ${file}: ${verdict.message}` };
      }
    }
    return { ok: true };
  }

  private planApi(args: string[]): Plan {
    const positionals: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (!arg.startsWith("-")) {
        positionals.push(arg);
        continue;
      }
      let name = arg;
      let value: string | undefined;
      if (arg.startsWith("--") && arg.includes("=")) {
        name = arg.slice(0, arg.indexOf("="));
        value = arg.slice(arg.indexOf("=") + 1);
      } else if (!arg.startsWith("--") && arg.length > 2) {
        name = arg.slice(0, 2);
        value = arg.slice(2);
      }
      if (API_BOOL_FLAGS.has(name) && value === undefined) continue;
      if (!API_VALUE_FLAGS.has(name)) {
        return {
          ok: false,
          message: `gh api ${name} is not allowed: the tool only issues read-only GET requests (no fields, --input, hostname or verbose output)`,
        };
      }
      value ??= args[++i];
      if (value === undefined) return { ok: false, message: `gh api ${name} needs a value` };
      if ((name === "-X" || name === "--method") && !/^(GET|HEAD)$/i.test(value)) {
        return { ok: false, message: `gh api --method ${value}: only GET and HEAD are allowed` };
      }
      if ((name === "-H" || name === "--header") && !API_HEADERS.has(value.split(":")[0].trim().toLowerCase())) {
        return {
          ok: false,
          message: `gh api header "${value.split(":")[0]}": only Accept and X-GitHub-Api-Version are allowed`,
        };
      }
    }
    const endpoint = positionals[0];
    if (!endpoint) return { ok: false, message: "gh api: missing endpoint" };
    if (positionals.length > 1) return { ok: false, message: "gh api: exactly one endpoint expected" };
    if (endpoint === "graphql") return { ok: false, message: "gh api graphql is not allowed (always a POST)" };
    if (endpoint.includes("://"))
      return { ok: false, message: "gh api: pass a path on the configured host, not a URL" };
    return { ok: true };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ghArgs = args.args as string[];
    if (!Array.isArray(ghArgs) || ghArgs.length === 0 || ghArgs.some((a) => typeof a !== "string")) {
      return { error: "ArgumentError", message: "args must be a non-empty string array" };
    }
    const plan = this.plan(ghArgs);
    if (!plan.ok) return { error: "DisallowedGitHubCommandError", message: plan.message };

    return new Promise((resolvePromise) => {
      const child = spawn("gh", ghArgs, { cwd: this.root });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("close", (exitCode) => {
        resolvePromise({ command: `gh ${ghArgs.join(" ")}`, exitCode: exitCode ?? -1, stdout, stderr });
      });
      child.on("error", (err) => {
        resolvePromise({ command: `gh ${ghArgs.join(" ")}`, exitCode: -1, stdout: "", stderr: err.message });
      });
    });
  }
}
