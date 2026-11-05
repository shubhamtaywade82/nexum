import React from "react";
import { Box, Text } from "@nemesis-oss/termina-core";
import { ViewProps } from "./ConversationView.js";
import { AGENT_MODE_LABELS, THEME_ORDER } from "../../runtime/types.js";
import { themeColors } from "../layout/theme-map.js";

export function SettingsView({ state, rows }: ViewProps): React.JSX.Element {
  const am = AGENT_MODE_LABELS[state.agentMode];

  return (
    <Box flexDirection="column" height={rows}>
      <Box height={1} marginBottom={1}>
        <Text bold>Settings</Text>
      </Box>
      <Box height={1}>
        <Text>
          <Text bold>Model: </Text>
          <Text>{state.model.name || "(not set)"}</Text>
        </Text>
      </Box>
      <Box height={1}>
        <Text>
          <Text bold>Provider: </Text>
          <Text>{state.model.provider}</Text>
        </Text>
      </Box>
      <Box height={1}>
        <Text>
          <Text bold>Mode: </Text>
          <Text color={themeColors().success}>{am.label}</Text>
          <Text color={themeColors().mutedForeground}> — {am.description}</Text>
        </Text>
      </Box>
      <Box height={1}>
        <Text>
          <Text bold>Theme: </Text>
          <Text color={themeColors().primary}>{state.theme}</Text>
          <Text color={themeColors().mutedForeground}> — /theme to switch ({THEME_ORDER.length} built-ins)</Text>
        </Text>
      </Box>
      <Box height={1}>
        <Text>
          <Text bold>Context: </Text>
          <Text color={themeColors().mutedForeground}>
            {state.model.contextUsed}/{state.model.contextLimit} tokens
            {state.model.contextLimit > 0 &&
              ` (${Math.round((state.model.contextUsed / state.model.contextLimit) * 100)}%)`}
          </Text>
        </Text>
      </Box>
      <Box height={1}>
        <Text>
          <Text bold>Skills: </Text>
          <Text color={themeColors().mutedForeground}>{state.skills.filter((s) => s.active).length} active</Text>
        </Text>
      </Box>
      <Box height={1}>
        <Text>
          <Text bold>MCP Servers: </Text>
          <Text color={themeColors().mutedForeground}>
            {state.mcpServers.length} configured, {state.mcpServers.filter((s) => s.connected).length} connected
          </Text>
        </Text>
      </Box>
      <Box height={1}>
        <Text>
          <Text bold>LSP: </Text>
          <Text color={themeColors().mutedForeground}>
            {state.lspServers.map((s) => `${s.language} (${s.status})`).join(", ") || "none"}
          </Text>
        </Text>
      </Box>
      <Box height={1}>
        <Text>
          <Text bold>Workspace: </Text>
          <Text color={themeColors().mutedForeground}>{state.session.workspace || "(none)"}</Text>
        </Text>
      </Box>
      {state.rails && (
        <Box height={1}>
          <Text>
            <Text bold>Rails: </Text>
            <Text color={themeColors().mutedForeground}>
              Status: {state.rails.status} — {state.rails.entityCount} entities
            </Text>
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={themeColors().mutedForeground} dimColor>
          Use Ctrl+P for quick actions, /mode to change agent mode
        </Text>
      </Box>
    </Box>
  );
}
