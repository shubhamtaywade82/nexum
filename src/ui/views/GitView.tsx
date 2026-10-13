import React from "react";
import { Box, Text } from "@nemesis-oss/termina-core";
import { GitFileChange } from "../../runtime/types.js";
import { elidePath, tail } from "../layout/truncate.js";
import { ViewProps } from "./ConversationView.js";
import { themeColors } from "../layout/theme-map.js";

const STATUS_GLYPH: Record<GitFileChange["status"], { glyph: string; color: keyof ReturnType<typeof themeColors> }> = {
  modified: { glyph: "M", color: "warning" },
  added: { glyph: "A", color: "success" },
  deleted: { glyph: "D", color: "error" },
  renamed: { glyph: "R", color: "primary" },
};

/** Git: branch state, ahead/behind, staged and modified files, diff stat. */
export function GitView({ state, width, rows, detail }: ViewProps): React.JSX.Element {
  const { git } = state;
  const fileRows = Math.max(0, rows - 1);
  const files = tail(git.files, fileRows);
  const additions = git.files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const deletions = git.files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  return (
    <Box flexDirection="column" height={rows}>
      <Text wrap="truncate">
        <Text color={themeColors().primary} bold>{`⎇ ${git.branch || "(no branch)"}`}</Text>
        {(git.ahead > 0 || git.behind > 0) && (
          <Text color={themeColors().warning}>{`  ↑${git.ahead} ↓${git.behind}`}</Text>
        )}
        <Text color={themeColors().mutedForeground}>{`  ${git.files.length} changed`}</Text>
        {detail !== "compact" && (additions > 0 || deletions > 0) && (
          <>
            <Text color={themeColors().success}>{`  +${additions}`}</Text>
            <Text color={themeColors().error}>{` -${deletions}`}</Text>
          </>
        )}
      </Text>
      {files.map((file) => {
        const s = STATUS_GLYPH[file.status];
        return (
          <Text key={file.path} wrap="truncate">
            <Text
              color={file.staged ? themeColors().success : themeColors()[s.color]}
            >{` ${file.staged ? "●" : "○"} ${s.glyph} `}</Text>
            <Text>{elidePath(file.path, Math.max(10, width - 18))}</Text>
            {detail === "full" && file.additions != null && (
              <>
                <Text color={themeColors().success}>{`  +${file.additions}`}</Text>
                <Text color={themeColors().error}>{` -${file.deletions ?? 0}`}</Text>
              </>
            )}
          </Text>
        );
      })}
    </Box>
  );
}
