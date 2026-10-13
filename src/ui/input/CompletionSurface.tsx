import React from "react";
import { Box, Text } from "@nemesis-oss/termina-core";
import { CompletionItem } from "../../interaction/completion.js";
import { visibleWindow } from "../../interaction/picker.js";
import { MAX_COMPLETION_ROWS } from "../layout/density.js";
import { CompletionRow } from "./CompletionRow.js";
import { useTheme } from "../ui/hooks/use-theme.js";

export interface CompletionSurfaceProps {
  items: CompletionItem[];
  selectedIndex: number;
  width: number;
  maxVisible?: number;
}

/**
 * Vertically-stacked completion list rendered directly above PromptBar.
 * Reuses the picker's `visibleWindow` for scroll positioning and caps
 * visible rows at MAX_COMPLETION_ROWS to prevent layout instability. Always
 * ends in a one-line keybinding hint row — callers budgeting fixed rows for
 * this component must add 1 for it (see App.tsx's completionChrome).
 *
 * Returns null when there are no items — the parent's conditional render
 * should already guard this, but the component is defensive.
 */
export function CompletionSurface({
  items,
  selectedIndex,
  width,
  maxVisible = MAX_COMPLETION_ROWS,
}: CompletionSurfaceProps): React.JSX.Element | null {
  if (items.length === 0) return null;
  const theme = useTheme();

  const clamped = Math.max(0, Math.min(selectedIndex, items.length - 1));
  const { start, items: visible } = visibleWindow(items, clamped, maxVisible);
  const showCounter = items.length > maxVisible;

  return (
    <Box flexDirection="column">
      {visible.map((item, i) => {
        const absoluteIdx = start + i;
        const selected = absoluteIdx === clamped;
        return <CompletionRow key={item.insert} item={item} selected={selected} width={width} />;
      })}
      {showCounter && (
        <Box justifyContent="flex-end" width={width}>
          <Text color={theme.colors.mutedForeground} dimColor>
            {`${clamped + 1} / ${items.length}`}
          </Text>
        </Box>
      )}
      <Box height={1}>
        <Text color={theme.colors.mutedForeground} dimColor>
          ↑↓ navigate → select tab complete esc close ctrl+c cancel
        </Text>
      </Box>
    </Box>
  );
}
