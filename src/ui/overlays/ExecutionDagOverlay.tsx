import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { ExecutionNode } from "../../runtime/event-node.js";
import { parseSgrMouseEvent } from "../../interaction/mouse.js";
import { useTheme } from "../ui/hooks/use-theme.js";
import { OverlayFrame } from "./OverlayFrame.js";

export interface ExecutionDagOverlayProps {
  nodes: ExecutionNode[];
  width: number;
  rows: number;
  active: boolean;
  onClose(): void;
}

export function ExecutionDagOverlay({
  nodes,
  width,
  rows,
  active,
  onClose,
}: ExecutionDagOverlayProps): React.JSX.Element {
  const [index, setIndex] = useState(0);
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const theme = useTheme();

  // Real nodes only (see executionNodesFromState) — never placeholder activity.
  const flatNodes = nodes;

  const clampedIndex = Math.min(index, Math.max(0, flatNodes.length - 1));
  const selectedNode = flatNodes[clampedIndex];

  useInput(
    (input, key) => {
      const mouse = parseSgrMouseEvent(input);
      if (mouse) {
        if (mouse.button === "scroll_up") {
          setIndex(Math.max(0, clampedIndex - 1));
        } else if (mouse.button === "scroll_down") {
          setIndex(Math.min(flatNodes.length - 1, clampedIndex + 1));
        } else if (mouse.button === "left" && mouse.action === "press") {
          if (selectedNode) {
            setExpandedNodeId(expandedNodeId === selectedNode.id ? null : selectedNode.id);
          }
        }
        return;
      }

      if (key.escape || input === "q") {
        onClose();
      } else if (key.upArrow) {
        setIndex(Math.max(0, clampedIndex - 1));
      } else if (key.downArrow) {
        setIndex(Math.min(flatNodes.length - 1, clampedIndex + 1));
      } else if (key.return || key.rightArrow) {
        if (selectedNode) {
          setExpandedNodeId(selectedNode.id);
        }
      } else if (key.leftArrow) {
        setExpandedNodeId(null);
      }
    },
    { isActive: active },
  );

  return (
    <OverlayFrame title="Execution DAG Trace (Active Expanded, Collapsed History)" width={width} rows={rows}>
      <Box flexDirection="column" gap={0}>
        <Text color={theme.colors.info} bold>
          Execution Node History (Enter/→ Expand, ← Collapse):
        </Text>
        {flatNodes.length === 0 && (
          <Text color={theme.colors.mutedForeground}>
            No execution recorded yet — run a task to populate the trace.
          </Text>
        )}
        {flatNodes.map((node, i) => {
          const isSelected = i === clampedIndex;
          const isActiveNode = node.status === "running";
          const isExpanded = expandedNodeId === node.id || isActiveNode;
          const expandGlyph = isExpanded ? "▼ " : "▶ ";
          const statusSymbol = node.status === "completed" ? "✓" : node.status === "failed" ? "✗" : "▶";
          const statusColor =
            node.status === "completed"
              ? theme.colors.success
              : node.status === "failed"
                ? theme.colors.error
                : theme.colors.warning;

          return (
            <Box key={node.id} flexDirection="column" marginY={0}>
              <Box backgroundColor={isSelected ? theme.colors.selection : undefined}>
                <Text color={theme.colors.mutedForeground}>{expandGlyph}</Text>
                <Text color={statusColor} bold>
                  {statusSymbol}{" "}
                </Text>
                <Text bold={isSelected} color={isSelected ? theme.colors.selectionForeground : theme.colors.foreground}>
                  [{node.kind.toUpperCase()}] {node.title}
                </Text>
                {node.durationMs != null && (
                  <Text color={theme.colors.mutedForeground}>{` (${node.durationMs}ms)`}</Text>
                )}
              </Box>

              {isActiveNode && (
                <Box marginLeft={3} flexDirection="column">
                  <Text color={theme.colors.warning}>Executing... ██████████░░░░░░ 61%</Text>
                </Box>
              )}

              {isExpanded && node.details && !isActiveNode && (
                <Box marginLeft={3} flexDirection="column" borderStyle="single" borderColor={theme.colors.info}>
                  {node.details.model && <Text color={theme.colors.warning}>Model: {String(node.details.model)}</Text>}
                  {node.details.toolName && (
                    <Text color={theme.colors.success}>
                      Tool: {String(node.details.toolName)} ({JSON.stringify(node.details.toolArgs ?? {})})
                    </Text>
                  )}
                  {node.details.rationale && (
                    <Text color={theme.colors.mutedForeground}>Rationale: {String(node.details.rationale)}</Text>
                  )}
                  {node.details.prompt && (
                    <Text color={theme.colors.foreground}>Prompt: {String(node.details.prompt)}</Text>
                  )}
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.colors.mutedForeground}>↑/↓ Navigate Enter/→ Expand ← Collapse Esc Close</Text>
      </Box>
    </OverlayFrame>
  );
}
