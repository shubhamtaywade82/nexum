import React from "react";
import { Box, Text } from "@nemesis-oss/termina-core";
import { tail, truncate } from "../layout/truncate.js";
import { STEP_GLYPH } from "../layout/step-glyphs.js";
import { ViewProps } from "./ConversationView.js";
import { themeColors } from "../layout/theme-map.js";

/** Execution: goal, steps, active tool, queue, ETA, reasoning summary. */
export function ExecutionView({ state, width, rows, detail }: ViewProps): React.JSX.Element {
  const { execution } = state;
  const headerRows = execution.goal ? 1 : 0;
  const toolRow = execution.activeTool || execution.queue.length > 0 ? 1 : 0;
  const reasoningRow = detail !== "compact" && execution.reasoning ? 1 : 0;
  const stepRows = Math.max(0, rows - headerRows - toolRow - reasoningRow);
  const steps = tail(execution.steps, stepRows);
  return (
    <Box flexDirection="column" height={rows}>
      {execution.goal ? (
        <Text wrap="truncate">
          <Text color={themeColors().primary} bold>
            Goal{" "}
          </Text>
          {truncate(execution.goal, width - 5)}
        </Text>
      ) : (
        <Text color={themeColors().mutedForeground}>No execution in progress.</Text>
      )}
      {steps.map((step) => {
        const s = STEP_GLYPH[step.status];
        return (
          <Text key={step.id} wrap="truncate">
            <Text color={s.color}>{` ${s.glyph} `}</Text>
            <Text color={step.status === "running" ? "blue" : undefined}>{truncate(step.description, width - 4)}</Text>
          </Text>
        );
      })}
      {toolRow > 0 && (
        <Text wrap="truncate">
          {execution.activeTool && (
            <>
              <Text color={themeColors().warning}>Tool:</Text>
              <Text>{execution.activeTool}</Text>
            </>
          )}
          {execution.queue.length > 0 && (
            <Text color={themeColors().mutedForeground}>{`  Queue: ${execution.queue.join(" → ")}`}</Text>
          )}
          {execution.etaSeconds != null && (
            <Text color={themeColors().mutedForeground}>{`  ETA ${execution.etaSeconds}s`}</Text>
          )}
        </Text>
      )}
      {reasoningRow > 0 && (
        <Text wrap="truncate" color={themeColors().mutedForeground} italic>
          {truncate(execution.reasoning.replace(/\n/g, " "), width)}
        </Text>
      )}
    </Box>
  );
}
