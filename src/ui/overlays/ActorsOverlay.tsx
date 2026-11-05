import React from "react";
import { Box, Text } from "@nemesis-oss/termina-core";
import { ACTOR_IDS, RuntimeState } from "../../runtime/types.js";
import { semanticColor } from "../layout/theme-map.js";
import { useTheme } from "../ui/hooks/use-theme.js";
import { OverlayFrame } from "./OverlayFrame.js";

export interface ActorsOverlayProps {
  state: RuntimeState;
  width: number;
  rows: number;
}

export function ActorsOverlay({ state, width, rows }: ActorsOverlayProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <OverlayFrame title="Actors — all alive" width={width} rows={rows}>
      {ACTOR_IDS.map((id) => {
        const actor = state.actors[id];
        return (
          <Box key={id}>
            <Box width={14}>
              <Text>{id}</Text>
            </Box>
            <Box width={10}>
              <Text color={semanticColor(actor.health)}>{actor.health}</Text>
            </Box>
            <Text color={theme.colors.mutedForeground}>{actor.detail}</Text>
          </Box>
        );
      })}
    </OverlayFrame>
  );
}
