import React from "react";
import { Box } from "@nemesis-oss/termina-core";
import { UniversalPicker } from "./UniversalPicker.js";
import { StatusMessage } from "../ui/status-message.js";
import { OverlayFrame } from "./OverlayFrame.js";
import { SessionMeta } from "../../runtime/session.js";

export interface SessionHistoryProps {
  sessions: SessionMeta[];
  width: number;
  rows: number;
  active: boolean;
  onSelect(id: string): void;
}

function relativeTime(at: number): string {
  const deltaMs = Date.now() - at;
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Ctrl+H / "/history" — browse and reload past conversations. */
export function SessionHistory({ sessions, width, rows, active, onSelect }: SessionHistoryProps): React.JSX.Element {
  if (sessions.length === 0) {
    return (
      <OverlayFrame title="Session History" width={width} rows={rows}>
        <Box>
          <StatusMessage variant="warning">No past conversations yet.</StatusMessage>
        </Box>
      </OverlayFrame>
    );
  }
  return (
    <UniversalPicker
      title="Session History"
      items={sessions.map((s) => ({
        id: s.id,
        label: s.firstUserLine,
        detail: `${relativeTime(s.updatedAt)} · ${s.messageCount} msgs`,
      }))}
      width={width}
      rows={rows}
      active={active}
      placeholder="Type to filter conversations…"
      emptyText="No matching conversations."
      onSubmit={(ids) => {
        if (ids[0]) onSelect(ids[0]);
      }}
    />
  );
}
