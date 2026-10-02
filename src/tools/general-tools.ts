import { Tool, ToolError } from "./tool.js";

const MATH_FUNCTIONS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  abs: Math.abs,
  log: Math.log10,
  ln: Math.log,
};
const MATH_CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };
const MATH_TOKEN = /\s*(\d+(?:\.\d+)?(?:e[+-]?\d+)?|[a-z]+|\*\*|[-+*/%^(),×÷])/iy;

/**
 * Evaluates an arithmetic expression. Every token is checked against an
 * allowlist before evaluation, so only numbers, operators and the named
 * math functions/constants can reach the JS evaluator.
 */
export function evaluateExpression(expression: string): number {
  const jsTokens: string[] = [];
  MATH_TOKEN.lastIndex = 0;
  while (MATH_TOKEN.lastIndex < expression.trimEnd().length) {
    const match = MATH_TOKEN.exec(expression);
    if (!match) throw new ToolError(`invalid character at position ${MATH_TOKEN.lastIndex} in "${expression}"`);
    jsTokens.push(toJsToken(match[1]));
  }

  let result: unknown;
  try {
    result = new Function("F", "C", `"use strict"; return (${jsTokens.join(" ")});`)(MATH_FUNCTIONS, MATH_CONSTANTS);
  } catch (err) {
    throw new ToolError(`could not evaluate "${expression}": ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new ToolError(`"${expression}" did not evaluate to a finite number`);
  }
  return result;
}

function toJsToken(token: string): string {
  const name = token.toLowerCase();
  if (name in MATH_FUNCTIONS) return `F.${name}`;
  if (name in MATH_CONSTANTS) return `C.${name}`;
  if (/^[a-z]+$/.test(name)) throw new ToolError(`unknown name "${token}"`);
  if (token === "^") return "**";
  if (token === "×") return "*";
  if (token === "÷") return "/";
  return token;
}

export class CalculatorTool extends Tool {
  get name(): string {
    return "calculator";
  }

  get description(): string {
    return "Evaluate an arithmetic expression, e.g. 45 * 18 + 120, sqrt(2) ^ 3, ln(10). Supports + - * / % ^ and sqrt, sin, cos, tan, abs, log (base 10), ln, pi, e.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { expression: { type: "string", description: "The expression to evaluate" } },
      required: ["expression"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const expression = String(args.expression);
    return { expression, result: evaluateExpression(expression) };
  }
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  if (!res.ok) throw new ToolError(`request to ${new URL(url).host} failed: HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

export class WeatherTool extends Tool {
  get name(): string {
    return "weather_api";
  }

  get description(): string {
    return "Current weather (temperature, humidity, wind) for a place name, via Open-Meteo.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { location: { type: "string", description: "City or place name, e.g. Tokyo" } },
      required: ["location"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const location = String(args.location);
    const geo = await fetchJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&format=json`,
    );
    const place = (geo.results as Array<Record<string, unknown>> | undefined)?.[0];
    if (!place) throw new ToolError(`location "${location}" not found`);

    const forecast = await fetchJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
        "&current=temperature_2m,relative_humidity_2m,wind_speed_10m&timezone=auto",
    );
    const current = (forecast.current ?? {}) as Record<string, unknown>;
    return {
      location: `${place.name}, ${place.country}`,
      temperature_c: current.temperature_2m,
      humidity_percent: current.relative_humidity_2m,
      wind_kmh: current.wind_speed_10m,
      observed_at: current.time,
    };
  }
}

export class WebSearchTool extends Tool {
  get name(): string {
    return "web_search";
  }

  get description(): string {
    return "Search Wikipedia for background facts; returns the top 3 article titles with snippets. Not a live news or general web search.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { query: { type: "string", description: "Search terms" } },
      required: ["query"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = String(args.query);
    const data = await fetchJson(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch=${encodeURIComponent(query)}`,
    );
    const hits = ((data.query as Record<string, unknown> | undefined)?.search ?? []) as Array<{
      title: string;
      snippet: string;
    }>;
    return {
      query,
      results: hits.map((hit) => ({ title: hit.title, snippet: hit.snippet.replace(/<[^>]+>/g, "") })),
    };
  }
}
