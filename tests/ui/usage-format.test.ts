import type { UsageResponse } from "@nemesis-oss/ollama-sdk";
import type { AccountUsage } from "../../src/models/adapters/provider.js";
import { formatUsage } from "../../src/ui/hooks/useCommandEffects.js";

// Only the fields formatUsage reads; the SDK's full response shape is not needed here.
function usageWith(totals: Record<string, unknown>): UsageResponse {
  return {
    range: "7d",
    scope: "account",
    granularity: "day",
    buckets: [],
    totals,
  } as unknown as UsageResponse;
}

describe("formatUsage — /usage model breakdown", () => {
  it("lists the server-ranked models and the remainder roll-up when grouped by model", () => {
    const accounts: AccountUsage[] = [
      {
        label: "Key 1",
        usage: usageWith({
          request_count: 42,
          usage_usd: 1.5,
          groups: [
            { model: "gpt-oss:120b", request_count: 30, usage_usd: 1.2 },
            { model: "qwen3-coder:480b", request_count: 10, usage_usd: 0.3 },
          ],
          remainder: { request_count: 2, usage_usd: 0.0005 },
        }),
      },
    ];

    const text = formatUsage(accounts);

    expect(text).toContain("By model:");
    expect(text).toContain("• gpt-oss:120b — 30 req, $1.20");
    expect(text).toContain("• qwen3-coder:480b — 10 req, $0.30");
    expect(text).toContain("• Other — 2 req, $0.0005");
    // Models come before the (unchanged) recent-bucket rows, in the server's order.
    expect(text.indexOf("gpt-oss:120b")).toBeLessThan(text.indexOf("qwen3-coder:480b"));
  });

  it("omits the section entirely for a plain window (no groups in the response)", () => {
    const accounts: AccountUsage[] = [{ label: "Key 1", usage: usageWith({ request_count: 5, usage_usd: 0.1 }) }];

    const text = formatUsage(accounts);

    expect(text).not.toContain("By model");
    expect(text).toContain("• Requests: 5");
  });
});
