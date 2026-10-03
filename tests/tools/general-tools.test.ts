import { CalculatorTool, WeatherTool, WebSearchTool, evaluateExpression } from "../../src/tools/general-tools.js";
import { generalPack } from "../../src/tools/packs/general-pack.js";
import { ToolCatalog } from "../../src/tools/gateway/tool-catalog.js";
import { mountToolPack } from "../../src/tools/gateway/tool-pack.js";
import { AgentToolManager } from "../../src/cli/agent-tools.js";
import { isUiInvocable } from "../../src/host/ui-tools.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function mockFetchJson(...bodies: unknown[]): jest.Mock {
  const mock = jest.fn();
  for (const body of bodies) mock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
  (globalThis as { fetch: unknown }).fetch = mock;
  return mock;
}

describe("evaluateExpression", () => {
  it.each([
    ["45 * 18 + 120", 930],
    ["2 ^ 10", 1024],
    ["(1 + 2) * 3 % 4", 1],
    ["sqrt(16) + abs(-3)", 7],
    ["log(1000)", 3],
    ["10 ÷ 4 × 2", 5],
    ["1.5e3 / 3", 500],
  ])("should evaluate %s to %d", (expression, expected) => {
    expect(evaluateExpression(expression)).toBeCloseTo(expected);
  });

  it("should resolve the pi and e constants", () => {
    expect(evaluateExpression("pi")).toBeCloseTo(Math.PI);
    expect(evaluateExpression("ln(e)")).toBeCloseTo(1);
  });

  it.each(["process.exit(1)", "constructor", "F.constructor('return process')()", "this", "[] + 1", "1; 2", "`x`"])(
    "should reject the injection attempt %s",
    (expression) => {
      expect(() => evaluateExpression(expression)).toThrow();
    },
  );

  it.each([
    ["1 + 2 * 3", 7],
    ["sin(0)", 0],
    ["2 ** 8", 256],
    ["sqrt(16)", 4],
  ])("should evaluate the documented example %s to %d", (expression, expected) => {
    expect(evaluateExpression(expression)).toBeCloseTo(expected);
  });

  it.each([
    "process.exit()",
    'require("fs")',
    "globalThis.process",
    'constructor.constructor("return process")()',
    "Math.PI",
    "sqrt.constructor",
  ])("should reject %s without evaluating it", (expression) => {
    expect(() => evaluateExpression(expression)).toThrow();
  });

  it("should reject a division that is not finite", () => {
    expect(() => evaluateExpression("1 / 0")).toThrow("finite");
  });

  it("should reject malformed syntax", () => {
    expect(() => evaluateExpression("2 +* 3")).toThrow("could not evaluate");
  });
});

describe("CalculatorTool", () => {
  it("should return the expression and its result", async () => {
    await expect(new CalculatorTool().call({ expression: "6 * 7" })).resolves.toEqual({
      expression: "6 * 7",
      result: 42,
    });
  });
});

describe("network tools", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = originalFetch;
  });

  it("should report current weather for a geocoded place", async () => {
    mockFetchJson(
      { results: [{ name: "Tokyo", country: "Japan", latitude: 35.7, longitude: 139.7 }] },
      { current: { temperature_2m: 21.4, relative_humidity_2m: 60, wind_speed_10m: 12, time: "2026-10-03T10:00" } },
    );

    await expect(new WeatherTool().call({ location: "Tokyo" })).resolves.toEqual({
      location: "Tokyo, Japan",
      temperature_c: 21.4,
      humidity_percent: 60,
      wind_kmh: 12,
      observed_at: "2026-10-03T10:00",
    });
  });

  it("should fail instead of inventing weather for an unknown place", async () => {
    mockFetchJson({ results: [] });

    await expect(new WeatherTool().call({ location: "Nowhereville" })).rejects.toThrow("not found");
  });

  it("should fail when the upstream API errors", async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });

    await expect(new WebSearchTool().call({ query: "Nexum" })).rejects.toThrow("HTTP 503");
  });

  it("should return Wikipedia hits with HTML stripped from snippets", async () => {
    mockFetchJson({ query: { search: [{ title: "Bitcoin", snippet: 'A <span class="m">crypto</span>currency' }] } });

    await expect(new WebSearchTool().call({ query: "bitcoin" })).resolves.toEqual({
      query: "bitcoin",
      results: [{ title: "Bitcoin", snippet: "A cryptocurrency" }],
    });
  });
});

describe("generalPack", () => {
  it("should register every tool as read-risk so rendered UIs may call them", () => {
    const catalog = new ToolCatalog();
    mountToolPack(generalPack(), catalog);

    const risks = Object.fromEntries(catalog.all().map((e) => [e.definition.id, e.definition.risk]));
    expect(risks).toEqual({ calculator: "read", weather_api: "read", web_search: "read" });
    expect(catalog.all().every((e) => isUiInvocable(e.definition))).toBe(true);
  });
});

describe("general tools in a real agent", () => {
  const originalFetch = global.fetch;
  const workspace = mkdtempSync(join(tmpdir(), "nexum-general-"));
  afterAll(() => rmSync(workspace, { recursive: true, force: true }));
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = originalFetch;
  });

  function baseTools(): AgentToolManager {
    const tools = new AgentToolManager();
    tools.registerBaseTools(workspace);
    return tools;
  }

  it("should expose calculator, weather_api and web_search as read-risk to every base agent", () => {
    const definitions = baseTools().gateway.discover();

    for (const id of ["calculator", "weather_api", "web_search"]) {
      expect(definitions.find((d) => d.id === id)?.risk).toBe("read");
    }
  });

  it("should let generated UI call only the opted-in read tools of a base agent", () => {
    const uiCallable = baseTools()
      .gateway.discover()
      .filter(isUiInvocable)
      .map((d) => d.id)
      .sort();

    expect(uiCallable).toEqual(
      [
        "calculator",
        "git_read",
        "list_directory",
        "memory_recall",
        "rag_search",
        "read_file",
        "search_code",
        "weather_api",
        "web_search",
      ].sort(),
    );
  });

  it("should compute through the gateway", async () => {
    const result = await baseTools().gateway.invoke("calculator", { expression: "2 ** 8" });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ expression: "2 ** 8", result: 256 });
  });

  it("should surface a calculator rejection as a failed result, not a success", async () => {
    const result = await baseTools().gateway.invoke("calculator", { expression: "process.exit()" });

    expect(result.ok).toBe(false);
  });

  it("should surface an unknown weather location as a failed result with no synthetic data", async () => {
    mockFetchJson({ results: [] });

    const result = await baseTools().gateway.invoke("weather_api", { location: "invalid/unavailable" });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.data)).not.toContain("temperature");
  });

  it("should surface an upstream search failure as a failed result with no synthetic hits", async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });

    const result = await baseTools().gateway.invoke("web_search", { query: "anything" });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.data)).not.toContain("results");
  });
});
