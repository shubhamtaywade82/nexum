import { describe, it, expect } from "@jest/globals";
import { evaluateSetup } from "../setup.ts";

describe("evaluateSetup — RSI < 30 → long entry / > 30 → exit", () => {
  const ENTRY_RSI = 30;

  describe("entry data", () => {
    it("rejects an entry with RSI ≥ 30", () => {
      const result = evaluateSetup(ENTRY_RSI, 55, "SOLUSDT", "long", 100, 1500, { volume: 50 });
      expect(result).toBeNull();
    });
  });

  describe("exit data", () => {
    it("returns null when exit RSI never crossed above threshold", () => {
      const rsis = [55, 60, 70, 80, 75, 65, 45, 40, 35, 40];
      const result = evaluateSetup(ENTRY_RSI, rsis, "SOLUSDT", "long", 100, 1500, { volume: 50 });
      expect(result).toBeNull();
    });
  });

  describe("success path — RSI crosses below then above", () => {
    const rsis: number[] = [30, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 110, 105, 100, 95, 90, 85, 80];

    it("detects the setup when RSIs cross from below to above", () => {
      const result = evaluateSetup(30, rsis, "SOLUSDT", "long", 100, 1500, { volume: 50 });
      expect(result).not.toBeNull();
      if (result) {
        expect(result.symbol).toBe("SOLUSDT");
        expect(result.side).toBe("long");
      }
    });
  });
});
