export interface Setup {
  symbol: string;
  side: "long" | "short";
  entryIndex: number;
  exitIndex: number;
  entryRsi: number;
  exitRsi: number;
  entryPrice: number;
  exitPrice: number;
  volume: number;
}

// A setup is only tradable when the RSI enters the entry band and later
// leaves it — an entry signal with no exit signal is unfillable, so both
// crossings are required before anything is returned.
export function evaluateSetup(
  entryThreshold: number,
  rsi: number | number[],
  symbol: string,
  side: "long" | "short",
  entryPrice: number,
  exitPrice: number,
  context: { volume: number },
): Setup | null {
  const series = typeof rsi === "number" ? [rsi] : rsi;
  const isEntry = (v: number) => (side === "long" ? v <= entryThreshold : v >= entryThreshold);
  const isExit = (v: number) => (side === "long" ? v > entryThreshold : v < entryThreshold);

  const entryIndex = series.findIndex(isEntry);
  if (entryIndex === -1) return null;

  const exitIndex = series.findIndex((v, i) => i > entryIndex && isExit(v));
  if (exitIndex === -1) return null;

  return {
    symbol,
    side,
    entryIndex,
    exitIndex,
    entryRsi: series[entryIndex],
    exitRsi: series[exitIndex],
    entryPrice,
    exitPrice,
    volume: context.volume,
  };
}
