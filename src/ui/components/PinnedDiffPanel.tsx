import React, { useMemo } from "react";
import { Box, Text } from "@nemesis-oss/termina-core";
import { ChatEntry } from "../../runtime/types.js";
import { themeColors } from "../layout/theme-map.js";

export interface PinnedDiffPanelProps {
  conversation: ChatEntry[];
  width: number;
  rows: number;
  /** One-line aggregate ("3 files changed · +72 −14 · Ctrl+D open diff") instead of the full diff body. */
  summary?: boolean;
}

type DiffEntry = Extract<ChatEntry, { kind: "diff_preview" }>;

function latestDiff(conversation: ChatEntry[]): DiffEntry | undefined {
  for (let i = conversation.length - 1; i >= 0; i--) {
    const entry = conversation[i];
    if (entry.kind === "diff_preview") return entry;
  }
  return undefined;
}

/** Center-column pinned panel content: always shows the most recent file diff, unlike the collapsible copy in the Activity Feed. Title/border chrome comes from the shared Panel wrapper. Callers don't mount this while no diff exists. */
export function PinnedDiffPanel({ conversation, width, rows, summary }: PinnedDiffPanelProps): React.JSX.Element {
  const entry = useMemo(() => latestDiff(conversation), [conversation]);
  const bodyRows = Math.max(0, rows - 2);

  if (summary) {
    const paths = new Set<string>();
    let additions = 0;
    let deletions = 0;
    for (const e of conversation) {
      if (e.kind !== "diff_preview") continue;
      paths.add(e.filePath);
      for (const line of e.diff.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions++;
        else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
      }
    }
    return (
      <Box height={1} width={width}>
        <Text wrap="truncate">
          <Text bold>
            {paths.size} file{paths.size === 1 ? "" : "s"} changed
          </Text>
          <Text color={themeColors().mutedForeground}> · </Text>
          <Text color={themeColors().success}>+{additions}</Text>
          <Text> </Text>
          <Text color={themeColors().error}>−{deletions}</Text>
          <Text color={themeColors().mutedForeground}> · Ctrl+D open diff</Text>
        </Text>
      </Box>
    );
  }

  if (!entry) {
    return (
      <Box flexDirection="column" width={width} height={rows} justifyContent="center">
        <Text color={themeColors().mutedForeground} dimColor>
          No changes yet
        </Text>
      </Box>
    );
  }

  const diffLines = entry.diff.split("\n").filter(Boolean).slice(0, bodyRows);
  const additions = diffLines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const deletions = diffLines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  const stats = `+${additions} -${deletions}`;
  const gap = Math.max(1, width - entry.filePath.length - stats.length - 1);

  return (
    <Box flexDirection="column" width={width} height={rows}>
      <Box height={1}>
        <Text bold wrap="truncate">
          {entry.filePath}
        </Text>
        <Text>{" ".repeat(gap)}</Text>
        <Text color={themeColors().success}>+{additions} </Text>
        <Text color={themeColors().error}>-{deletions}</Text>
      </Box>
      {diffLines.map((line, i) => {
        let color = "white";
        if (line.startsWith("+")) color = "green";
        else if (line.startsWith("-")) color = "red";
        else if (line.startsWith("@")) color = "cyan";
        return (
          <Box key={i} height={1}>
            <Text color={color} wrap="truncate">
              {line}
            </Text>
          </Box>
        );
      })}
      <Box justifyContent="flex-end" width={width}>
        <Text color={themeColors().mutedForeground} dimColor>
          1/1
        </Text>
      </Box>
    </Box>
  );
}
