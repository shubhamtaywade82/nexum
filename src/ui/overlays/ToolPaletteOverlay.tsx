import React from "react";
import { Box } from "@nemesis-oss/termina-core";
import { UniversalPicker } from "./UniversalPicker.js";
import { StatusMessage } from "../ui/status-message.js";
import { OverlayFrame } from "./OverlayFrame.js";

export interface ToolInfo {
  name: string;
  description: string;
  category: string;
}

export interface ToolPaletteOverlayProps {
  tools: ToolInfo[];
  width: number;
  rows: number;
  active: boolean;
  onSelect(name: string): void;
}

/** Ctrl+I / "/tools" — browse every registered tool, filterable by name or category. */
export function ToolPaletteOverlay({
  tools,
  width,
  rows,
  active,
  onSelect,
}: ToolPaletteOverlayProps): React.JSX.Element {
  if (tools.length === 0) {
    return (
      <OverlayFrame title="Tools" width={width} rows={rows}>
        <Box>
          <StatusMessage variant="warning">No tools registered.</StatusMessage>
        </Box>
      </OverlayFrame>
    );
  }
  const sorted = [...tools].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return (
    <UniversalPicker
      title="Tools"
      items={sorted.map((t) => ({
        id: t.name,
        label: t.name,
        detail: `${t.category} · ${t.description}`,
      }))}
      width={width}
      rows={rows}
      active={active}
      placeholder="Type to filter by name or category…"
      emptyText="No matching tools"
      onSubmit={(ids) => {
        if (ids[0]) onSelect(ids[0]);
      }}
    />
  );
}
