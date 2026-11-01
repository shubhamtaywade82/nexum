import type {
  CommandOptions,
  CommandPort,
  CommandResult,
  Logger,
} from "../../../src/domains/ci-healer/application/ports.js";
import { GitCli } from "../../../src/domains/ci-healer/adapters/git-cli.js";
import { CommandError } from "../../../src/domains/ci-healer/errors.js";

/** Replays scripted results per call. A CommandError is thrown for non-zero status, as the real runner does. */
class ScriptedCommands implements CommandPort {
  readonly calls: string[][] = [];
  constructor(private readonly script: { status: number; stderr?: string }[]) {}

  async run(argv: readonly string[], options: CommandOptions): Promise<CommandResult> {
    this.calls.push([...argv]);
    const next = this.script.length > 1 ? this.script.shift()! : this.script[0];
    if (next.status !== 0 && !options.allowFailure) {
      throw new CommandError(argv, next.status, next.stderr ?? "");
    }
    return { status: next.status, stdout: "", stderr: next.stderr ?? "" };
  }
}

const silentLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function gitWith(command: CommandPort, sleeps: number[]): GitCli {
  return new GitCli({
    command,
    repoDir: "/repo",
    author: { name: "bot", email: "bot@example.test" },
    log: silentLog,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
}

describe("GitCli retry policy", () => {
  it("retries transient fetch failures with backoff, then succeeds", async () => {
    const sleeps: number[] = [];
    const commands = new ScriptedCommands([
      { status: 128, stderr: "Could not resolve host: github.com" },
      { status: 128, stderr: "Could not resolve host: github.com" },
      { status: 0 },
    ]);
    await gitWith(commands, sleeps).fetch();
    expect(sleeps).toEqual([2000, 4000]);
    expect(commands.calls).toHaveLength(3);
  });

  it("does not retry a rejected push, which retrying cannot fix", async () => {
    const sleeps: number[] = [];
    const commands = new ScriptedCommands([{ status: 1, stderr: "! [rejected] fix (non-fast-forward)" }]);
    await expect(gitWith(commands, sleeps).push("/wt", "HEAD:refs/heads/fix")).rejects.toThrow(CommandError);
    expect(sleeps).toEqual([]);
    expect(commands.calls).toHaveLength(1);
  });

  it("does not retry a missing remote: that is configuration, not a network blip", async () => {
    const sleeps: number[] = [];
    const commands = new ScriptedCommands([
      { status: 128, stderr: "fatal: 'origin' does not appear to be a git repository" },
    ]);
    await expect(gitWith(commands, sleeps).fetch()).rejects.toThrow(CommandError);
    expect(sleeps).toEqual([]);
    expect(commands.calls).toHaveLength(1);
  });

  it("gives up once the retry budget is spent", async () => {
    const sleeps: number[] = [];
    const commands = new ScriptedCommands([{ status: 128, stderr: "Connection timed out" }]);
    await expect(gitWith(commands, sleeps).fetch()).rejects.toThrow(CommandError);
    expect(sleeps).toEqual([2000, 4000, 8000, 16000]);
  });
});
