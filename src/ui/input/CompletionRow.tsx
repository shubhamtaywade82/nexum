import React from "react";
import { Box, Text } from "ink";
import { CompletionItem } from "../../interaction/completion.js";
import { useTheme } from "../ui/hooks/use-theme.js";

export interface CompletionRowProps {
  item: CompletionItem;
  selected: boolean;
  width: number;
}

/**
 * A single row in the CompletionSurface. Layout:
 *   "› /command      description                 Category"
 * The selected row gets a full-width background highlight (not just colored
 * text) — matches how a real terminal-menu selection reads.
 */
const KIND_GLYPH: Record<NonNullable<CompletionItem["kind"]>, string> = {
  command: "⌘",
  argument: "→",
  template: "@",
  history: "⏱",
  prompt: "✦",
};

export function CompletionRow({ item, selected, width }: CompletionRowProps): React.JSX.Element {
  const theme = useTheme();
  const GUTTER = 4; // "› ⌘ " or "  ⌘ "
  const LABEL_COL = 20; // fixed label column
  const GROUP_COL = item.group ? 16 : 0; // right-aligned category column
  const detailSpace = Math.max(0, width - GUTTER - LABEL_COL - GROUP_COL - 2);
  const bg = selected ? theme.colors.selection : undefined;

  return (
    <Box height={1} width={width} backgroundColor={bg}>
      <Box width={GUTTER}>
        <Text color={selected ? theme.colors.selectionForeground : undefined} backgroundColor={bg}>
          {selected ? "› " : "  "}
        </Text>
        <Text
          color={selected ? theme.colors.selectionForeground : theme.colors.mutedForeground}
          dimColor={!selected}
          backgroundColor={bg}
        >
          {`${item.kind ? KIND_GLYPH[item.kind] : " "} `}
        </Text>
      </Box>
      <Box width={LABEL_COL}>
        <Text
          bold={selected}
          color={selected ? theme.colors.selectionForeground : undefined}
          backgroundColor={bg}
          wrap="truncate"
        >
          {item.label}
        </Text>
      </Box>
      {detailSpace > 0 && (
        <Box width={detailSpace}>
          <Text
            color={selected ? theme.colors.selectionForeground : theme.colors.mutedForeground}
            backgroundColor={bg}
            wrap="truncate"
          >
            {item.detail}
          </Text>
        </Box>
      )}
      {item.group && GROUP_COL > 0 && (
        <Box width={GROUP_COL} justifyContent="flex-end">
          <Text
            color={selected ? theme.colors.selectionForeground : theme.colors.mutedForeground}
            dimColor={!selected}
            backgroundColor={bg}
            wrap="truncate"
          >
            {item.group}
          </Text>
        </Box>
      )}
    </Box>
  );
}
