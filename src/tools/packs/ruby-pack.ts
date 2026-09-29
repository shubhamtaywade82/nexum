/**
 * RubyPack (review item 21) — Ruby-specific tooling from the ruby domain
 * (domains/ruby/): RuboCop linting + RSpec test execution.
 */

import { RunRubocopTool } from "../../domains/ruby/rubocop-tool.js";
import { RunRSpecTool } from "../../domains/ruby/rspec-tool.js";
import { ToolPack, packOf } from "../gateway/tool-pack.js";
import type { CommandRunner } from "../command-runner.js";
import { runsSandboxed, scriptRunnerMetadata } from "./process-pack.js";

/** `runner` (e.g. the sandboxed ShellTool) executes bundle; without it commands run on the host. */
export function rubyPack(root: string, runner?: CommandRunner): ToolPack {
  return packOf(
    "ruby",
    "Ruby/Rails project tooling: RuboCop, RSpec.",
    "build",
    [new RunRubocopTool(root, runner), new RunRSpecTool(root, runner)].map((tool) => ({
      tool,
      category: "Ruby",
      metadata: scriptRunnerMetadata(runsSandboxed(runner)),
    })),
    "Ruby",
  );
}
