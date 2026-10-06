import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { ChatEntry, RuntimeState } from "../../runtime/types.js";
import { DetailLevel } from "../layout/density.js";
import { truncate } from "../layout/truncate.js";
import { renderSimpleMarkdown } from "../markdown.js";
import { SpanText } from "../components/SpanText.js";
import { themeColors } from "../layout/theme-map.js";

export interface ViewProps {
  state: RuntimeState;
  width: number;
  rows: number;
  detail: DetailLevel;
  /** App's render clock — lets panels tick elapsed times with the app instead of Date.now() at render. */
  now?: number;
}

export function formatArgs(args: Record<string, unknown>): string {
  return Object.values(args)
    .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
    .join(", ");
}

function countDiff(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

export interface GroupSummary {
  files: Array<{ path: string; additions: number; deletions: number }>;
  totalAdditions: number;
  totalDeletions: number;
  test?: { passed: number; failed: number };
}

/** Aggregate a phase group's entries into a compact summary, or null when
 * the group has nothing worth summarizing (pure tool-call groups — the
 * tool tree is already compact). */
export function summarizeGroup(entries: ChatEntry[]): GroupSummary | null {
  const byPath = new Map<string, { additions: number; deletions: number }>();
  let test: GroupSummary["test"];
  for (const e of entries) {
    if (e.kind === "diff_preview") {
      const { additions, deletions } = countDiff(e.diff);
      const prev = byPath.get(e.filePath) ?? { additions: 0, deletions: 0 };
      byPath.set(e.filePath, { additions: prev.additions + additions, deletions: prev.deletions + deletions });
    } else if (e.kind === "test_result") {
      test = { passed: e.passed, failed: e.failed };
    }
  }
  if (byPath.size === 0 && !test) return null;
  const files = [...byPath.entries()].map(([path, c]) => ({ path, ...c }));
  return {
    files,
    totalAdditions: files.reduce((s, f) => s + f.additions, 0),
    totalDeletions: files.reduce((s, f) => s + f.deletions, 0),
    test,
  };
}

function TurnSeparator({ width }: { width: number }): React.JSX.Element {
  return (
    <Box height={1}>
      <Text color={themeColors().mutedForeground} dimColor wrap="truncate">
        {"─".repeat(Math.max(1, width))}
      </Text>
    </Box>
  );
}

function summarizeThinking(text: string, maxWidth: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "Thought";
  return truncate(cleaned, maxWidth);
}

function getToolOutputLines(text: string | undefined, maxLines = 4, maxWidth = 80): string[] {
  if (!text) return [];
  const lines = text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const shown = lines.slice(0, maxLines).map((l) => truncate(l, maxWidth));
  if (lines.length > maxLines) {
    shown.push(`… (${lines.length - maxLines} more lines)`);
  }
  return shown;
}

function ToolCallBlock({
  entry,
  collapsed,
  width,
  isLast,
  errorLines,
  resultLines,
}: {
  entry: ChatEntry & { kind: "tool_call" };
  collapsed: boolean;
  width: number;
  isLast: boolean;
  errorLines: string[];
  resultLines: string[];
}): React.JSX.Element {
  const args = formatArgs(entry.args);
  const isRunning = entry.status === "running";
  const isFailed = entry.status === "failed";
  const statusColor = isRunning ? "yellow" : isFailed ? "red" : "green";
  const statusLabel = isRunning ? "running" : isFailed ? "failed" : "done";
  const connector = isLast ? "  └─ " : "  ├─ ";

  return (
    <Box flexDirection="column">
      <Box height={1}>
        <Text color={themeColors().mutedForeground}>{connector}</Text>
        <Text bold color={themeColors().info}>
          {entry.name}{" "}
        </Text>
        <Text color={themeColors().mutedForeground} wrap="truncate">
          {truncate(args, Math.max(10, width - 20 - entry.name.length))}
        </Text>
        <Text color={statusColor} dimColor={!isRunning}>
          {" "}
          [{statusLabel}]
        </Text>
      </Box>
      {!collapsed && (errorLines.length > 0 || resultLines.length > 0) && (
        <Box marginLeft={5} flexDirection="column">
          {errorLines.map((line, i) => (
            <Box key={`err-${i}`} height={1}>
              <Text color={themeColors().error} wrap="truncate">
                {i === 0 ? `Error: ${line}` : `  ${line}`}
              </Text>
            </Box>
          ))}
          {resultLines.map((line, i) => (
            <Box key={`res-${i}`} height={1}>
              <Text color={themeColors().mutedForeground} wrap="truncate">
                {i === 0 ? `Output: ${line}` : `  ${line}`}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

interface RenderedBlock {
  key: string;
  height: number;
  render: (startRow: number, endRow: number) => React.JSX.Element;
}

export function ConversationView({ state, width, rows, detail: _detail }: ViewProps): React.JSX.Element {
  const [collapsed] = useState<Set<number>>(new Set());
  const bodyWidth = Math.max(10, width);
  const [scrollOffset, setScrollOffset] = useState(0);

  // Build renderable blocks from conversation entries
  const blocks = useMemo<RenderedBlock[]>(() => {
    const b: RenderedBlock[] = [];
    let isFirst = true;
    let lastSpeaker: "user" | "assistant" | null = null;
    let prevCrumb: string | undefined;
    let group: ChatEntry[] = [];

    const flushGroup = (flushKey: string) => {
      const summary = summarizeGroup(group);
      group = [];
      if (!summary) return;
      const shown = summary.files.slice(0, 4);
      const overflow = summary.files.length - shown.length;
      const rows: Array<{ text: string; color: string }> = shown.map((f) => ({
        text: `  ✓ ${f.path}  +${f.additions} −${f.deletions}`,
        color: themeColors().success,
      }));
      if (overflow > 0) rows.push({ text: `  … and ${overflow} more files`, color: themeColors().mutedForeground });
      if (summary.files.length > 0) {
        rows.push({
          text: `  ${summary.files.length} file${summary.files.length === 1 ? "" : "s"} · +${summary.totalAdditions} −${summary.totalDeletions}`,
          color: themeColors().mutedForeground,
        });
      }
      if (summary.test) {
        rows.push(
          summary.test.failed > 0
            ? { text: `  ✗ ${summary.test.failed} failed`, color: themeColors().error }
            : { text: `  ✓ ${summary.test.passed} passed`, color: themeColors().success },
        );
      }
      b.push({
        key: `sum-${flushKey}`,
        height: rows.length,
        render: (startRow, endRow) => (
          <Box key={`sum-${flushKey}`} flexDirection="column">
            {rows.slice(startRow, endRow).map((r, i) => (
              <Box key={i} height={1}>
                <Text color={r.color} wrap="truncate">
                  {r.text}
                </Text>
              </Box>
            ))}
          </Box>
        ),
      });
    };

    for (let idx = 0; idx < state.conversation.length; idx++) {
      const entry = state.conversation[idx];
      const crumb = "crumb" in entry ? entry.crumb : undefined;
      if (crumb !== prevCrumb) {
        flushGroup(`${idx}`);
        if (crumb) {
          b.push({
            key: `crumb-${idx}-${entry.at}`,
            height: 1,
            render: () => (
              <Box key={`crumb-${idx}-${entry.at}`} height={1}>
                <Text bold color={themeColors().info} wrap="truncate">
                  ◆ {crumb}
                </Text>
              </Box>
            ),
          });
        }
        prevCrumb = crumb;
      }
      if (crumb) group.push(entry);
      // A tool call following the thought that spawned it (or another tool
      // call) reads as one unit — no blank row inside the chain.
      const prev = state.conversation[idx - 1];
      const chained =
        entry.kind === "tool_call" &&
        prev != null &&
        (prev.kind === "tool_call" || (prev.kind === "text" && prev.role === "thinking"));
      if (!isFirst) {
        if (entry.role === "user") {
          b.push({
            key: `sep-${entry.at}-${idx}`,
            height: 1,
            render: () => <TurnSeparator key={`sep-${entry.at}-${idx}`} width={bodyWidth} />,
          });
        } else if (!chained) {
          b.push({
            key: `space-${entry.at}-${idx}`,
            height: 1,
            render: () => <Box key={`space-${entry.at}-${idx}`} height={1} />,
          });
        }
      }
      isFirst = false;

      if (entry.kind === "text") {
        if (entry.role === "thinking") {
          const isCurrentActive =
            idx === state.conversation.length - 1 &&
            (state.actors.conversation.health === "thinking" || state.actors.conversation.health === "active");

          if (isCurrentActive) {
            const lines = renderSimpleMarkdown(entry.text || "Thinking...", bodyWidth - 4);
            const headerHeight = 1;
            const contentHeight = Math.max(1, lines.length);
            b.push({
              key: `think-${entry.at}-${idx}`,
              height: headerHeight + contentHeight,
              render: (startRow, endRow) => {
                const showHeader = startRow === 0;
                const bodyStart = Math.max(0, startRow - headerHeight);
                const bodyEnd = Math.max(0, endRow - headerHeight);
                const visibleLines = lines.slice(bodyStart, bodyEnd);
                return (
                  <Box key={`think-${entry.at}-${idx}`} flexDirection="column">
                    {showHeader ? (
                      <Box height={1}>
                        <Text color={themeColors().mutedForeground} dimColor>
                          ▸ Thinking...
                        </Text>
                      </Box>
                    ) : null}
                    {visibleLines.map((line, li) => (
                      <Box key={bodyStart + li} height={1}>
                        <Box width={2} />
                        {line.indent ? <Box width={line.indent} /> : null}
                        <SpanText spans={line.spans} color={themeColors().mutedForeground} dimColor />
                      </Box>
                    ))}
                  </Box>
                );
              },
            });
          } else {
            const summary = summarizeThinking(entry.text, bodyWidth - 14);
            b.push({
              key: `think-${entry.at}-${idx}`,
              height: 1,
              render: () => (
                <Box key={`think-${entry.at}-${idx}`} flexDirection="row" height={1}>
                  <Text color={themeColors().mutedForeground} dimColor wrap="truncate">
                    {"▸ Thought "}
                  </Text>
                  <Text color={themeColors().mutedForeground} dimColor wrap="truncate">
                    ({summary})
                  </Text>
                </Box>
              ),
            });
          }
        } else if (entry.role === "user") {
          const lines = renderSimpleMarkdown(entry.text, bodyWidth - 2);
          lastSpeaker = "user";
          b.push({
            key: `user-${entry.at}-${idx}`,
            height: Math.max(1, lines.length),
            render: (startRow, endRow) => {
              const visibleLines = lines.slice(startRow, endRow);
              return (
                <Box key={`user-${entry.at}`} flexDirection="column">
                  {visibleLines.length === 0 ? (
                    <Box height={1}>
                      <Text bold color={themeColors().success}>
                        {"> "}
                      </Text>
                    </Box>
                  ) : (
                    visibleLines.map((line, li) => {
                      const lineIdx = startRow + li;
                      return (
                        <Box key={lineIdx} height={1}>
                          {lineIdx === 0 ? (
                            <Text bold color={themeColors().success}>
                              {"> "}
                            </Text>
                          ) : (
                            <Box width={2} />
                          )}
                          {line.indent ? <Box width={line.indent} /> : null}
                          <SpanText spans={line.spans} />
                        </Box>
                      );
                    })
                  )}
                </Box>
              );
            },
          });
        } else {
          // assistant
          const lines = renderSimpleMarkdown(entry.text, bodyWidth - 2);
          const showSpeaker = lastSpeaker !== "assistant";
          lastSpeaker = "assistant";
          b.push({
            key: `asst-${entry.at}-${idx}`,
            height: lines.length + (showSpeaker ? 1 : 0),
            render: (startRow, endRow) => {
              const speakerVisible = showSpeaker && startRow === 0;
              const bodyStart = showSpeaker ? Math.max(0, startRow - 1) : startRow;
              const bodyEnd = showSpeaker ? endRow - 1 : endRow;
              const visibleLines = lines.slice(bodyStart, bodyEnd);
              return (
                <Box key={`asst-${entry.at}`} flexDirection="column">
                  {speakerVisible ? (
                    <Box height={1}>
                      <Text bold color={themeColors().info}>
                        ◆ Nexum
                      </Text>
                      {entry.model ? (
                        <Text color={themeColors().mutedForeground} dimColor>
                          {" "}
                          · {entry.model}
                        </Text>
                      ) : null}
                    </Box>
                  ) : null}
                  {visibleLines.map((line, li) => (
                    <Box key={bodyStart + li} height={1}>
                      <Box width={2} />
                      {line.indent ? <Box width={line.indent} /> : null}
                      <SpanText spans={line.spans} />
                    </Box>
                  ))}
                </Box>
              );
            },
          });
        }
      } else if (entry.kind === "tool_call") {
        const isCollapsed = collapsed.has(entry.at);
        const errorLines = isCollapsed || !entry.error ? [] : getToolOutputLines(entry.error, 4, bodyWidth - 10);
        const resultLines = isCollapsed || !entry.result ? [] : getToolOutputLines(entry.result, 4, bodyWidth - 10);
        const extraHeight = errorLines.length + resultLines.length;
        const isLast = state.conversation[idx + 1]?.kind !== "tool_call";
        b.push({
          key: `tool-${entry.at}-${idx}`,
          height: 1 + extraHeight,
          render: () => (
            <ToolCallBlock
              entry={entry}
              collapsed={isCollapsed}
              width={bodyWidth}
              isLast={isLast}
              errorLines={errorLines}
              resultLines={resultLines}
            />
          ),
        });
      } else if (entry.kind === "plan") {
        const headerText = `📋 Plan (${entry.steps.length} steps) [${entry.status}]`;
        const stepGlyphs = {
          completed: { char: "✓", color: themeColors().success },
          failed: { char: "✗", color: themeColors().error },
          running: { char: "▶", color: themeColors().warning },
          pending: { char: "○", color: themeColors().mutedForeground },
          skipped: { char: "–", color: themeColors().mutedForeground },
        };
        b.push({
          key: `plan-${entry.at}-${idx}`,
          height: 1 + entry.steps.length,
          render: () => (
            <Box key={`plan-${entry.at}-${idx}`} flexDirection="column">
              <Box height={1}>
                <Text bold color={themeColors().primary}>
                  {headerText}
                </Text>
              </Box>
              {entry.steps.map((step, sidx) => {
                const s = stepGlyphs[step.status] || stepGlyphs.pending;
                return (
                  <Box key={step.id} height={1}>
                    <Text color={themeColors().mutedForeground}> {sidx + 1}) </Text>
                    <Text color={s.color}>{s.char} </Text>
                    <Text color={step.status === "completed" ? "gray" : "white"}>{step.description}</Text>
                  </Box>
                );
              })}
            </Box>
          ),
        });
      } else if (entry.kind === "decision") {
        const optionList = entry.options.join(", ");
        b.push({
          key: `decision-${entry.at}-${idx}`,
          height: 3,
          render: () => (
            <Box key={`decision-${entry.at}-${idx}`} flexDirection="column">
              <Box height={1}>
                <Text bold color={themeColors().info}>
                  🧠 Strategy Selection
                </Text>
                <Text color={themeColors().mutedForeground}> (Options: {optionList})</Text>
              </Box>
              <Box height={1} marginLeft={2}>
                <Text>
                  <Text color={themeColors().mutedForeground}>Selected: </Text>
                  <Text bold color={themeColors().success}>
                    {entry.selected}
                  </Text>
                  <Text color={themeColors().mutedForeground}>
                    {" "}
                    (Confidence: {Math.round(entry.confidence * 100)}%)
                  </Text>
                </Text>
              </Box>
              <Box height={1} marginLeft={2}>
                <Text color={themeColors().mutedForeground} wrap="truncate">
                  Reason: {truncate(entry.reason, width - 12)}
                </Text>
              </Box>
            </Box>
          ),
        });
      } else if (entry.kind === "diff_preview") {
        const diffLines = entry.diff.split("\n");
        const changes: Array<{ text: string; color: string }> = [];
        let additions = 0;
        let deletions = 0;
        for (const line of diffLines) {
          if (line.startsWith("+") && !line.startsWith("+++")) {
            additions++;
            if (changes.length < 4) {
              changes.push({ text: line, color: themeColors().success });
            }
          } else if (line.startsWith("-") && !line.startsWith("---")) {
            deletions++;
            if (changes.length < 4) {
              changes.push({ text: line, color: themeColors().error });
            }
          }
        }
        const hasMore =
          diffLines.filter(
            (l) => (l.startsWith("+") && !l.startsWith("+++")) || (l.startsWith("-") && !l.startsWith("---")),
          ).length > changes.length;

        b.push({
          key: `diff-${entry.at}-${idx}`,
          height: 1 + changes.length + (hasMore ? 1 : 0),
          render: () => (
            <Box key={`diff-${entry.at}-${idx}`} flexDirection="column">
              <Box height={1}>
                <Text bold color={themeColors().warning}>
                  📄 {entry.filePath}
                </Text>
                <Text color={themeColors().mutedForeground}> ({entry.status}) </Text>
                <Text color={themeColors().success}>+{additions} </Text>
                <Text color={themeColors().error}>-{deletions}</Text>
              </Box>
              {changes.map((ch, cidx) => (
                <Box key={cidx} height={1} marginLeft={2}>
                  <Text color={ch.color}>{ch.text}</Text>
                </Box>
              ))}
              {hasMore && (
                <Box height={1} marginLeft={2}>
                  <Text color={themeColors().mutedForeground}>...</Text>
                </Box>
              )}
            </Box>
          ),
        });
      } else if (entry.kind === "test_result") {
        const isSuccess = entry.failed === 0;
        const statusColor = isSuccess ? "green" : "red";
        const durationSec = (entry.durationMs / 1000).toFixed(1);
        const headerText = `🧪 Tests [${isSuccess ? "Passed" : "Failed"}] (${durationSec}s)`;

        const failureLines: string[] = [];
        if (!isSuccess && entry.failures) {
          for (const f of entry.failures.slice(0, 2)) {
            failureLines.push(`  ✗ ${f.file}:${f.line}`);
            failureLines.push(`    ${f.message.replace(/\s+/g, " ").slice(0, width - 6)}`);
          }
          if (entry.failures.length > 2) {
            failureLines.push(`  ... and ${entry.failures.length - 2} more failures`);
          }
        }

        b.push({
          key: `test-${entry.at}-${idx}`,
          height: 3 + failureLines.length,
          render: () => (
            <Box key={`test-${entry.at}-${idx}`} flexDirection="column">
              <Box height={1}>
                <Text bold color={statusColor}>
                  {headerText}
                </Text>
              </Box>
              <Box height={1}>
                <Text color={themeColors().mutedForeground}> Command: {entry.command}</Text>
              </Box>
              <Box height={1}>
                <Text color={statusColor}>
                  {isSuccess ? "  ✓" : "  ✗"} {entry.passed} passed, {entry.failed} failed
                </Text>
              </Box>
              {failureLines.map((fl, fidx) => (
                <Box key={fidx} height={1}>
                  <Text color={fl.startsWith("    ") ? "gray" : "red"}>{fl}</Text>
                </Box>
              ))}
            </Box>
          ),
        });
      } else if (entry.kind === "card") {
        const statusColor = entry.status === "completed" ? "green" : entry.status === "failed" ? "red" : "yellow";
        const glyphs = {
          completed: { char: "✓", color: themeColors().success },
          failed: { char: "✗", color: themeColors().error },
          running: { char: "▶", color: themeColors().warning },
          pending: { char: "○", color: themeColors().mutedForeground },
          skipped: { char: "–", color: themeColors().mutedForeground },
        };
        b.push({
          key: `card-${entry.at}-${idx}`,
          height: 1 + entry.items.length,
          render: () => (
            <Box key={`card-${entry.at}-${idx}`} flexDirection="column">
              <Box height={1}>
                <Text bold color={statusColor}>
                  {entry.title} [{entry.status}]
                </Text>
              </Box>
              {entry.items.map((item, idx) => {
                const s = glyphs[item.status] || glyphs.pending;
                return (
                  <Box key={idx} height={1} marginLeft={2}>
                    <Text color={s.color}>{s.char} </Text>
                    <Text>{item.label}</Text>
                    {item.detail && <Text color={themeColors().mutedForeground}> ({item.detail})</Text>}
                  </Box>
                );
              })}
            </Box>
          ),
        });
      }
    }
    flushGroup("end");
    return b;
  }, [state.conversation, collapsed, bodyWidth]);

  const totalHeight = blocks.reduce((s, b) => s + b.height, 0);
  const maxOffset = Math.max(0, totalHeight - rows);
  const clampedOffset = Math.min(scrollOffset, maxOffset);

  // Blocks visible at this scroll position: we show the last `rows` rows.
  const visibleEnd = totalHeight - clampedOffset;
  const visibleStart = Math.max(0, visibleEnd - rows);

  // Find the first block that overlaps the visible window
  let blockStart = 0;
  let firstVisibleIdx = 0;
  for (let i = 0; i < blocks.length; i++) {
    const blockEnd = blockStart + blocks[i].height;
    if (blockEnd > visibleStart) {
      firstVisibleIdx = i;
      break;
    }
    blockStart = blockEnd;
  }

  // Limit to only blocks within visible window
  const visibleBlocks: Array<{ block: RenderedBlock; startRow: number; endRow: number }> = [];
  let currentRow = blockStart;
  for (let i = firstVisibleIdx; i < blocks.length && currentRow < visibleEnd; i++) {
    const b = blocks[i];
    if (currentRow + b.height > visibleStart) {
      const startRow = Math.max(0, visibleStart - currentRow);
      const endRow = Math.min(b.height, visibleEnd - currentRow);
      visibleBlocks.push({ block: b, startRow, endRow });
    }
    currentRow += b.height;
  }

  useInput((_input, key) => {
    if (key.pageUp) setScrollOffset((prev) => Math.min(maxOffset, prev + rows));
    else if (key.pageDown) setScrollOffset((prev) => Math.max(0, prev - rows));
  });

  const maxOffsetRef = useRef(maxOffset);
  maxOffsetRef.current = maxOffset;

  useEffect(() => {
    if (!process.stdin.isTTY) return;
    const handler = (data: Buffer) => {
      // eslint-disable-next-line no-control-regex
      const m = data.toString().match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
      if (!m) return;
      const btn = parseInt(m[1], 10);
      if (btn === 64) setScrollOffset((prev) => Math.min(maxOffsetRef.current, prev + 3));
      else if (btn === 65) setScrollOffset((prev) => Math.max(0, prev - 3));
    };
    process.stdin.on("data", handler);
    return () => {
      process.stdin.off("data", handler);
    };
  }, []);

  if (blocks.length === 0) {
    const cardWidth = Math.min(width - 4, 72);
    return (
      <Box height={rows} width={width} flexDirection="column" justifyContent="center" alignItems="center">
        <Box flexDirection="column" alignItems="center" width={cardWidth}>
          <Box flexDirection="row" alignItems="center">
            <Text bold color={themeColors().info}>
              ⚡ Nexum
            </Text>
            <Text color={themeColors().mutedForeground} dimColor>
              {" · "}Agent Runtime & Harness
            </Text>
          </Box>
          <Box height={1} />
          <Text color={themeColors().foreground} bold>
            Type a message below to start a conversation.
          </Text>
          <Box height={1} />
          <Box flexDirection="column" alignItems="flex-start">
            <Box flexDirection="row">
              <Text color={themeColors().info} bold>
                {"  /plan <goal>"}
              </Text>
              <Text color={themeColors().mutedForeground}> Start a multi-step autonomous plan</Text>
            </Box>
            <Box flexDirection="row">
              <Text color={themeColors().info} bold>
                {"  /model       "}
              </Text>
              <Text color={themeColors().mutedForeground}> Switch local & cloud models (Ctrl+M)</Text>
            </Box>
            <Box flexDirection="row">
              <Text color={themeColors().info} bold>
                {"  /help        "}
              </Text>
              <Text color={themeColors().mutedForeground}> Show commands and keyboard shortcuts</Text>
            </Box>
            <Box flexDirection="row">
              <Text color={themeColors().info} bold>
                {"  1 - 5        "}
              </Text>
              <Text color={themeColors().mutedForeground}> Quick switch: Chat, Plan, Tasks, Changes, Logs</Text>
            </Box>
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={rows} width={width}>
      {visibleBlocks.map(({ block, startRow, endRow }) => (
        <React.Fragment key={block.key}>{block.render(startRow, endRow)}</React.Fragment>
      ))}
    </Box>
  );
}
