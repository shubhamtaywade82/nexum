import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SessionStore } from "../../src/runtime/session.js";
import { ChatMessage } from "../../src/models/adapters/provider.js";

describe("SessionStore", () => {
  let dir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "session-test-"));
    sessionsDir = join(dir, "sessions");
  });

  it("load returns null for an id with no session file", () => {
    const store = new SessionStore(sessionsDir);
    expect(store.load("missing")).toBeNull();
  });

  it("saves and loads a message transcript by id", () => {
    const store = new SessionStore(sessionsDir);
    const id = store.startNew();
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    store.save(id, messages);

    expect(store.load(id)).toEqual(messages);
  });

  it("creates the parent directory if missing", () => {
    const nestedDir = join(dir, "nested", "sessions");
    const store = new SessionStore(nestedDir);
    const id = store.startNew();
    store.save(id, [{ role: "user", content: "hi" }]);
    expect(existsSync(join(nestedDir, `${id}.json`))).toBe(true);
  });

  it("does not leave .tmp files behind after a save", () => {
    const store = new SessionStore(sessionsDir);
    const id = store.startNew();
    store.save(id, [{ role: "user", content: "hi" }]);
    expect(existsSync(join(sessionsDir, `${id}.json.tmp`))).toBe(false);
    expect(existsSync(join(sessionsDir, "index.json.tmp"))).toBe(false);
  });

  it("overwrites the previous transcript on repeated saves to the same id", () => {
    const store = new SessionStore(sessionsDir);
    const id = store.startNew();
    store.save(id, [{ role: "user", content: "first" }]);
    store.save(id, [{ role: "user", content: "second" }]);
    expect(store.load(id)).toEqual([{ role: "user", content: "second" }]);
  });

  it("keeps separate sessions independent", () => {
    const store = new SessionStore(sessionsDir);
    const a = store.startNew();
    const b = store.startNew();
    store.save(a, [{ role: "user", content: "session a" }]);
    store.save(b, [{ role: "user", content: "session b" }]);
    expect(store.load(a)).toEqual([{ role: "user", content: "session a" }]);
    expect(store.load(b)).toEqual([{ role: "user", content: "session b" }]);
  });

  it("clear removes a session and drops it from the index", () => {
    const store = new SessionStore(sessionsDir);
    const id = store.startNew();
    store.save(id, [{ role: "user", content: "hi" }]);
    store.clear(id);
    expect(store.load(id)).toBeNull();
    expect(store.listSessions().find((s) => s.id === id)).toBeUndefined();
  });

  it("clear is a no-op when the session doesn't exist", () => {
    const store = new SessionStore(sessionsDir);
    expect(() => store.clear("missing")).not.toThrow();
  });

  it("returns null instead of throwing on corrupt JSON", () => {
    const store = new SessionStore(sessionsDir);
    const id = store.startNew();
    store.save(id, [{ role: "user", content: "hi" }]);
    writeFileSync(join(sessionsDir, `${id}.json`), "{not valid json");
    expect(store.load(id)).toBeNull();
  });

  it("returns null when the file contains valid JSON that isn't an array", () => {
    const store = new SessionStore(sessionsDir);
    const id = store.startNew();
    store.save(id, [{ role: "user", content: "hi" }]);
    writeFileSync(join(sessionsDir, `${id}.json`), JSON.stringify({ not: "an array" }));
    expect(store.load(id)).toBeNull();
  });

  it("survives a crash mid-write — old transcript intact", () => {
    const store = new SessionStore(sessionsDir);
    const id = store.startNew();
    store.save(id, [{ role: "user", content: "first" }]);
    expect(JSON.parse(readFileSync(join(sessionsDir, `${id}.json`), "utf8"))).toEqual([
      { role: "user", content: "first" },
    ]);
  });

  it("listSessions returns most recently updated first, with metadata", () => {
    const store = new SessionStore(sessionsDir);
    const a = store.startNew();
    store.save(a, [
      { role: "user", content: "first conversation" },
      { role: "assistant", content: "hi" },
    ]);
    const b = store.startNew();
    store.save(b, [{ role: "user", content: "second conversation" }]);

    const listed = store.listSessions();
    expect(listed.map((s) => s.id)).toEqual([b, a]);
    expect(listed[0].firstUserLine).toBe("second conversation");
    expect(listed[1].messageCount).toBe(2);
  });

  it("mostRecentId returns null when no sessions exist", () => {
    const store = new SessionStore(sessionsDir);
    expect(store.mostRecentId()).toBeNull();
  });

  it("mostRecentId returns the most recently saved session", () => {
    const store = new SessionStore(sessionsDir);
    const a = store.startNew();
    store.save(a, [{ role: "user", content: "a" }]);
    const b = store.startNew();
    store.save(b, [{ role: "user", content: "b" }]);
    expect(store.mostRecentId()).toBe(b);
  });

  it("migrates a legacy flat session.json file into the new layout", () => {
    const legacyMessages: ChatMessage[] = [{ role: "user", content: "legacy conversation" }];
    writeFileSync(`${sessionsDir}.json`, JSON.stringify(legacyMessages));

    const store = new SessionStore(sessionsDir);

    expect(existsSync(`${sessionsDir}.json`)).toBe(false);
    const listed = store.listSessions();
    expect(listed).toHaveLength(1);
    expect(store.load(listed[0].id)).toEqual(legacyMessages);
  });
});

describe("SessionStore redaction", () => {
  it("never writes credentials to disk", async () => {
    const { mkdtempSync, readFileSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { SessionStore } = await import("../../src/runtime/session.js");
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    const store = new SessionStore(dir);
    store.save("s1", [
      { role: "user", content: "my key is sk-live-abcdefghijklmnopqrstu and Bearer abcdefghijklmnopqrstuvwxyz" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "http", arguments: { password: "hunter2hunter2" } } }],
      },
    ]);
    const file = readdirSync(dir).find((f) => f.startsWith("s1"))!;
    const raw = readFileSync(join(dir, file), "utf8");
    expect(raw).not.toContain("sk-live-abcdefghijklmnopqrstu");
    expect(raw).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(raw).not.toContain("hunter2hunter2");
    expect(raw).toContain("[REDACTED]");
  });
});
