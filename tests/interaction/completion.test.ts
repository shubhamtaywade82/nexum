import { acceptWord, completions, ghostSuffix, isNoOpCompletion } from "../../src/interaction/completion.js";
import { builtinCommands } from "../../src/interaction/slash-commands.js";

describe("ghostSuffix", () => {
  const history = ["create filesystem tool", "create tests", "fix docker"];

  it("suggests the newest matching continuation", () => {
    expect(ghostSuffix("create", history)).toBe(" tests");
    expect(ghostSuffix("create f", history)).toBe("ilesystem tool");
    expect(ghostSuffix("zzz", history)).toBe("");
    expect(ghostSuffix("", history)).toBe("");
  });

  it("never suggests the input itself", () => {
    expect(ghostSuffix("fix docker", history)).toBe("");
  });
});

describe("acceptWord", () => {
  it("accepts one word including leading whitespace", () => {
    expect(acceptWord(" filesystem tool")).toEqual({ accepted: " filesystem", rest: " tool" });
    expect(acceptWord("tool")).toEqual({ accepted: "tool", rest: "" });
  });
});

describe("completions", () => {
  const registry = builtinCommands();

  it("offers slash commands for a / prefix", () => {
    const items = completions("/mo", registry);
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(["/model", "/models"]));
    expect(items[0].insert.startsWith("/")).toBe(true);
  });

  it("offers nothing for plain text, or after a space for free-form commands", () => {
    expect(completions("model", registry)).toEqual([]);
    expect(completions("/model qwen", registry)).toEqual([]);
  });

  it("offers historical prompt suggestions for matching words in history", () => {
    const history = ["how do I build a react app", "tell me about rails models", "run unit tests"];
    const items = completions("rails models", registry, undefined, history);
    expect(items.length).toBe(1);
    expect(items[0].kind).toBe("history");
    expect(items[0].insert).toBe("tell me about rails models");
    expect(items[0].group).toBe("History");
  });

  it("offers subcommand values for commands that declare argValues", () => {
    const modeItems = completions("/mode a", registry);
    expect(modeItems.map((i) => i.label)).toEqual(["ask", "architect", "autonomous"]);
    expect(modeItems[0].insert).toBe("/mode ask");

    expect(completions("/theme mid", registry).map((i) => i.label)).toEqual(["midnight"]);
    expect(completions("/tier c", registry).map((i) => i.label)).toEqual(["cloud"]);
  });

  it("stops completing once a second argument token starts", () => {
    expect(completions("/mode ask ", registry)).toEqual([]);
  });

  it("populates kind and group on command completions", () => {
    const items = completions("/mo", registry);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.kind).toBe("command");
      expect(item.group).toBeDefined();
    }
  });

  it("populates kind on argument completions", () => {
    const items = completions("/mode a", registry);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.kind).toBe("argument");
    }
  });

  it("command completions have meaningful group labels", () => {
    const modelItems = completions("/model", registry);
    const modelItem = modelItems.find((i) => i.label === "/model");
    expect(modelItem?.group).toBe("Model");

    const helpItems = completions("/help", registry);
    const helpItem = helpItems.find((i) => i.label === "/help");
    expect(helpItem?.group).toBe("General");
  });
});
describe("isNoOpCompletion", () => {
  const registry = builtinCommands();

  // registry.complete() matches exact names, so a fully typed zero-arg command
  // always ranks itself first. Enter used to accept that instead of
  // submitting, so /help, /clear, /resume, /model and /quit all needed two
  // presses of Enter to run. App's Enter handler checks the *selected* entry,
  // which is index 0 until the user arrows away.
  it.each(["/help", "/clear", "/resume", "/model", "/quit", "/plan"])(
    "reports the selected completion for %s as a no-op",
    (input) => {
      const items = completions(input, registry);
      expect(items.length).toBeGreaterThan(0);
      expect(isNoOpCompletion(input, items[0])).toBe(true);
    },
  );

  // "/model" is also a strict prefix of "/models", so the list is non-empty
  // even after no-op entries are discounted. Guarding only the list (and not
  // the selected entry) would leave Enter stuck on "/model" forever.
  it("keeps the no-op entry selected when a longer command shares the prefix", () => {
    const items = completions("/model", registry);
    expect(items.map((i) => i.insert)).toEqual(["/model ", "/models "]);
    expect(isNoOpCompletion("/model", items[0])).toBe(true);
    expect(isNoOpCompletion("/model", items[1])).toBe(false);
  });

  it("still treats a genuine prefix completion as actionable", () => {
    const items = completions("/mod", registry);
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => !isNoOpCompletion("/mod", i))).toBe(true);
  });

  it("treats an argument completion as actionable", () => {
    const items = completions("/mode a", registry);
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => !isNoOpCompletion("/mode a", i))).toBe(true);
  });

  it("ignores trailing whitespace, since parseSlashInput trims", () => {
    expect(isNoOpCompletion("/resume", { label: "/resume", detail: "", insert: "/resume " })).toBe(true);
    expect(isNoOpCompletion("/resume ", { label: "/resume", detail: "", insert: "/resume " })).toBe(true);
  });
});
