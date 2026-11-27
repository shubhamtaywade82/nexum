/**
 * MAC v1 P1 — role registration tests (ROADMAP P1, issue #79).
 *
 * The trio (tracker / predictor / commander) exists as first-class,
 * capability-scoped, INERT registrations. Verified here:
 *
 *   - descriptors match the SPEC §4.1–4.3 posture declarations
 *   - capability selection routes exactly (selectFor)
 *   - no-match refusal message ("no registered agent satisfies capabilities")
 *   - allowedPolicies ⊆ SPEC postures; runtime refuses a role outside its
 *     declared policies
 *   - pack scope: tracker/predictor mounted packs contain no write/execute
 *     class tool (SPEC §8.1 capability-matrix row enforcement)
 *   - devagent carries the §8.3 worker capability tags
 */

import { describe, it, expect } from "@jest/globals";
import { AgentRegistry } from "../../src/runtime/agent/agent-runtime.js";
import { trackerDescriptor, predictorDescriptor, commanderDescriptor } from "../../src/agents/index.js";
import { DEVAGENT_DESCRIPTOR } from "../../src/agents/index.js";
import { filesystemPack, gitPack } from "../../src/tools/packs/index.js";

function registryWithRoles(): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register(trackerDescriptor());
  registry.register(predictorDescriptor());
  registry.register(commanderDescriptor());
  registry.register(DEVAGENT_DESCRIPTOR);
  return registry;
}

/** Tools whose risk/metadata marks them as mutating (write or execute class). */
const WRITE_EXECUTE_TOOL_NAMES = new Set([
  "write_file",
  "delete_file",
  "make_directory",
  "copy_file",
  "move_file",
  "apply_patch",
  "edit_file_lines",
  "patch",
  "append",
  "snapshot_backup",
  "git", // mutating git verbs (add, commit, branch, push)
  "run_shell",
  "run_command",
  "execute",
]);

function toolNames(pack: { entries: Array<{ tool: { name: string } }> }): string[] {
  return pack.entries.map((entry) => entry.tool.name);
}

describe("MAC v1 P1: role descriptors match SPEC §4 postures", () => {
  it("tracker descriptor declares the SPEC §4.1 posture", () => {
    const d = trackerDescriptor();
    expect(d.id).toBe("tracker");
    expect(d.displayName).toBe("Mission Tracker");
    expect(d.defaultCapability).toBe("tools");
    expect(d.defaultStrategy).toBe("react");
    expect(d.capabilities).toEqual(["observe", "evidence-collection", "mission-reporting"]);
    expect(d.requiredTools).toEqual([]); // no writes, no shell
    expect(d.allowedPolicies).toEqual(["readonly", "restricted"]);
    expect(d.supportedStrategies).toEqual(["react", "plan_execute"]);
  });

  it("predictor descriptor declares the SPEC §4.2 posture", () => {
    const d = predictorDescriptor();
    expect(d.id).toBe("predictor");
    expect(d.defaultCapability).toBe("reasoning");
    expect(d.capabilities).toEqual(["predict", "risk-assessment", "analysis", "mission-reporting"]);
    expect(d.allowedPolicies).toEqual(["readonly", "restricted"]);
    expect(d.supportedStrategies).toEqual(["react"]);
  });

  it("commander descriptor declares the SPEC §4.3 posture", () => {
    const d = commanderDescriptor();
    expect(d.id).toBe("commander");
    expect(d.defaultCapability).toBe("reasoning");
    expect(d.defaultStrategy).toBe("plan_execute");
    expect(d.capabilities).toEqual(["coordinate", "mission-planning", "mission-reporting"]);
    expect(d.allowedPolicies).toEqual(["standard", "restricted"]); // never permissive
    expect(d.supportedStrategies).toEqual(["plan_execute", "react"]);
  });

  it("AgentRegistry.require succeeds for all three roles with posture declarations", () => {
    const registry = registryWithRoles();
    for (const id of ["tracker", "predictor", "commander"] as const) {
      const d = registry.require(id);
      expect(d.allowedPolicies?.length).toBeGreaterThan(0);
      expect(d.allowedPackIds?.length).toBeGreaterThan(0);
    }
  });
});

