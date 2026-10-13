import React from "react";
import { Box, Text } from "@nemesis-oss/termina-core";
import { ToolCall } from "../../runtime/types.js";
import { StatusChip } from "./StatusChip.js";
import { themeColors } from "../layout/theme-map.js";

export interface ToolsPanelProps {
  toolCalls: ToolCall[];
  width: number;
  rows: number;
}

interface ToolSummary {
  name: string;
  count: number;
  lastStatus: ToolCall["status"];
}

function summarize(toolCalls: ToolCall[]): ToolSummary[] {
  const byName = new Map<string, ToolSummary>();
  for (const call of toolCalls) {
    const existing = byName.get(call.name);
    if (existing) {
      existing.count += 1;
      existing.lastStatus = call.status;
    } else {
      byName.set(call.name, { name: call.name, count: 1, lastStatus: call.status });
    }
  }
  return [...byName.values()].sort((a, b) => b.count - a.count);
}

/** Left-column Tools panel content: per-tool invocation count + latest status, derived from state.toolCalls. Title/border chrome comes from the shared Panel wrapper. */
export function ToolsPanel({ toolCalls, width, rows }: ToolsPanelProps): React.JSX.Element {
  const summaries = summarize(toolCalls);
  const visible = summaries.slice(0, Math.max(0, rows - 1));

  return (
    <Box flexDirection="column" width={width} height={rows}>
      {visible.length === 0 ? (
        <Box height={Math.max(1, rows - 1)} justifyContent="center" alignItems="center">
          <Text color={themeColors().mutedForeground} dimColor>
            No tool calls yet
          </Text>
        </Box>
      ) : (
        visible.map((t) => {
          const countText = `(${t.count})`;
          const gap = Math.max(1, width - 2 - t.name.length - countText.length);
          return (
            <Box key={t.name} height={1}>
              <StatusChip status={t.lastStatus} />
              <Text wrap="truncate"> {t.name}</Text>
              <Text>{" ".repeat(gap)}</Text>
              <Text color={themeColors().mutedForeground} dimColor>
                {countText}
              </Text>
            </Box>
          );
        })
      )}
      <Box height={1}>
        <Text color={themeColors().info} dimColor>
          View all tools... (/tools)
        </Text>
      </Box>
    </Box>
  );
}
