import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadFileTool, WriteFileTool, SensitivePathError } from "../../src/tools/filesystem.js";

describe("ReadFileTool sensitive path blocking", () => {
  it("blocks reading .env files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, ".env"), "SECRET_KEY=abc");
    const tool = new ReadFileTool(dir);

    await expect(tool.call({ path: ".env" })).rejects.toThrow(SensitivePathError);
  });

  it("blocks reading credentials.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "credentials.json"), '{"key": "val"}');
    const tool = new ReadFileTool(dir);

    await expect(tool.call({ path: "credentials.json" })).rejects.toThrow(SensitivePathError);
  });

  it("blocks reading id_rsa private keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----");
    const tool = new ReadFileTool(dir);

    await expect(tool.call({ path: "id_rsa" })).rejects.toThrow(SensitivePathError);
  });

  it("blocks reading nested .env.production files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "config"), { recursive: true });
    await writeFile(join(dir, "config", ".env.production"), "DB_PASS=secret");
    const tool = new ReadFileTool(dir);

    await expect(tool.call({ path: "config/.env.production" })).rejects.toThrow(SensitivePathError);
  });

  it("blocks reading .pem files via pattern", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "cert.pem"), "-----BEGIN CERTIFICATE-----");
    const tool = new ReadFileTool(dir);

    await expect(tool.call({ path: "cert.pem" })).rejects.toThrow(SensitivePathError);
  });

  it("allows reading normal files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "index.ts"), "export const x = 1;");
    const tool = new ReadFileTool(dir);

    const result = await tool.call({ path: "index.ts" });
    expect(result.content).toBe("export const x = 1;");
  });
});

describe("WriteFileTool sensitive path blocking", () => {
  it("blocks writing .env files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new WriteFileTool(dir);

    await expect(tool.call({ path: ".env", content: "NEW_SECRET=x" })).rejects.toThrow(SensitivePathError);
  });

  it("blocks writing credentials.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new WriteFileTool(dir);

    await expect(tool.call({ path: "credentials.json", content: "{}" })).rejects.toThrow(SensitivePathError);
  });

  it("allows writing normal files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    const tool = new WriteFileTool(dir);

    const result = await tool.call({ path: "main.ts", content: "console.log('hi');" });
    expect(result.path).toBe("main.ts");
  });
});

describe("ReadFileTool sensitive path blocking across case variants", () => {
  it("blocks case variants of credential filenames and directories", async () => {
    const { mkdir } = await import("node:fs/promises");
    const dir = await mkdtemp(join(tmpdir(), "ws-"));
    await writeFile(join(dir, "ID_RSA"), "-----BEGIN OPENSSH PRIVATE KEY-----");
    await mkdir(join(dir, ".AWS"), { recursive: true });
    await writeFile(join(dir, ".AWS", "credentials"), "[default]\naws_secret_access_key=abc");
    const tool = new ReadFileTool(dir);

    await expect(tool.call({ path: "ID_RSA" })).rejects.toThrow(SensitivePathError);
    await expect(tool.call({ path: ".AWS/credentials" })).rejects.toThrow(SensitivePathError);
  });
});
