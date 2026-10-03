import { execFileSync, spawn } from "node:child_process";
import { Tool } from "./tool.js";

const ALLOWED_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "branch",
  "add",
  "commit",
  "checkout",
  "stash",
  "show",
  "blame",
  "rev-parse",
  "cherry-pick",
  "pull",
  "push",
]);

const DISALLOWED_FLAG_PATTERNS = [/^--hard$/, /^--force$/, /^-f$/, /^-D$/, /^--force-with-lease$/, /^\+.*$/];
const PROTECTED_BRANCHES = new Set(["main", "master", "develop", "prod", "production"]);

function isProtectedBranchTarget(args: string[]): boolean {
  return args.some((a) => {
    // a refspec's destination is what gets updated: HEAD:main pushes to main
    const dest = (a.split(":").pop() ?? a).replace(/^refs\/heads\//, "");
    return PROTECTED_BRANCHES.has(dest) || dest.startsWith("release/");
  });
}

/**
 * Options that turn git into a host-escape primitive: they run commands,
 * write to arbitrary paths, read arbitrary files (and echo them back), or
 * redirect a push/pull to an arbitrary repository. Git accepts any unique
 * prefix of a long option, so prefixes are matched too.
 */
const HOST_ESCAPE_OPTIONS: Record<string, string> = {
  "--output": "writes to an arbitrary host path",
  "--upload-pack": "runs a host command",
  "--receive-pack": "runs a host command",
  "--exec": "runs a host command",
  "--repo": "pushes to an arbitrary repository",
  "--no-index": "reads files outside the repository",
  "--contents": "reads an arbitrary host file",
  "--ignore-revs-file": "reads an arbitrary host file",
  "--file": "reads an arbitrary host file",
  "--template": "reads an arbitrary host file",
  "--pathspec-from-file": "reads an arbitrary host file",
  "--orderfile": "reads an arbitrary host file",
};

/** Short options with the same effect, per subcommand (matched anywhere in a short-flag cluster). */
const HOST_ESCAPE_SHORT: Record<string, RegExp> = {
  commit: /^-[A-Za-z]*[Ft]/,
  blame: /^-[A-Za-z]*S/,
  diff: /^-O/,
  log: /^-O/,
  show: /^-O/,
};

/** push/pull options whose value is a separate argument (so it is not mistaken for the remote). */
const VALUE_OPTIONS = new Set([
  "-o",
  "--push-option",
  "--server-option",
  "--depth",
  "--deepen",
  "--shallow-since",
  "--shallow-exclude",
  "-s",
  "--strategy",
  "-X",
  "--strategy-option",
  "--negotiation-tip",
  "-j",
  "--jobs",
]);

function hostEscape(subcommand: string, args: string[]): string | null {
  for (const arg of args) {
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const name = arg.split("=")[0];
      if (name.length < 3) continue;
      for (const [option, why] of Object.entries(HOST_ESCAPE_OPTIONS)) {
        if (option.startsWith(name)) return `${arg} is blocked: ${option} ${why}`;
      }
    } else if (HOST_ESCAPE_SHORT[subcommand]?.test(arg)) {
      return `${arg} is blocked for git ${subcommand}: it reads or writes files outside the repository`;
    }
  }
  return null;
}

/** First positional argument of push/pull (the remote), skipping option values. */
function remoteArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return args[i + 1];
    if (arg.startsWith("-")) {
      if (VALUE_OPTIONS.has(arg)) i++;
      continue;
    }
    return arg;
  }
  return undefined;
}

