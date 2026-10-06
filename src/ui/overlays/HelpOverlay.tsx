import React from "react";
import { Box, Text } from "ink";
import { KeyboardShortcuts, type Shortcut } from "../ui/keyboard-shortcuts.js";
import { useTheme } from "../ui/hooks/use-theme.js";
import { OverlayFrame } from "./OverlayFrame.js";

const KEYS: Shortcut[] = [
  { key: "1-5", description: "Focus a primary tab (Chat, Plan, Tasks, Changes, Logs)" },
  { key: "Tab / Shift+Tab", description: "Next / previous view" },
  { key: "Ctrl+P", description: "Command palette" },
  { key: "Ctrl+B", description: "Actors overlay" },
  { key: "Ctrl+Y", description: "Execution DAG trace" },
  { key: "Ctrl+M", description: "Switch model" },
  { key: "Ctrl+F", description: "Search everywhere" },
  { key: "z", description: "Zoom active view" },
  { key: "/", description: "Slash commands (with autocomplete)" },
  { key: "@", description: "Prompt templates" },
  { key: "↑ / ↓", description: "Prompt history" },
  { key: "Tab (in prompt)", description: "Accept ghost text" },
  { key: "Esc", description: "Close overlay / cancel" },
  { key: "?", description: "This help" },
  { key: "q", description: "Quit" },
];

export function HelpOverlay({ width, rows }: { width: number; rows: number }): React.JSX.Element {
  const theme = useTheme();
  return (
    <OverlayFrame title="Help — Keys" width={width} rows={rows}>
      <KeyboardShortcuts shortcuts={KEYS.slice(0, Math.max(3, rows - 4))} />
      <Box marginTop={1}>
        <Text color={theme.colors.mutedForeground} italic>
          Changing focus never stops background actors.
        </Text>
      </Box>
    </OverlayFrame>
  );
}
