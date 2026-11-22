import { existsSync } from "node:fs";
import { join } from "node:path";
import { isIP } from "node:net";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { chromium, Browser, Page } from "playwright";
import { isBlockedAddress } from "../web-service/index.js";

/**
 * Resolves a Chromium binary to launch without going through Playwright's
 * version-fingerprinted auto-download resolution, which breaks whenever the
 * installed `playwright` package expects a browser revision that wasn't
 * pre-fetched (common in sandboxed/offline environments). If
 * `PLAYWRIGHT_BROWSERS_PATH` points at a directory with a `chromium`
 * executable/symlink directly inside it, use that; otherwise fall back to
 * Playwright's normal resolution unchanged.
 */
export function resolveChromiumExecutablePath(): string | undefined {
  const override = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (override) return override;
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!browsersPath) return undefined;
  const candidate = join(browsersPath, "chromium");
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Chromium launch args for untrusted browsing (PRODUCTION_AUDIT #10): disable
 * the component extensions/parts that have their own network surfaces and
 * privilege (and are unnecessary headless), and keep the sandbox on. The
 * `--no-sandbox` flag must never appear here — it removes Chromium's own
 * process isolation.
 */
export const HARDENED_CHROMIUM_ARGS: readonly string[] = [
  "--disable-dev-shm-usage",
  "--disable-extensions",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-background-networking",
  "--disable-sync",
  "--metrics-recording-only",
  "--no-first-run",
];

export interface BrowserManagerOptions {
  /**
   * Allow navigation to private/loopback/reserved addresses (default false).
   * Mirrors WebService's allowPrivateNetwork escape hatch for local testing.
   */
  allowPrivateNetwork?: boolean;
  /** Extra Chromium args (merged after the hardened defaults). */
  extraArgs?: string[];
}

/** Owns a single lazily-launched headless Chromium instance + one page,
 * reused across tool calls — mirrors LspManager's one-process-per-workspace
 * lifecycle model. The browser process is killed with the parent Node
 * process on exit, same as LSP servers (no explicit teardown wired at the
 * CLI entry point for either).
 *
 * PRODUCTION_AUDIT #10: navigation now goes through the same address policy
 * as the web fetch tool — non-http(s) schemes are refused, and loopback /
 * private / link-local (cloud metadata) / reserved destinations are blocked
 * both as literal IPs and after DNS resolution (request interception), so a
 * hostname that resolves into the internal network cannot be browsed. */
const GET_TEXT_TIMEOUT_MS = 5_000;

export class BrowserManager {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private readonly allowPrivateNetwork: boolean;
  private readonly extraArgs: string[];

  constructor(opts: BrowserManagerOptions = {}) {
    this.allowPrivateNetwork = opts.allowPrivateNetwork ?? false;
    this.extraArgs = opts.extraArgs ?? [];
  }

  /** Throws when the URL's scheme or (literal-IP) host is not allowed. */
  private assertAllowedUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`invalid URL: ${raw}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`blocked URL scheme "${url.protocol}" (only http/https)`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!this.allowPrivateNetwork && isIP(host) && isBlockedAddress(host)) {
      throw new Error(`blocked destination ${host}: private, loopback or reserved address`);
    }
    return url;
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.browser || !this.browser.isConnected()) {
      const executablePath = resolveChromiumExecutablePath();
      this.browser = await chromium.launch({
        headless: true,
        args: [...HARDENED_CHROMIUM_ARGS, ...this.extraArgs],
        ...(executablePath ? { executablePath } : {}),
      });
    }
    this.page = await this.browser.newPage();
    if (!this.allowPrivateNetwork) {
      // Block at DNS-resolution time too: a public hostname that resolves
      // into a private/loopback/reserved address must not be browsable
      // (same rebinding concern the web fetch tool handles via dnsLookup).
      await this.page.route("**/*", (route) => {
        const url = new URL(route.request().url());
        const host = url.hostname.replace(/^\[|\]$/g, "");
        const block = (reason: string) =>
          route.abort("blockedbyclient").catch(() => {
            /* already handled */
            void reason;
          });
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          void block("scheme");
          return;
        }
        if (isIP(host)) {
          if (isBlockedAddress(host)) void block("address");
          else void route.continue();
          return;
        }
        dnsLookup(host, { all: true }, (err: NodeJS.ErrnoException | null, addresses: LookupAddress[] | string) => {
          if (err) {
            void route.continue();
            return;
          }
          const list = Array.isArray(addresses) ? addresses : [{ address: String(addresses), family: 4 }];
          const blocked = list.find((a) => isBlockedAddress(a.address));
          if (blocked) void block(`dns ${blocked.address}`);
          else void route.continue();
        });
      });
    }
    return this.page;
  }

  async navigate(url: string): Promise<{ title: string; url: string }> {
    this.assertAllowedUrl(url);
    const page = await this.ensurePage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    if (response && !response.ok() && response.status() >= 400) {
      // Navigation happened (URL is visible), but report the failure honestly.
      return { title: await page.title(), url: page.url() };
    }
    return { title: await page.title(), url: page.url() };
  }

  async click(selector: string): Promise<void> {
    const page = await this.ensurePage();
    await page.click(selector);
  }

  async fill(selector: string, text: string): Promise<void> {
    const page = await this.ensurePage();
    await page.fill(selector, text);
  }

  async getText(selector?: string): Promise<string> {
    const page = await this.ensurePage();
    if (!selector) return (await page.textContent("body")) ?? "";
    // The page is already loaded when the agent reads it; a missing selector should fail in seconds, not 30s.
    try {
      return (await page.textContent(selector, { timeout: GET_TEXT_TIMEOUT_MS })) ?? "";
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error(`no element matches "${selector}" on ${page.url()} (waited ${GET_TEXT_TIMEOUT_MS}ms)`, {
          cause: err,
        });
      }
      throw err;
    }
  }

  async screenshot(): Promise<Buffer> {
    const page = await this.ensurePage();
    return page.screenshot({ type: "png" });
  }

  async evaluate(script: string): Promise<unknown> {
    const page = await this.ensurePage();
    return page.evaluate(script);
  }

  get currentUrl(): string | null {
    return this.page && !this.page.isClosed() ? this.page.url() : null;
  }

  async close(): Promise<void> {
    if (this.page && !this.page.isClosed()) await this.page.close().catch(() => {});
    this.page = null;
    if (this.browser && this.browser.isConnected()) await this.browser.close().catch(() => {});
    this.browser = null;
  }
}
