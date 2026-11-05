import { formatBytes, formatDuration, formatPullProgress } from "../../src/models/pull-progress.js";

describe("formatPullProgress", () => {
  it("renders status, percent, transfer speed and ETA once the SDK has measured them", () => {
    expect(
      formatPullProgress({ status: "downloading", percent: 42.37, bytesPerSecond: 11_300_000, etaSeconds: 64 }),
    ).toBe("downloading · 42.4% · 11.3 MB/s · ETA 1m 04s");
  });

  it("omits fields the SDK has not measured yet instead of printing zeros", () => {
    expect(formatPullProgress({ status: "pulling manifest" })).toBe("pulling manifest");
    expect(formatPullProgress({ status: "downloading", percent: 0 })).toBe("downloading · 0.0%");
  });
});

describe("formatBytes", () => {
  it("uses decimal SI units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1_500)).toBe("1.5 KB");
    expect(formatBytes(2_000_000_000)).toBe("2.0 GB");
  });

  it("clamps negative input to zero", () => {
    expect(formatBytes(-5)).toBe("0 B");
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0s"],
    [59, "59s"],
    [64, "1m 04s"],
    [3_600, "1h 00m"],
    [3_725, "1h 02m"],
    [-3, "0s"],
  ])("formats %p seconds as %p", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});