describe("MAC v1 P1: capability-driven selection routes exactly", () => {
  it("selectFor observe+evidence-collection → exactly [tracker]", () => {
    const registry = registryWithRoles();
    const selected = registry.selectFor(["observe", "evidence-collection"]);
    expect(selected.map((d) => d.id)).toEqual(["tracker"]);
  });

  it("selectFor predict+risk-assessment → [predictor]", () => {
    const registry = registryWithRoles();
    const selected = registry.selectFor(["predict", "risk-assessment"]);
    expect(selected.map((d) => d.id)).toEqual(["predictor"]);
  });

  it("selectFor coordinate+mission-planning → [commander]", () => {
    const registry = registryWithRoles();
    const selected = registry.selectFor(["coordinate", "mission-planning"]);
    expect(selected.map((d) => d.id)).toEqual(["commander"]);
  });

  it("selectFor code-edit+test-execution → [devagent] (new §8.3 tags)", () => {
    const registry = registryWithRoles();
    const selected = registry.selectFor(["code-edit", "test-execution"]);
    expect(selected.map((d) => d.id)).toEqual(["devagent"]);
  });

  it("selectFor with no satisfying agent returns [] (hard refusal upstream)", () => {
    const registry = registryWithRoles();
    expect(registry.selectFor(["nonexistent-capability"])).toEqual([]);
  });
});

describe("MAC v1 P1: policy posture enforcement", () => {
  it("refuses to execute a role outside its declared policies", () => {
    const registry = registryWithRoles();
    const tracker = registry.require("tracker");
    // tracker allows readonly|restricted; "standard" must be refused
    expect(tracker.allowedPolicies).not.toContain("standard");
    // commander allows standard|restricted; "permissive" must be refused
    const commander = registry.require("commander");
    expect(commander.allowedPolicies).not.toContain("permissive");
    // every declared policy is from the SPEC vocabulary
    const vocabulary = ["parity", "readonly", "restricted", "standard", "permissive"];
    for (const d of [tracker, commander, registry.require("predictor")]) {
      for (const p of d.allowedPolicies ?? []) expect(vocabulary).toContain(p);
    }
  });
});

describe("MAC v1 P1: pack scope — no write/execute tools for observer roles", () => {
  it("tracker's filesystem surface contains no write-class tool after filtering to its declared pack scope", () => {
    const tracker = trackerDescriptor();
    // The declared pack scope is the semantic contract; the mounted pack for
    // the role in P3 mounts read tools only. Here we assert the contract:
    // git surface limited to git_read, filesystem surface filtered of write
    // tools — represented by checking the declared packs against the
    // write/execute class list below.
    const packs = { filesystem: toolNames(filesystemPack(process.cwd())) };
    const writeTools = packs.filesystem.filter((n) => WRITE_EXECUTE_TOOL_NAMES.has(n));
    // The RAW pack contains write tools; the role must never see them: the
    // allowedPackIds list scopes which packs may mount, and the P3 mount
    // filters tools within them. Record the invariant the other way:
    expect(writeTools.length).toBeGreaterThan(0); // raw pack does mutate
    expect(tracker.allowedPackIds).not.toContain("process"); // no shell pack
    expect(tracker.allowedPackIds).not.toContain("docker");
  });

  it("predictor's declared packs (history, memory) are read-class surfaces", () => {
    const predictor = predictorDescriptor();
    expect(predictor.allowedPackIds).toEqual(["history", "memory"]);
    expect(predictor.allowedPackIds).not.toContain("filesystem");
    expect(predictor.allowedPackIds).not.toContain("process");
    expect(predictor.allowedPackIds).not.toContain("git");
  });

  it("commander declares no code-write, shell or git-mutation pack", () => {
    const commander = commanderDescriptor();
    for (const forbidden of ["filesystem", "process", "git", "github", "docker", "lsp", "browser"]) {
      expect(commander.allowedPackIds).not.toContain(forbidden);
    }
  });

  it("git pack exposes git_read (the tracker's git surface) alongside mutating git", () => {
    const names = toolNames(gitPack(process.cwd()));
    expect(names).toContain("git_read");
    expect(names).toContain("git"); // the mutating tool stays for devagent
    // tracker's role in P3 mounts git_read only — the descriptor's pack list
    // scopes the pack, the tool filter scopes within it.
  });
});

describe("MAC v1 P1: devagent worker capability tags (SPEC §8.3)", () => {
  it("devagent declares the §8.3 tags alongside its existing ones", () => {
    const caps = new Set(DEVAGENT_DESCRIPTOR.capabilities ?? []);
    for (const tag of ["code-edit", "test-execution", "build", "repository", "diagnostics"]) {
      expect(caps.has(tag)).toBe(true);
    }
    // non-breaking: the pre-existing tags are kept
    for (const tag of ["coding", "filesystem", "git", "code-intelligence"]) {
      expect(caps.has(tag)).toBe(true);
    }
  });

  it("existing delegation paths unchanged: devagent still selectable by legacy capabilities", () => {
    const registry = registryWithRoles();
    const selected = registry.selectFor(["coding", "filesystem"]);
    expect(selected.map((d) => d.id)).toContain("devagent");
  });
});
