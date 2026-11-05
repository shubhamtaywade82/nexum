import React from "react";
import { Box, Text } from "@nemesis-oss/termina-core";
import { GitFileChange } from "../../runtime/types.js";
import { themeColors } from "../layout/theme-map.js";

export interface FilesPanelProps {
  files: GitFileChange[];
  width: number;
  rows: number;
}

const STATUS_LETTER: Record<GitFileChange["status"], { letter: string; color: keyof ReturnType<typeof themeColors> }> =
  {
    modified: { letter: "M", color: "warning" },
    added: { letter: "A", color: "success" },
    deleted: { letter: "D", color: "error" },
    renamed: { letter: "R", color: "info" },
  };

/** Right-column Files panel content: renders state.git.files directly, no new state. Title/border chrome comes from the shared Panel wrapper. */
export function FilesPanel({ files, width, rows }: FilesPanelProps): React.JSX.Element {
  const maxVisible = Math.max(0, rows - 1);
  const visible = files.slice(0, maxVisible);
  const remaining = files.length - visible.length;

  return (
    <Box flexDirection="column" width={width} height={rows}>
      {files.length === 0 ? (
        <Box height={rows} justifyContent="center" alignItems="center">
          <Text color={themeColors().mutedForeground} dimColor>
            Working tree clean
          </Text>
        </Box>
      ) : (
        visible.map((f) => {
          const s = STATUS_LETTER[f.status];
          return (
            <Box key={f.path} height={1}>
              <Text color={themeColors()[s.color]} bold>
                {s.letter}{" "}
              </Text>
              <Text wrap="truncate">{f.path}</Text>
            </Box>
          );
        })
      )}
      {remaining > 0 && (
        <Box height={1}>
          <Text color={themeColors().mutedForeground} dimColor>
            ... and {remaining} more
          </Text>
        </Box>
      )}
    </Box>
  );
}
