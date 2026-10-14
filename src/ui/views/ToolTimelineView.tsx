import React from "react";
import { Box, Text } from "@nemesis-oss/termina-core";
import { ViewProps } from "./ConversationView.js";
import { themeColors } from "../layout/theme-map.js";

export function ToolTimelineView({ state, rows }: ViewProps): React.JSX.Element {
  const { toolCalls } = state;
  const maxRows = Math.max(1, rows - 2);
  const visible = toolCalls.slice(-maxRows);

  if (visible.length === 0) {
    return (
      <Box flexDirection="column" height={rows}>
        <Text color={themeColors().mutedForeground}>No tool calls yet.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={rows}>
      <Box height={1} marginBottom={1}>
        <Text bold color={themeColors().accent}>
          Tool Execution Timeline
        </Text>
      </Box>
      {visible.map((call, idx) => {
        const time = new Date(call.startedAt);
        const timeStr = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}:${String(time.getSeconds()).padStart(2, "0")}`;
        const isLast = idx === visible.length - 1;
        const connector = isLast ? "└─" : "├─";

        let statusText: string;
        let statusColor = "gray";
        if (call.status === "running") {
          statusText = " ⏳ running";
          statusColor = "yellow";
        } else if (call.status === "failed") {
          statusText = " ✗ failed";
          statusColor = "red";
        } else {
          const duration = call.endedAt ? `${((call.endedAt - call.startedAt) / 1000).toFixed(1)}s` : "";
          statusText = duration ? ` (${duration})` : "";
        }

        return (
          <Box key={call.id} height={1}>
            <Text>
              <Text color={themeColors().mutedForeground}>[{timeStr}] </Text>
              <Text color={themeColors().info}>{connector} </Text>
              <Text bold color={call.status === "failed" ? "red" : call.status === "running" ? "yellow" : "green"}>
                {call.name}
              </Text>
              <Text color={statusColor}>{statusText}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
