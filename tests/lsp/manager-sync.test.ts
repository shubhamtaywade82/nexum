/**
 * The agent edits files through tools and through the shell, so every LSP query
 * must run against the file as it is now, not the buffer opened earlier.
 */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspManager } from "../../src/lsp/manager.js";
import { LspServerSession } from "../../src/lsp/session.js";
import { LanguageRegistry } from "../../src/lsp/registry.js";
import { pathToUri } from "../../src/lsp/protocol.js";

let workspace: string;
let file: string;

function fakeClient() {
  return {
    didOpen: jest.fn(),
    didChange: jest.fn(),
    didClose: jest.fn(),
    sendRequest: jest.fn(),
    sendNotification: jest.fn(),
  };
}

function runningSession(): { session: LspServerSession; client: ReturnType<typeof fakeClient> } {
  const provider = new LanguageRegistry().getProviderForFile(file)!;
  const session = new LspServerSession(workspace, provider);
  const client = fakeClient();
  session.client = client as unknown as LspServerSession["client"];
  session.status = "running";
  return { session, client };
}

function managerWith(session: LspServerSession, settleMs = 0): LspManager {
  const manager = new LspManager({ workspaceRoot: workspace, diagnosticsSettleMs: settleMs });
  (manager as any).ensureSession = async () => session;
  (manager as any).getSession = async () => session;
  return manager;
}

const diag = (message: string) => ({
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  message,
});

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "nexum-lsp-sync-")));
  mkdirSync(join(workspace, "src"));
  file = join(workspace, "src", "app.ts");
  writeFileSync(file, "const a = 1;\n");
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("LspManager keeps the server's buffer in step with the disk", () => {
  it("re-syncs an open document whose text changed on disk, and only when it changed", async () => {
    const { session, client } = runningSession();
    const manager = managerWith(session);

    await manager.ensureOpen(file);
    expect(client.didOpen).toHaveBeenCalledTimes(1);

    writeFileSync(file, "const a = 2;\nconst b = a;\n"); // an agent edit, not a notification
    await manager.ensureOpen(file);
    expect(client.didChange).toHaveBeenCalledTimes(1);
    expect(client.didChange.mock.calls[0][2]).toEqual([{ text: "const a = 2;\nconst b = a;\n" }]);

    await manager.ensureOpen(file); // unchanged: no traffic
    expect(client.didChange).toHaveBeenCalledTimes(1);
  });

  it("notifyChange and the disk sync agree, so an unchanged file is not re-sent", async () => {
    const { session, client } = runningSession();
    const manager = managerWith(session);
    await manager.ensureOpen(file);

    await manager.notifyChange(file, "const a = 3;\n");
    await manager.ensureOpen(file, "const a = 3;\n");
    expect(client.didChange).toHaveBeenCalledTimes(1);
  });

  it("diagnostics after an edit wait for the server to republish, instead of returning the pre-edit set", async () => {
    const { session } = runningSession();
    const manager = managerWith(session, 1_000);
    const uri = pathToUri(workspace, file);
    await manager.ensureOpen(file);
    session.cachedDiagnostics.set(uri, [diag("stale: before the edit")]);

    writeFileSync(file, "const a = 'edited';\n");
    await manager.ensureOpen(file);
    setTimeout(
      () => session.handleNotification("textDocument/publishDiagnostics", { uri, diagnostics: [diag("fresh")] }),
      50,
    );

    await expect(manager.getDiagnostics(file)).resolves.toEqual([diag("fresh")]);
  });

  it("never returns pre-edit diagnostics: with no republish inside the window, the answer is empty", async () => {
    const { session } = runningSession();
    const manager = managerWith(session, 50);
    const uri = pathToUri(workspace, file);
    await manager.ensureOpen(file);
    session.cachedDiagnostics.set(uri, [diag("stale")]);

    writeFileSync(file, "const a = 'edited';\n");
    await manager.ensureOpen(file);

    await expect(manager.getDiagnostics(file)).resolves.toEqual([]);
    expect(session.cachedDiagnostics.has(uri)).toBe(false);
  });
});
