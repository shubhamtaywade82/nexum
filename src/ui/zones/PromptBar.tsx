import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../ui/hooks/use-theme.js";

export interface PromptBarProps {
  text: string;
  cursor?: number;
  ghost: string;
  width: number;
  busy: boolean;
  /** Terminal window focus (see App.tsx's DECSET 1004 tracking). Defaults to
   * true so callers/tests that don't wire it up keep the solid-block cursor. */
  focused?: boolean;
}

function isPastedPlaceholder(lines: string[]): boolean {
  return lines.length > 0 && lines[0]!.startsWith("[Pasted text");
}

/**
 * How many terminal rows PromptBar will render for this text: 1 normally,
 * 2 when the "N more lines" / "N lines" indicator row shows. Callers that
 * budget fixed-chrome rows (see density.ts's activeViewRows) must account
 * for this so the Active View / overlays never overflow the terminal.
 */
export function promptBarRows(text: string): 1 | 2 {
  const lines = text.split("\n");
  const isPasted = isPastedPlaceholder(lines);
  const showMultiline = isPasted ? lines.length - 1 > 0 : lines.length > 1;
  return showMultiline ? 2 : 1;
}

/** Prompt input with multiline and caret navigation support. Shift+Enter inserts a newline. */
export function PromptBar({ text, cursor, ghost, width, busy, focused = true }: PromptBarProps): React.JSX.Element {
  const theme = useTheme();
  const promptGlyph = busy ? "◌" : ">";
  const lines = text.split("\n");
  const isPasted = isPastedPlaceholder(lines);
  const hiddenCount = isPasted ? lines.length - 1 : 0;
  const lastLine = isPasted ? lines[0]! : (lines[lines.length - 1] ?? "");
  const caret = cursor !== undefined ? Math.max(0, Math.min(cursor, text.length)) : text.length;

  // Calculate caret position on the last line (or single line)
  const lineStart = isPasted ? 0 : text.lastIndexOf("\n") + 1;
  const lineCaret = Math.max(0, caret - lineStart);

  const available = Math.max(1, width - 2);
  const beforeCaret = lastLine.slice(0, lineCaret);
  const atCaret = lastLine[lineCaret] ?? " ";
  const afterCaret = lineCaret < lastLine.length ? lastLine.slice(lineCaret + 1) : "";

  const ghostRoom = available - lastLine.length - 1;
  const visibleGhost = ghostRoom > 0 && !text.endsWith("\n") && caret === text.length ? ghost.slice(0, ghostRoom) : "";
  const showMultiline = isPasted ? hiddenCount > 0 : lines.length > 1;
  return (
    <Box flexDirection="column">
      {showMultiline && (
        <Box height={1}>
          <Text color={theme.colors.mutedForeground} dimColor>
            {isPasted
              ? `⏎ ${hiddenCount} line${hiddenCount !== 1 ? "s" : ""}`
              : `⏎ ${lines.length - 1} more line${lines.length > 2 ? "s" : ""}`}
          </Text>
        </Box>
      )}
      <Box height={1} width={width} justifyContent="space-between">
        <Box>
          <Text color={busy ? theme.colors.accent : theme.colors.success} bold>
            {promptGlyph}{" "}
          </Text>
          {text === "" ? (
            <Text>
              {focused ? <Text inverse> </Text> : <Text color={theme.colors.success}>│</Text>}
              <Text color={theme.colors.mutedForeground} dimColor>
                {" "}
                Type a message or / for commands...
              </Text>
            </Text>
          ) : (
            <Text>
              <Text>{beforeCaret}</Text>
              {focused ? <Text inverse>{atCaret}</Text> : <Text color={theme.colors.success}>│</Text>}
              <Text>{afterCaret}</Text>
              {visibleGhost ? <Text color={theme.colors.mutedForeground}>{visibleGhost}</Text> : null}
            </Text>
          )}
        </Box>
        {text === "" && width > 70 ? (
          <Text color={theme.colors.mutedForeground} dimColor>
            Tab complete · Shift+↵ newline
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
