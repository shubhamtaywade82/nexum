import React from "react";
import { Text } from "@nemesis-oss/termina-core";
import { useTheme } from "../ui/hooks/use-theme.js";
import type { Theme } from "../ui/types.js";

const STATUS_GLYPH: Record<string, string> = {
  pending: "○",
  running: "▶",
  completed: "✓",
  failed: "✗",
  skipped: "↷",
  waiting: "○",
  approved: "✓",
  rejected: "✗",
  pending_review: "○",
  healthy: "✓",
  active: "▶",
  error: "✗",
  thinking: "○",
  muted: "—",
};

/** Map a Nexum status word onto the semantic theme tokens. */
function statusColor(status: string, theme: Theme): string {
  switch (status) {
    case "completed":
    case "approved":
    case "healthy":
      return theme.colors.success;
    case "running":
    case "active":
      return theme.colors.primary;
    case "failed":
    case "rejected":
    case "error":
      return theme.colors.error;
    case "skipped":
    case "waiting":
    case "pending_review":
      return theme.colors.warning;
    case "thinking":
      return theme.colors.accent;
    default:
      // pending, muted, unknown
      return theme.colors.mutedForeground;
  }
}

interface StatusChipProps {
  status: string;
  label?: string;
}

export function StatusChip({ status, label }: StatusChipProps): React.JSX.Element {
  const theme = useTheme();
  const glyph = STATUS_GLYPH[status] ?? "?";
  return <Text color={statusColor(status, theme)}>{label ? `${glyph} ${label}` : glyph}</Text>;
}
