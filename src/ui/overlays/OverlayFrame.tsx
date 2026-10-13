import React from "react";
import { Box, Text } from "@nemesis-oss/termina-core";
import { useTheme } from "../ui/hooks/use-theme.js";

export interface OverlayFrameProps {
  title: string;
  width: number;
  rows: number;
  children: React.ReactNode;
}

/**
 * Overlays are ephemeral: they render inside the Active View zone, never
 * replace runtime state, and always close with Esc. Frame chrome follows the
 * active theme (primary border/title, muted close hint).
 */
export function OverlayFrame({ title, width, rows, children }: OverlayFrameProps): React.JSX.Element {
  const theme = useTheme();
  const innerWidth = Math.max(20, Math.min(width - 4, 100));
  return (
    <Box flexDirection="column" height={rows} alignItems="center" justifyContent="center">
      <Box
        flexDirection="column"
        width={innerWidth}
        borderStyle="single"
        borderColor={theme.colors.primary}
        paddingX={1}
      >
        <Box justifyContent="space-between">
          <Text color={theme.colors.primary} bold>
            {title}
          </Text>
          <Text color={theme.colors.mutedForeground}>Esc Close</Text>
        </Box>
        {children}
      </Box>
    </Box>
  );
}