function configuredRemotes(root: string): Set<string> {
  try {
    const out = execFileSync("git", ["remote"], { cwd: root, encoding: "utf8", timeout: 10_000 });
    return new Set(
      out
        .split("\n")
        .map((r) => r.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/** Same ceiling and rationale as ShellTool.MAX_OUTPUT_BYTES: this output goes
 * straight back to the model as a tool message. `git log` or `git diff` on a
 * large repo previously accumulated unbounded into memory and then into the
 * context window. */
const MAX_OUTPUT_BYTES = 32 * 1024;

export class GitTool extends Tool {
  constructor(private readonly root: string) {
    super();
  }

  get name(): string {
    return "git";
  }

  get description(): string {
    return "Run a git subcommand (status, diff, log, branch, add, commit, checkout, stash, show, blame, rev-parse, cherry-pick, pull, push). Force operations and pushing to main/master are blocked; push/pull only to configured remotes; options that read or write files outside the repo (--output, --no-index, -F, …) or run commands (--upload-pack, --exec) are blocked. Push working feature branches and open PRs.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { args: { type: "array", items: { type: "string" } } },
      required: ["args"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const gitArgs = args.args as string[];
    if (!Array.isArray(gitArgs) || gitArgs.length === 0) {
      return { error: "ArgumentError", message: "args must be a non-empty string array" };
    }

    const subcommand = gitArgs[0];
    if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
      return { error: "DisallowedGitCommandError", message: `git ${subcommand} is not on the allowlist` };
    }
    if (gitArgs.some((a) => DISALLOWED_FLAG_PATTERNS.some((p) => p.test(a)))) {
      return {
        error: "DisallowedGitCommandError",
        message: `flags in [${gitArgs.join(" ")}] are blocked (force/hard operations)`,
      };
    }
    const escape = hostEscape(subcommand, gitArgs.slice(1));
    if (escape) {
      return { error: "DisallowedGitCommandError", message: escape };
    }
    if (subcommand === "push" && isProtectedBranchTarget(gitArgs.slice(1))) {
      return {
        error: "DisallowedGitCommandError",
        message: `pushing directly to protected branches (main/master/develop) is blocked; push to a feature branch instead`,
      };
    }
    if (subcommand === "push" || subcommand === "pull") {
      const remote = remoteArg(gitArgs.slice(1));
      if (remote !== undefined && !configuredRemotes(this.root).has(remote)) {
        return {
          error: "DisallowedGitCommandError",
          message: `git ${subcommand} only targets configured remotes (see \`git remote\`); "${remote}" is not one`,
        };
      }
    }

    return new Promise((resolvePromise) => {
      const child = spawn("git", gitArgs, { cwd: this.root });
      // Buffers, decoded once at the end: concatenating per-chunk toString()
      // corrupts multi-byte characters split across a chunk boundary, which
      // shows up as mojibake in diffs and commit messages.
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      child.stdout.on("data", (c: Buffer) => {
        if (stdout.byteLength < MAX_OUTPUT_BYTES) stdout = Buffer.concat([stdout, c]);
      });
      child.stderr.on("data", (c: Buffer) => {
        if (stderr.byteLength < MAX_OUTPUT_BYTES) stderr = Buffer.concat([stderr, c]);
      });
      child.on("close", (exitCode) => {
        const truncated = stdout.byteLength > MAX_OUTPUT_BYTES || stderr.byteLength > MAX_OUTPUT_BYTES;
        resolvePromise({
          command: `git ${gitArgs.join(" ")}`,
          exitCode: exitCode ?? -1,
          stdout: stdout.subarray(0, MAX_OUTPUT_BYTES).toString("utf-8"),
          stderr: stderr.subarray(0, MAX_OUTPUT_BYTES).toString("utf-8"),
          truncated,
        });
      });
      child.on("error", (err) => {
        resolvePromise({ command: `git ${gitArgs.join(" ")}`, exitCode: -1, stdout: "", stderr: err.message });
      });
    });
  }
}

const READ_ONLY_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "blame", "rev-parse"]);
// These subcommands can hand content to a program named in repo-local git config.
const PROGRAM_RUNNING_SUBCOMMANDS = new Set(["diff", "log", "show"]);
const PROGRAM_FLAG = /^(--ext-diff|--textconv|--open-files-in-pager(=.*)?|-O.*)$/;

/**
 * The inspection-only slice of `git`: it can read the repository but not change it, so it can be
 * offered where `git` itself cannot (e.g. directly to a rendered UI). Repo-local config can name a
 * program to run on diff output (diff.external, textconv drivers); those are switched off here. The
 * switches go after the caller's arguments, because the last occurrence of a flag wins and git also
 * accepts abbreviated long options that a denylist would miss.
 */
export class GitReadTool extends GitTool {
  get name(): string {
    return "git_read";
  }

  get description(): string {
    return "Inspect the repository with a read-only git subcommand (status, diff, log, show, blame, rev-parse). It cannot change anything; use `git` to add, commit, branch or push.";
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const gitArgs = args.args;
    const subcommand = Array.isArray(gitArgs) ? gitArgs[0] : undefined;
    if (typeof subcommand !== "string" || !READ_ONLY_SUBCOMMANDS.has(subcommand)) {
      return {
        error: "DisallowedGitCommandError",
        message: `git_read only runs: ${[...READ_ONLY_SUBCOMMANDS].join(", ")}`,
      };
    }
    const rest = (gitArgs as string[]).slice(1);
    if (rest.some((a) => PROGRAM_FLAG.test(a))) {
      return { error: "DisallowedGitCommandError", message: "flags that run external programs are blocked" };
    }
    if (!PROGRAM_RUNNING_SUBCOMMANDS.has(subcommand)) return super.call({ ...args, args: [subcommand, ...rest] });

    const pathsStart = rest.indexOf("--");
    const options = pathsStart === -1 ? rest : rest.slice(0, pathsStart);
    const paths = pathsStart === -1 ? [] : rest.slice(pathsStart);
    return super.call({ ...args, args: [subcommand, ...options, "--no-ext-diff", "--no-textconv", ...paths] });
  }
}
