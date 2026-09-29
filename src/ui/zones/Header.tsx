import React from "react";
import { Box, Spacer, Text } from "ink";
import { AGENT_MODE_LABELS, RuntimeState } from "../../runtime/types.js";
import { truncate } from "../layout/truncate.js";
import { useTheme } from "../ui/hooks/use-theme.js";

export interface HeaderProps {
  state: RuntimeState;
  width: number;
  now?: number;
}

function formatClock(now: number): string {
  const d = new Date(now);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/**
 * Top bar: "nexum v0.1.0 │ Mission: <goal>" on the left, "MODE: X
 * MODEL: Y HH:MM:SS" right-aligned. MODE shows the real AgentMode label
 * (Code/Ask/Architect/...), not a fabricated build-status word.
 */
export function Header({ state, width, now = Date.now() }: HeaderProps): React.JSX.Element {
  const theme = useTheme();
  const modeLabel = AGENT_MODE_LABELS[state.agentMode].label.toUpperCase();
  // lastTurnModel reflects what actually answered the last turn (routedTier/routedModel
  // from onModelUsed), which can differ from state.model.name (the configured primary) —
  // e.g. "quick" routing serves a small local model while the primary stays cloud.
  const modelName = state.lastTurnModel ?? state.model.name ?? "-";
  const clock = formatClock(now);

  const showSubtitle = width >= 95;
  const leftPrefix = showSubtitle ? "⚡ Nexum · Autonomous Coding Agent" : "⚡ Nexum";
  const missionPrefix = state.mission.goal ? "  │ Mission: " : "";
  const rightText = `MODE: ${modeLabel}   MODEL: ${modelName}   ${clock}`;

  const missionBudget = Math.max(0, width - leftPrefix.length - missionPrefix.length - rightText.length - 2);
  const mission = state.mission.goal && missionBudget > 0 ? truncate(state.mission.goal, missionBudget) : "";

  return (
    <Box width={width} height={1}>
      <Text bold color={theme.colors.info}>
        ⚡ Nexum
      </Text>
      {showSubtitle && (
        <Text color={theme.colors.mutedForeground} dimColor>
          {" "}
          · Autonomous Coding Agent
        </Text>
      )}
      {mission && (
        <>
          <Text color={theme.colors.mutedForeground}>{"  │ "}</Text>
          <Text color={theme.colors.mutedForeground}>Mission: </Text>
          <Text color={theme.colors.success}>{mission}</Text>
        </>
      )}
      <Spacer />
      <Text color={theme.colors.mutedForeground}>MODE: </Text>
      <Text bold color={theme.colors.accent}>
        {modeLabel}
      </Text>
      <Text color={theme.colors.mutedForeground}>{"   MODEL: "}</Text>
      <Text color={theme.colors.primary}>{modelName}</Text>
      <Text color={theme.colors.mutedForeground}>{"   "}</Text>
      <Text color={theme.colors.mutedForeground} dimColor>
        {clock}
      </Text>
    </Box>
  );
}
