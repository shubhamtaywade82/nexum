import React from "react";
import { Box, Text } from "@nemesis-oss/termina-core";
import { LogLevel } from "../../runtime/types.js";
import { tail, truncate } from "../layout/truncate.js";
import { ViewProps } from "./ConversationView.js";
import { themeColors } from "../layout/theme-map.js";

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "gray",
  info: "blue",
  warn: "yellow",
  error: "red",
};

/** Logs: structured tool/model/system logs, newest at the bottom. */
export function LogsView({ state, width, rows, detail }: ViewProps): React.JSX.Element {
  const logs = tail(state.logs, rows);
  if (logs.length === 0) {
    return (
      <Box height={rows}>
        <Text color={themeColors().mutedForeground}>No log events.</Text>
      </Box>
    );
  }
  const showTime = detail === "expanded" || detail === "full";
  return (
    <Box flexDirection="column" height={rows}>
      {logs.map((log, i) => {
        const time = new Date(log.at);
        const stamp = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}:${String(
          time.getSeconds(),
        ).padStart(2, "0")}`;
        return (
          <Text key={`${log.at}-${i}`} wrap="truncate">
            {showTime && <Text color={themeColors().mutedForeground}>{`${stamp} `}</Text>}
            <Text color={LEVEL_COLOR[log.level]}>{log.level.toUpperCase().padEnd(5)}</Text>
            <Text color={themeColors().mutedForeground}>{` ${log.source} `}</Text>
            <Text>{truncate(log.message.replace(/\n/g, " ⏎ "), Math.max(10, width - 24))}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
