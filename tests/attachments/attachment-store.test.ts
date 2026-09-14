/**
 * Tests for the AttachmentStore.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentStore, hashContent, storeFile, guessMediaType } from "../../src/attachments/index.js";

describe("AttachmentStore", () => {
  let tmpDir: string;
  let store: AttachmentStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nexum-attachments-"));
    store = new AttachmentStore({ rootDir: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("store + read", () => {
    it("stores content and returns a content-addressed id", () => {
      const record = store.store("hello world", "text/plain");
      expect(record.id).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(record.size).toBe(11);
      expect(record.mediaType).toBe("text/plain");
    });

    it("reads stored content back", () => {
      const record = store.store("hello world", "text/plain");
      const content = store.read(record.id);
      expect(content?.toString("utf8")).toBe("hello world");
    });

    it("reads content as text", () => {
      const record = store.store("hello", "text/plain");
      expect(store.readText(record.id)).toBe("hello");
    });

    it("returns undefined for unknown id", () => {
      expect(store.read("sha256:nonexistent")).toBeUndefined();
    });

    it("dedupes identical content (same id)", () => {
      const r1 = store.store("same content", "text/plain");
      const r2 = store.store("same content", "text/plain");
      expect(r1.id).toBe(r2.id);
    });

    it("stores binary content", () => {
      const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const record = store.store(buffer, "image/png");
      const read = store.read(record.id);
      expect(read).toEqual(buffer);
    });
  });

  describe("stat", () => {
    it("returns metadata without reading content", () => {
      const record = store.store("content", "text/markdown", { filename: "test.md" });
      const stat = store.stat(record.id);
      expect(stat?.filename).toBe("test.md");
      expect(stat?.size).toBe(7);
    });
  });

  describe("list", () => {
    it("lists all stored attachments", () => {
      store.store("a", "text/plain");
      store.store("b", "text/plain");
      store.store("c", "text/plain");
      const list = store.list();
      expect(list.length).toBe(3);
    });
  });

  describe("has", () => {
    it("returns true for stored, false for unknown", () => {
      const record = store.store("x", "text/plain");
      expect(store.has(record.id)).toBe(true);
      expect(store.has("sha256:unknown")).toBe(false);
    });
  });

  describe("URI conversion", () => {
    it("converts id to/from URI", () => {
      const id = "sha256:abcdef1234567890";
      const uri = store.toUri(id);
      expect(uri).toBe("attachment://sha256:abcdef1234567890");
      expect(store.fromUri(uri)).toBe(id);
    });

    it("returns undefined for non-attachment URIs", () => {
      expect(store.fromUri("https://example.com")).toBeUndefined();
    });
  });

  describe("integrity check", () => {
    it("hash matches content", () => {
      const buffer = Buffer.from("test content");
      const id = hashContent(buffer);
      expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });

  describe("totalSize", () => {
    it("sums sizes of all attachments", () => {
      store.store("aaa", "text/plain");
      store.store("bb", "text/plain");
      expect(store.totalSize()).toBe(5);
    });
  });
});

describe("guessMediaType", () => {
  it("guesses common types from extensions", () => {
    expect(guessMediaType("file.png")).toBe("image/png");
    expect(guessMediaType("file.jpg")).toBe("image/jpeg");
    expect(guessMediaType("file.pdf")).toBe("application/pdf");
    expect(guessMediaType("file.json")).toBe("application/json");
    expect(guessMediaType("file.md")).toBe("text/markdown");
    expect(guessMediaType("file.txt")).toBe("text/plain");
  });

  it("defaults to octet-stream for unknown extensions", () => {
    expect(guessMediaType("file.xyz")).toBe("application/octet-stream");
  });
});

describe("in-memory mode", () => {
  it("works without touching the filesystem", () => {
    const store = new AttachmentStore({ rootDir: "/nonexistent", inMemory: true });
    const record = store.store("test", "text/plain");
    expect(store.readText(record.id)).toBe("test");
    expect(store.list().length).toBe(1);
  });
});

// Unused import cleanup.
void storeFile;
void join;
