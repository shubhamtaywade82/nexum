import React from "react";
import { Box } from "@nemesis-oss/termina-core";
import { SkillMeta, SkillUsageStats } from "../../skills/types.js";
import { UniversalPicker } from "./UniversalPicker.js";
import { StatusMessage } from "../ui/status-message.js";
import { OverlayFrame } from "./OverlayFrame.js";

export interface SkillsOverlayProps {
  skills: SkillMeta[];
  usage?: Record<string, SkillUsageStats>;
  width: number;
  rows: number;
  active: boolean;
  onSelect(id: string): void;
}

/** Browse installed skills and pin one — reached via /skills or the command palette. */
export function SkillsOverlay({ skills, usage, width, rows, active, onSelect }: SkillsOverlayProps): React.JSX.Element {
  if (skills.length === 0) {
    return (
      <OverlayFrame title="Skills" width={width} rows={rows}>
        <Box>
          <StatusMessage variant="warning">No skills found in .nexum/skills or ~/.nexum/skills</StatusMessage>
        </Box>
      </OverlayFrame>
    );
  }
  return (
    <UniversalPicker
      title="Skills"
      items={skills.map((s) => ({
        id: s.id,
        label: s.name,
        detail: usage?.[s.id] ? `used ${usage[s.id].useCount}×` : s.tags.join(", "),
      }))}
      width={width}
      rows={rows}
      active={active}
      placeholder="Type to filter skills…"
      emptyText="No matching skills"
      onSubmit={(ids) => {
        if (ids[0]) onSelect(ids[0]);
      }}
    />
  );
}
