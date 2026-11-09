const DEFAULT_BASE_URL = "https://fapi.binance.com";
const DEFAULT_TIMEOUT_MS = 5000;
const WEIGHT_WARNING_THRESHOLD = 2000;

export interface ClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export class FuturesPublicClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = this.buildUrl(path, params);
    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await fetch(url, { method: "GET", signal });

    this.checkRateLimitWeight(response.headers.get("x-mbx-used-weight-1m"));

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Binance API error ${response.status}: ${errorText}`);
    }

    return (await response.json()) as T;
  }

  private buildUrl(path: string, params: Record<string, string | number | undefined>): URL {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  private checkRateLimitWeight(usedWeight: string | null): void {
    if (!usedWeight) return;
    const weight = Number(usedWeight);
    if (!Number.isNaN(weight) && weight > WEIGHT_WARNING_THRESHOLD) {
      process.stderr.write(`[binance-public-mcp] high request weight: ${weight}/2400\n`);
    }
  }
}
