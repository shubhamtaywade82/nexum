import React from "react";
import { Box, Text } from "@nemesis-oss/termina-core";
import { MISSION_PHASE_LABELS, MissionState } from "../../runtime/types.js";
import { STEP_GLYPH, glyphForStepStatus } from "../layout/step-glyphs.js";
import { tail, truncate } from "../layout/truncate.js";
import { themeColors } from "../layout/theme-map.js";

export interface MissionPanelProps {
  mission: MissionState;
  width: number;
  rows: number;
  now?: number;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function phaseDuration(phase: MissionState["phases"][number], now: number): string | null {
  if (!phase.startedAt) return null;
  return formatElapsed((phase.endedAt ?? now) - phase.startedAt);
}

/** Left-column Mission panel content: whole-mission phases (flat, with elapsed durations), Execute's live substeps indented while it's running. Title/border chrome comes from the shared Panel wrapper. */
export function MissionPanel({ mission, width, rows, now = Date.now() }: MissionPanelProps): React.JSX.Element {
  if (!mission.goal) {
    // No mission yet — a centered hint beats 8 rows of pending checkboxes
    // for something that hasn't started. DashboardView sizes the panel to
    // this compact form (see its missionOuter math).
    return (
      <Box flexDirection="column" width={width} height={rows} justifyContent="center" alignItems="center">
        <Text color={themeColors().mutedForeground} dimColor>
          No active mission
        </Text>
        <Text color={themeColors().mutedForeground} dimColor>
          Start one with /plan {"<goal>"}
        </Text>
      </Box>
    );
  }

  const started = mission.phases[0]?.startedAt;
  const totalElapsed = started ? formatElapsed(now - started) : null;
  const executePhase = mission.phases.find((p) => p.id === "execute");
  // Derived phases (validate/repair/review) only become real once Execute
  // finishes — until then they're speculation, not a checklist worth 3 rows.
  const executeDone = executePhase?.status === "completed" || executePhase?.status === "failed";
  const phases = mission.phases.filter(
    (p) => !(p.status === "pending" && !executeDone && (p.id === "validate" || p.id === "repair" || p.id === "review")),
  );
  const showSteps = executePhase?.status === "running" && mission.steps.length > 0;
  // Rows left under goal(1) + phase list for Execute's live substeps.
  const stepBudget = Math.max(0, rows - 1 - phases.length);
  const steps = showSteps ? tail(mission.steps, stepBudget) : [];

  return (
    <Box flexDirection="column" width={width} height={rows}>
      <Box height={1}>
        <Text wrap="truncate" color={themeColors().info}>
          {truncate(mission.goal, width - (totalElapsed ? totalElapsed.length + 1 : 0))}
        </Text>
        {totalElapsed && (
          <Text color={themeColors().mutedForeground} dimColor>
            {" "}
            {totalElapsed}
          </Text>
        )}
      </Box>
      {phases.map((phase) => {
        const g = STEP_GLYPH[phase.status];
        const duration = phaseDuration(phase, now);
        const label = MISSION_PHASE_LABELS[phase.id];
        const gap = Math.max(1, width - 3 - label.length - (duration?.length ?? 0));
        return (
          <Box key={phase.id} height={1}>
            <Text color={g.color}>{` ${g.glyph} `}</Text>
            <Text color={phase.status === "running" ? "blue" : undefined}>{label}</Text>
            {duration && (
              <>
                <Text>{" ".repeat(gap)}</Text>
                <Text color={themeColors().mutedForeground} dimColor>
                  {duration}
                </Text>
              </>
            )}
          </Box>
        );
      })}
      {showSteps &&
        steps.map((step) => {
          const g = glyphForStepStatus(step.status);
          return (
            <Box key={step.id} height={1} paddingLeft={3}>
              <Text color={themeColors().mutedForeground} dimColor>
                {"── "}
              </Text>
              <Text color={g.color}>{`${g.glyph} `}</Text>
              <Text wrap="truncate" color={g.color === "blue" ? "blue" : undefined}>
                {truncate(step.description, Math.max(4, width - 9))}
              </Text>
            </Box>
          );
        })}
    </Box>
  );
}
