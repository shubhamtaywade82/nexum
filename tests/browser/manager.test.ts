import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserManager, HARDENED_CHROMIUM_ARGS, resolveChromiumExecutablePath } from "../../src/browser/manager.js";

import { chromium } from "playwright";

// Real Chromium, real navigation — data: URLs keep it offline/deterministic,
// same spirit as the real-process LSP client tests (verify the actual
// integration, not a mock of it).
const PAGE = `data:text/html,<html><head><title>Test Page</title></head><body>
  <h1 id="heading">Hello</h1>
  <input id="name" />
  <button id="btn" onclick="document.getElementById('heading').textContent='Clicked'">Click me</button>
</body></html>`;

let hasChromium = false;
try {
  const executablePath = resolveChromiumExecutablePath();
  const testBrowser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  await testBrowser.close();
  hasChromium = true;
} catch {
  // Chromium binary is not installed in the environment
}

const describeBrowser = hasChromium ? describe : describe.skip;

describeBrowser("BrowserManager", () => {
  let browser: BrowserManager;

  beforeEach(() => {
    browser = new BrowserManager();
  });

  afterEach(async () => {
    await browser.close();
  });

  it("navigates and returns the page title", async () => {
    const result = await browser.navigate(PAGE);
    expect(result.title).toBe("Test Page");
  }, 30000);

  it("reads text content, optionally scoped to a selector", async () => {
    await browser.navigate(PAGE);
    expect(await browser.getText("#heading")).toBe("Hello");
    expect(await browser.getText()).toContain("Hello");
  }, 30000);

  it("fills a form field", async () => {
    await browser.navigate(PAGE);
    await browser.fill("#name", "hello world");
    const value = await browser.evaluate("document.getElementById('name').value");
    expect(value).toBe("hello world");
  }, 30000);

  it("clicks an element and observes the resulting DOM change", async () => {
    await browser.navigate(PAGE);
    await browser.click("#btn");
    expect(await browser.getText("#heading")).toBe("Clicked");
  }, 30000);

  it("takes a real PNG screenshot", async () => {
    await browser.navigate(PAGE);
    const buffer = await browser.screenshot();
    expect(buffer.length).toBeGreaterThan(0);
    // PNG magic bytes
    expect(buffer.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }, 30000);

  it("evaluates arbitrary JS in the page and returns the result", async () => {
    await browser.navigate(PAGE);
    expect(await browser.evaluate("1 + 1")).toBe(2);
  }, 30000);

  it("reuses the same page across calls until close()", async () => {
    await browser.navigate(PAGE);
    const urlBefore = browser.currentUrl;
    await browser.getText();
    expect(browser.currentUrl).toBe(urlBefore);
  }, 30000);

  it("currentUrl is null before any navigation and after close()", async () => {
    expect(browser.currentUrl).toBeNull();
    await browser.navigate(PAGE);
    expect(browser.currentUrl).not.toBeNull();
    await browser.close();
    expect(browser.currentUrl).toBeNull();
  }, 30000);

  it("relaunches cleanly after close()", async () => {
    await browser.navigate(PAGE);
    await browser.close();
    const result = await browser.navigate(PAGE);
    expect(result.title).toBe("Test Page");
  }, 30000);
});

describe("resolveChromiumExecutablePath", () => {
  const originalOverride = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const originalBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    else process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = originalOverride;
    if (originalBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = originalBrowsersPath;
  });

  it("returns undefined when neither env var is set", () => {
    delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    expect(resolveChromiumExecutablePath()).toBeUndefined();
  });

  it("prefers an explicit PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH override", () => {
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "/custom/chromium";
    process.env.PLAYWRIGHT_BROWSERS_PATH = "/should/be/ignored";
    expect(resolveChromiumExecutablePath()).toBe("/custom/chromium");
  });

  it("resolves a chromium binary directly under PLAYWRIGHT_BROWSERS_PATH when present", async () => {
    delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    const dir = await mkdtemp(join(tmpdir(), "pw-browsers-"));
    await writeFile(join(dir, "chromium"), "");
    process.env.PLAYWRIGHT_BROWSERS_PATH = dir;
    expect(resolveChromiumExecutablePath()).toBe(join(dir, "chromium"));
  });

  it("returns undefined when PLAYWRIGHT_BROWSERS_PATH has no chromium entry", async () => {
    delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    const dir = await mkdtemp(join(tmpdir(), "pw-browsers-"));
    process.env.PLAYWRIGHT_BROWSERS_PATH = dir;
    expect(resolveChromiumExecutablePath()).toBeUndefined();
  });
});

describe("BrowserManager URL policy (PRODUCTION_AUDIT #10)", () => {
  it("refuses non-http(s) schemes before any browser launch", async () => {
    const manager = new BrowserManager();
    await expect(manager.navigate("file:///etc/passwd")).rejects.toThrow(/blocked URL scheme "file:"/);
    await expect(manager.navigate("about:blank")).rejects.toThrow(/blocked URL scheme "about:"/);
    await expect(manager.navigate("not a url")).rejects.toThrow(/invalid URL/);
    await manager.close();
  });

  it("refuses literal loopback/private/metadata IPs", async () => {
    const manager = new BrowserManager();
    await expect(manager.navigate("http://127.0.0.1/")).rejects.toThrow(/blocked destination 127\.0\.0\.1/);
    await expect(manager.navigate("http://192.168.1.1/")).rejects.toThrow(/blocked destination/);
    await expect(manager.navigate("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      /blocked destination 169\.254\.169\.254/,
    );
    await expect(manager.navigate("http://[::1]/")).rejects.toThrow(/blocked destination/);
    await manager.close();
  });

  it("allowPrivateNetwork opts back in for local testing", async () => {
    const manager = new BrowserManager({ allowPrivateNetwork: true });
    await expect(manager.navigate("http://127.0.0.1:1/")).rejects.toThrow(); // no listener → network error, NOT a policy block
    await manager.close();
  });

  it("shipped launch args never include --no-sandbox", () => {
    expect(HARDENED_CHROMIUM_ARGS).not.toContain("--no-sandbox");
    expect(HARDENED_CHROMIUM_ARGS).toContain("--disable-extensions");
  });
});
