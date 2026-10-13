import React from "react";
import { Box } from "@nemesis-oss/termina-core";
import { ConversationView, ViewProps } from "./ConversationView.js";
import { MissionPanel } from "../components/MissionPanel.js";
import { ToolsPanel } from "../components/ToolsPanel.js";
import { PinnedDiffPanel } from "../components/PinnedDiffPanel.js";
import { FilesPanel } from "../components/FilesPanel.js";
import { DiagnosticsPanel } from "../components/DiagnosticsPanel.js";
import { Section, Rule, VDivider } from "../components/Section.js";
import { layoutPhase, railsForPhase } from "../layout/rails.js";

/** Contextual rails need real room; below this the plain stream is strictly better. */
export const MIN_WIDTH_FOR_DASHBOARD = 130;

const SIDE_WIDTH = 30;
const GAP = 1; // one blank column either side of each vertical divider

/**
 * Conversation-first dashboard: the activity stream always owns the center
 * (full width at idle); side rails appear only when the current engineering
 * phase makes them relevant (see layout/rails.ts).
 * Below MIN_WIDTH_FOR_DASHBOARD, falls back to the plain Conversation view —
 * narrow terminals already reach the same data via /git, /tasks, etc.
 */
export function DashboardView({ state, width, rows, detail, now }: ViewProps): React.JSX.Element {
  if (width < MIN_WIDTH_FOR_DASHBOARD) {
    return <ConversationView state={state} width={width} rows={rows} detail={detail} now={now} />;
  }

  const rails = railsForPhase(layoutPhase(state));
  const hasDiff = state.conversation.some((e) => e.kind === "diff_preview");
  const showDiffSummary = hasDiff && rails.right !== "diff";

  const rightWidth = rails.right === "diff" ? Math.floor(width * 0.45) : SIDE_WIDTH;
  const gutter = 1 + GAP * 2; // divider + gap either side
  const centerWidth = Math.max(
    20,
    width - (rails.left ? SIDE_WIDTH + gutter : 0) - (rails.right ? rightWidth + gutter : 0),
  );

  // Center: the stream absorbs everything; when diffs exist but the diff
  // rail isn't up, a one-line summary (plus its rule) sits under the feed.
  const summaryRows = showDiffSummary ? 2 : 0;
  const feedSection = Math.max(4, rows - summaryRows);

  // Left rail: Tools gets a small fixed slice (title + up to 7 rows);
  // Mission absorbs the rest — it's the thing you're actually steering.
  const toolsSection = Math.min(8, Math.max(4, Math.floor((rows - 1) / 3)));
  const missionSection = Math.max(4, rows - 1 - toolsSection);

  return (
    <Box flexDirection="row" width={width} height={rows} columnGap={GAP}>
      {rails.left === "mission" && (
        <>
          <Box flexDirection="column" width={SIDE_WIDTH} height={rows}>
            <Section title="Mission" width={SIDE_WIDTH} rows={missionSection}>
              <MissionPanel mission={state.mission} width={SIDE_WIDTH} rows={missionSection - 1} now={now} />
            </Section>
            <Rule width={SIDE_WIDTH} />
            <Section title="Tools" width={SIDE_WIDTH} rows={toolsSection}>
              <ToolsPanel toolCalls={state.toolCalls} width={SIDE_WIDTH} rows={toolsSection - 1} />
            </Section>
          </Box>
          <VDivider rows={rows} />
        </>
      )}
      <Box flexDirection="column" width={centerWidth} height={rows}>
        {/* No "Activity Stream" title — the [Chat] tab above already says
            what this is; ConversationView verbatim (same markdown/tool/diff
            formatting, same PageUp/PageDown + wheel scrolling) just gets the
            full column instead of losing a row to a redundant label. */}
        <ConversationView state={state} width={centerWidth} rows={feedSection} detail={detail} />
        {showDiffSummary && (
          <>
            <Rule width={centerWidth} />
            <PinnedDiffPanel conversation={state.conversation} width={centerWidth} rows={1} summary />
          </>
        )}
      </Box>
      {rails.right && (
        <>
          <VDivider rows={rows} />
          <Box flexDirection="column" width={rightWidth} height={rows}>
            {rails.right === "files" && (
              <Section title={`Files (${state.git.files.length} changed)`} width={rightWidth} rows={rows}>
                <FilesPanel files={state.git.files} width={rightWidth} rows={rows - 1} />
              </Section>
            )}
            {rails.right === "diagnostics" && (
              <Section title="Diagnostics" width={rightWidth} rows={rows}>
                <DiagnosticsPanel
                  lspServers={state.lspServers}
                  diagnosticsByPath={state.diagnosticsByPath}
                  lastTestResult={state.lastTestResult}
                  width={rightWidth}
                  rows={rows - 1}
                />
              </Section>
            )}
            {rails.right === "diff" && (
              <Section title="Diff" width={rightWidth} rows={rows}>
                <PinnedDiffPanel conversation={state.conversation} width={rightWidth} rows={rows - 1} />
              </Section>
            )}
          </Box>
        </>
      )}
    </Box>
  );
}
