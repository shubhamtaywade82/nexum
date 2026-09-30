import { builtinCommands, parseSlashInput, SlashCommandRegistry } from "../../src/interaction/slash-commands.js";

describe("parseSlashInput", () => {
  it("parses name and args", () => {
    expect(parseSlashInput("/model qwen3:30b")).toEqual({ name: "model", args: "qwen3:30b" });
    expect(parseSlashInput("/help")).toEqual({ name: "help", args: "" });
    expect(parseSlashInput("not a command")).toBeNull();
    expect(parseSlashInput("/")).toBeNull();
  });
});

describe("SlashCommandRegistry", () => {
  it("finds commands by name or alias", () => {
    const registry = builtinCommands();
    expect(registry.find("help")?.name).toBe("help");
    expect(registry.find("h")?.name).toBe("help");
    expect(registry.find("compact")?.name).toBe("reset");
    expect(registry.find("resume")?.name).toBe("resume");
    expect(registry.find("continue")?.name).toBe("resume");
    expect(registry.find("nope")).toBeUndefined();
  });

  it("/resume executes to a resume-session effect", () => {
    const registry = builtinCommands();
    expect(registry.find("resume")?.execute("")).toEqual({ kind: "resume-session" });
  });

  it("/replay executes to a replay-session effect", () => {
    const registry = builtinCommands();
    expect(registry.find("replay")?.execute("sess-1")).toEqual({ kind: "replay-session", id: "sess-1" });
  });

  it("completes by prefix", () => {
    const registry = builtinCommands();
    const names = registry.complete("m").map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["mcp", "memory", "model", "models"]));
    expect(names).not.toContain("git");
  });

  it("registering the same name replaces the command", () => {
    const registry = new SlashCommandRegistry();
    registry.register({ name: "x", aliases: [], description: "one", execute: () => ({ kind: "quit" }) });
    registry.register({
      name: "x",
      aliases: [],
      description: "two",
      execute: () => ({ kind: "message", text: "hi" }),
    });
    expect(registry.all()).toHaveLength(1);
    expect(registry.find("x")?.description).toBe("two");
  });

  it("built-in effects map to the expected kinds", () => {
    const registry = builtinCommands();
    expect(registry.find("clear")!.execute("")).toEqual({ kind: "clear-conversation" });
    expect(registry.find("model")!.execute("qwen3:8b")).toEqual({ kind: "set-model", model: "qwen3:8b" });
    expect(registry.find("model")!.execute("")).toEqual({ kind: "open-overlay", overlay: "model" });
    expect(registry.find("git")!.execute("")).toEqual({ kind: "focus-view", view: "git" });
    expect(registry.find("quit")!.execute("")).toEqual({ kind: "quit" });
  });

  it("/skills with no args opens the skills overlay", () => {
    const registry = builtinCommands();
    expect(registry.find("skills")!.execute("")).toEqual({ kind: "open-overlay", overlay: "skills" });
  });

  it("/skills <id> activates that skill", () => {
    const registry = builtinCommands();
    expect(registry.find("skills")!.execute("rails-api")).toEqual({ kind: "activate-skill", id: "rails-api" });
    expect(registry.find("skills")!.execute("  rails-api  ")).toEqual({ kind: "activate-skill", id: "rails-api" });
  });

  it("/mission with task runs plan, without task focuses dashboard", () => {
    const registry = builtinCommands();
    expect(registry.find("mission")!.execute("Fix failing auth specs")).toEqual({
      kind: "run-plan",
      goal: "Fix failing auth specs",
    });
    expect(registry.find("mission")!.execute("")).toEqual({ kind: "focus-view", view: "dashboard" });
  });

  it("/pr creates a pull request message", () => {
    const registry = builtinCommands();
    expect(registry.find("pr")!.execute("fix: auth token expiration")).toEqual({
      kind: "message",
      text: "Create a pull request: fix: auth token expiration",
    });
    expect(registry.find("pr")!.execute("")).toEqual({
      kind: "message",
      text: "Create a pull request for the current branch and verified changes",
    });
  });

  it("registry.complete includes skills", () => {
    const registry = builtinCommands();
    expect(registry.complete("sk").map((c) => c.name)).toContain("skills");
  });

  it("/evolve executes to evolve command effects", () => {
    const registry = builtinCommands();
    expect(registry.find("evolve")!.execute("")).toEqual({ kind: "evolve", action: "history" });
    expect(registry.find("evolve")!.execute("diagnose")).toEqual({ kind: "evolve", action: "diagnose" });
    expect(registry.find("evolve")!.execute("benchmark")).toEqual({ kind: "evolve", action: "benchmark" });
    expect(registry.find("evolve")!.execute("rollback H0")).toEqual({
      kind: "evolve",
      action: "rollback",
      target: "H0",
    });
    expect(registry.find("evolve")!.execute("rollback")).toEqual({
      kind: "error",
      text: "Usage: /evolve rollback <id>",
    });
  });

  it("registry.complete includes evolve", () => {
    const registry = builtinCommands();
    expect(registry.complete("ev").map((c) => c.name)).toContain("evolve");
  });
});

describe("/capabilities", () => {
  it("shows by default, fixes on request, and rejects unknown actions", () => {
    const cmd = builtinCommands().find("capabilities");
    expect(cmd?.execute("")).toEqual({ kind: "capabilities", action: "show" });
    expect(cmd?.execute("fix")).toEqual({ kind: "capabilities", action: "fix" });
    expect(cmd?.execute("bogus")).toEqual({ kind: "error", text: "Usage: /capabilities [fix]" });
    expect(builtinCommands().find("caps")?.name).toBe("capabilities");
  });
});
