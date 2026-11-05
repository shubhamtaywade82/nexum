import React from "react";
import { Box, Text } from "@nemesis-oss/termina-core";
import { tail, truncate } from "../layout/truncate.js";
import { ViewProps } from "./ConversationView.js";
import { themeColors } from "../layout/theme-map.js";

/** MCP: connected servers, latency, errors, exposed tools. */
export function McpView({ state, width, rows, detail }: ViewProps): React.JSX.Element {
  const servers = tail(state.mcpServers, rows);
  if (servers.length === 0) {
    return (
      <Box height={rows}>
        <Text color={themeColors().mutedForeground}>No MCP servers configured.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" height={rows}>
      {servers.map((server) => (
        <Text key={server.name} wrap="truncate">
          <Text color={server.connected ? "green" : "red"}>{server.connected ? " ● " : " ○ "}</Text>
          <Text bold>{server.name}</Text>
          <Text color={themeColors().mutedForeground}>{`  ${server.latencyMs}ms`}</Text>
          {server.errors > 0 && <Text color={themeColors().error}>{`  ${server.errors} errors`}</Text>}
          {detail !== "compact" && server.tools.length > 0 && (
            <Text
              color={themeColors().mutedForeground}
            >{`  ${truncate(server.tools.join(", "), Math.max(10, width - server.name.length - 20))}`}</Text>
          )}
        </Text>
      ))}
    </Box>
  );
}
