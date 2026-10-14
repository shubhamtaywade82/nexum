import React from "react";
import { Box, Text } from "@nemesis-oss/termina-core";
import { LspServerState, RuntimeState } from "../../runtime/types.js";
import { themeColors } from "../layout/theme-map.js";

export interface DiagnosticsPanelProps {
  lspServers: LspServerState[];
  diagnosticsByPath?: Record<string, number>;
  lastTestResult?: RuntimeState["lastTestResult"];
  width: number;
  rows: number;
}

function Row({
  label,
  value,
  color,
  width,
}: {
  label: string;
  value: string;
  color?: string;
  width: number;
}): React.JSX.Element {
  const gap = Math.max(1, width - label.length - value.length);
  return (
    <Box height={1}>
      <Text color={color}>{label}</Text>
      <Text>{" ".repeat(gap)}</Text>
      <Text color={color}>{value}</Text>
    </Box>
  );
}

/**
 * Right-column Diagnostics panel content. Errors are a real aggregate of
 * lspServers[].errorCount plus per-path diagnostic counts. Warnings have no
 * existing signal anywhere in RuntimeState — rendered as "—" (unknown),
 * never a fabricated 0. Tests row shows the last persisted test run.
 */
export function DiagnosticsPanel({
  lspServers,
  diagnosticsByPath,
  lastTestResult,
  width,
  rows,
}: DiagnosticsPanelProps): React.JSX.Element {
  const lspErrors = lspServers.reduce((sum, s) => sum + s.errorCount, 0);
  const pathErrors = Object.values(diagnosticsByPath ?? {}).reduce((sum, n) => sum + n, 0);
  const errors = lspErrors + pathErrors;

  return (
    <Box flexDirection="column" width={width} height={rows}>
      <Row label="Errors" value={String(errors)} color={errors > 0 ? "red" : "green"} width={width} />
      <Row label="Warnings" value="—" color={themeColors().mutedForeground} width={width} />
      {lastTestResult ? (
        <Row
          label="Tests"
          value={
            lastTestResult.failed > 0
              ? `✗ ${lastTestResult.failed} of ${lastTestResult.passed + lastTestResult.failed}`
              : `✓ ${lastTestResult.passed}`
          }
          color={lastTestResult.failed > 0 ? "red" : "green"}
          width={width}
        />
      ) : (
        <Row label="Tests" value="—" color={themeColors().mutedForeground} width={width} />
      )}
    </Box>
  );
}
