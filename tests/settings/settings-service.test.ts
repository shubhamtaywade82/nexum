/**
 * Tests for the SettingsService.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsService, registerDefaultSpecs } from "../../src/settings/index.js";

describe("SettingsService", () => {
  let tmpDir: string;
  let service: SettingsService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nexum-settings-"));
    service = new SettingsService({ rootDir: tmpDir });
    registerDefaultSpecs(service);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("registerSpec", () => {
    it("throws on duplicate registration", () => {
      expect(() =>
        service.registerSpec({
          key: "model.routingStrategy",
          label: "Dup",
          default: "scored",
          type: "string",
          namespace: "model",
          editable: true,
        }),
      ).toThrow(/already registered/);
    });
  });

  describe("get", () => {
    it("returns the default value", () => {
      expect(service.get("model.routingStrategy")).toBe("scored");
    });

    it("returns undefined for unknown key", () => {
      expect(service.get("nonexistent.key")).toBeUndefined();
    });
  });

  describe("require", () => {
    it("returns the value", () => {
      expect(service.require("model.routingStrategy")).toBe("scored");
    });

    it("throws for unknown key with helpful message", () => {
      expect(() => service.require("missing.key")).toThrow(/not registered.*model\.routing/);
    });
  });

  describe("set", () => {
    it("stores an override and emits change event", () => {
      const events: Array<{ key: string; oldValue: unknown; newValue: unknown }> = [];
      service.on("change", (e) => events.push(e));
      service.set("model.routingStrategy", "local-first", "test");
      expect(service.get("model.routingStrategy")).toBe("local-first");
      expect(events.length).toBe(1);
      expect(events[0].key).toBe("model.routingStrategy");
      expect(events[0].oldValue).toBe("scored");
      expect(events[0].newValue).toBe("local-first");
      expect(events[0].source).toBe("test");
    });

    it("throws when setting an unknown key", () => {
      expect(() => service.set("nonexistent", "x")).toThrow(/cannot set unknown setting/);
    });

    it("throws when setting a non-editable key", () => {
      expect(() => service.set("workspace.root", "/new/path")).toThrow(/not editable/);
    });

    it("validates values", () => {
      expect(() => service.set("model.routingStrategy", "invalid" as never)).toThrow(/must be/);
    });
  });

  describe("reset", () => {
    it("resets to default", () => {
      service.set("model.routingStrategy", "local-first");
      service.reset("model.routingStrategy");
      expect(service.get("model.routingStrategy")).toBe("scored");
    });
  });

  describe("list", () => {
    it("lists all specs", () => {
      const all = service.list();
      expect(all.length).toBeGreaterThan(5);
      expect(all.some((s) => s.key === "model.routingStrategy")).toBe(true);
    });

    it("filters by namespace", () => {
      const modelSettings = service.list("model");
      expect(modelSettings.length).toBeGreaterThan(0);
      expect(modelSettings.every((s) => s.namespace === "model")).toBe(true);
    });
  });

  describe("byNamespace", () => {
    it("returns specs in a namespace", () => {
      const sandbox = service.byNamespace("sandbox");
      expect(sandbox.length).toBeGreaterThan(0);
      expect(sandbox.every((s) => s.namespace === "sandbox")).toBe(true);
    });
  });

  describe("changes", () => {
    it("records the audit log", () => {
      service.set("model.routingStrategy", "local-first", "user");
      service.set("model.maxConcurrent", 16, "user");
      const changes = service.changes();
      expect(changes.length).toBe(2);
      expect(changes[0].key).toBe("model.routingStrategy");
      expect(changes[1].key).toBe("model.maxConcurrent");
    });
  });

  describe("redacted", () => {
    it("returns specs with redacted secret values", () => {
      service.registerSpec({
        key: "test.secret",
        label: "Secret",
        default: "sk-supersecret12345",
        type: "string",
        namespace: "custom",
        editable: false,
        secret: true,
      });
      const list = service.redacted();
      const secret = list.find((s) => s.key === "test.secret");
      expect(secret?.value).toBe("***REDACTED***");
    });
  });

  describe("exportOverrides + importOverrides", () => {
    it("exports and re-imports overrides", () => {
      service.set("model.routingStrategy", "local-first");
      service.set("ui.theme", "dark");
      const exported = service.exportOverrides();
      expect(Object.keys(exported).length).toBe(2);

      const newService = new SettingsService({ rootDir: tmpDir, inMemory: true });
      registerDefaultSpecs(newService);
      newService.importOverrides(exported, "migration");
      expect(newService.get("model.routingStrategy")).toBe("local-first");
      expect(newService.get("ui.theme")).toBe("dark");
    });
  });

  describe("persistence", () => {
    it("persists overrides to disk", () => {
      service.set("model.routingStrategy", "local-first");
      // Create a new service pointing at the same dir — should load overrides.
      const reloaded = new SettingsService({ rootDir: tmpDir });
      registerDefaultSpecs(reloaded);
      expect(reloaded.get("model.routingStrategy")).toBe("local-first");
    });
  });
});
