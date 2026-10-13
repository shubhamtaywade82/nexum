import React from "react";
import { Box, Text } from "@nemesis-oss/termina-core";
import { RuntimeState } from "../../runtime/types.js";
import { SessionMeta } from "../../runtime/session.js";

export interface ToolCategoryCount {
  category: string;
  count: number;
}

export interface SidebarProps {
  state: RuntimeState;
  sessions: SessionMeta[];
  toolCategories: ToolCategoryCount[];
  width: number;
  rows: number;
}

function SectionTitle({ text }: { text: string }): React.JSX.Element {
  return (
    <Box height={1}>
      <Text bold color="gray">
        {text}
      </Text>
    </Box>
  );
}

/** Persistent left panel — at-a-glance sessions/tools/skills, toggled with
 * Ctrl+N. Only rendered above a minimum terminal width (see App.tsx); the
 * bottom strips remain the source of truth on narrow terminals. */
export function Sidebar({ state, sessions, toolCategories, width, rows }: SidebarProps): React.JSX.Element {
  const activeSkills = state.skills.filter((s) => s.active);
  const innerWidth = Math.max(10, width - 2);

  return (
    <Box flexDirection="column" width={width} height={rows} paddingX={1}>
      <SectionTitle text="Sessions" />
      {sessions.length === 0 ? (
        <Box height={1}>
          <Text color="gray" dimColor>
            (none yet)
          </Text>
        </Box>
      ) : (
        sessions.slice(0, 5).map((s) => (
          <Box key={s.id} height={1}>
            <Text wrap="truncate" color="gray">
              {(s.firstUserLine || "(empty)").slice(0, innerWidth)}
            </Text>
          </Box>
        ))
      )}

      <Box height={1} />
      <SectionTitle text="Tools" />
      {toolCategories.length === 0 ? (
        <Box height={1}>
          <Text color="gray" dimColor>
            (none registered)
          </Text>
        </Box>
      ) : (
        toolCategories.slice(0, 8).map((c) => (
          <Box key={c.category} height={1}>
            <Text wrap="truncate" color="gray">
              {c.category} ({c.count})
            </Text>
          </Box>
        ))
      )}

      <Box height={1} />
      <SectionTitle text="Skills" />
      {activeSkills.length === 0 ? (
        <Box height={1}>
          <Text color="gray" dimColor>
            (none active)
          </Text>
        </Box>
      ) : (
        activeSkills.slice(0, 5).map((s) => (
          <Box key={s.id} height={1}>
            <Text wrap="truncate" color="cyan">
              {s.name}
            </Text>
          </Box>
        ))
      )}

      <Box height={1} />
      <Box>
        <Text color="gray" dimColor>
          Ctrl+H / Ctrl+O / /skills
        </Text>
      </Box>
    </Box>
  );
}
