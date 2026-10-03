import { createLibrary, defineComponent } from "@openuidev/lang-core";
import { z } from "zod";
import {
  OPENUI_SCHEMA_VERSION,
  isPresentationSupported,
  presentOutput,
  presentationInstructions,
} from "../../src/host/presentation.js";
import type { PresentationRequest } from "../../src/protocol/types.js";

const component = (name: string, props: z.ZodObject<z.ZodRawShape>) =>
  defineComponent({ name, description: name, props, component: null as never });

const library = createLibrary({
  root: "Stack",
  components: [
    component("Stack", z.object({ gap: z.enum(["sm", "md"]).optional(), children: z.array(z.unknown()).optional() })),
    component("Metric", z.object({ label: z.string(), value: z.string() })),
  ],
});

function request(mode: PresentationRequest["mode"], offer = true): PresentationRequest {
  return {
    mode,
    openui: offer
      ? { schemaVersion: OPENUI_SCHEMA_VERSION, spec: "SPEC-TEXT", schema: library.toJSONSchema() as never }
      : undefined,
  };
}

const VALID = 'root = Stack("md", [Metric("Users", "120")])';

describe("presentOutput", () => {
  it("should label a valid OpenUI program as openui", () => {
    expect(presentOutput(VALID, request("auto"))).toEqual({
      format: "openui",
      content: VALID,
      schemaVersion: OPENUI_SCHEMA_VERSION,
    });
  });

  it("should accept a program inside a code fence and return it unfenced", () => {
    const fenced = "```openui-lang\n" + VALID + "\n```";

    expect(presentOutput(fenced, request("openui"))).toMatchObject({ format: "openui", content: VALID });
  });

  it.each([
    ["an unknown component", 'root = Stack("md", [Gauge("x")])'],
    ["a wrong argument type", 'root = Stack("md", [Metric("Users", 120)])'],
    ["a missing required argument", 'root = Stack("md", [Metric("Users")])'],
    ["an invalid enum value", 'root = Stack("huge", [])'],
    ["an unfinished program", 'root = Stack("md", [Metric("a", "1")'],
    ["named arguments written with =", 'root = Stack(gap = "md", children = [])'],
  ])("should fall back to markdown for %s, keeping the text", (_name, content) => {
    expect(presentOutput(content, request("openui"))).toEqual({ format: "markdown", content });
  });

  it("should not hide prose by rendering only the program it contains", () => {
    const content = "Here is the status:\n\n" + VALID + "\n\nLet me know if you need more.";

    expect(presentOutput(content, request("auto"))).toEqual({ format: "markdown", content });
  });

  it("should leave an ordinary answer as markdown", () => {
    const content = "The capital of France is **Paris**.";

    expect(presentOutput(content, request("auto"))).toEqual({ format: "markdown", content });
  });

  it("should never produce openui when markdown was requested or no library was offered", () => {
    expect(presentOutput(VALID, request("markdown")).format).toBe("markdown");
    expect(presentOutput(VALID, request("auto", false)).format).toBe("markdown");
  });

  it("should fall back instead of trusting the model when the schema is unusable", () => {
    const broken: PresentationRequest = {
      mode: "openui",
      openui: { schemaVersion: OPENUI_SCHEMA_VERSION, spec: "s", schema: { nonsense: true } },
    };

    expect(presentOutput(VALID, broken)).toEqual({ format: "markdown", content: VALID });
  });
});

describe("presentationInstructions", () => {
  it("should inject nothing for markdown or when no library was offered", () => {
    expect(presentationInstructions(request("markdown"))).toBe("");
    expect(presentationInstructions(request("auto", false))).toBe("");
  });

  it("should let the model choose in auto mode", () => {
    const text = presentationInstructions(request("auto"));

    expect(text).toContain("SPEC-TEXT");
    expect(text).toContain("Otherwise (explanations, code, prose), reply in plain Markdown");
  });

  it("should require OpenUI in openui mode", () => {
    const text = presentationInstructions(request("openui"));

    expect(text).toContain("SPEC-TEXT");
    expect(text).toContain("Reply with OpenUI Lang only");
    expect(text).not.toContain("reply in plain Markdown");
  });
});

describe("isPresentationSupported", () => {
  it("should reject an OpenUI version the server cannot validate, unless markdown was requested", () => {
    const offer = (mode: PresentationRequest["mode"]): PresentationRequest => ({
      mode,
      openui: { schemaVersion: "9.9.9", spec: "s", schema: {} },
    });

    expect(isPresentationSupported(offer("auto"))).toBe(false);
    expect(isPresentationSupported(offer("openui"))).toBe(false);
    expect(isPresentationSupported(offer("markdown"))).toBe(true);
    expect(isPresentationSupported(request("auto"))).toBe(true);
  });
});
