import React from "react";
import { Box } from "@nemesis-oss/termina-core";
import { UniversalPicker } from "./UniversalPicker.js";
import { StatusMessage } from "../ui/status-message.js";
import { OverlayFrame } from "./OverlayFrame.js";

export interface ModelSwitcherProps {
  current: string;
  models: string[] | null; // null = still loading
  /** Cache-only: model id -> known accessible (true) / subscription-gated (false). Absent = unchecked. */
  availability?: Record<string, boolean>;
  /** coding/vision/reasoning/quick/tools/agentic tags per model. */
  capabilities?: Record<string, string[]>;
  width: number;
  rows: number;
  active: boolean;
  onSelect(model: string): void;
}

// Short forms so the capability list doesn't crowd out the model name at
// typical terminal widths.
const CAP_SHORT: Record<string, string> = {
  coding: "code",
  vision: "vision",
  reasoning: "reason",
  quick: "quick",
  tools: "tools",
  agentic: "agentic",
};

/** Ctrl+M — switch model via the universal picker. */
export function ModelSwitcher({
  current,
  models,
  availability,
  capabilities,
  width,
  rows,
  active,
  onSelect,
}: ModelSwitcherProps): React.JSX.Element {
  if (models === null) {
    return (
      <OverlayFrame title="Switch Model" width={width} rows={rows}>
        <Box>
          <StatusMessage variant="loading">Loading models…</StatusMessage>
        </Box>
      </OverlayFrame>
    );
  }
  const all = models.includes(current) || !current ? models : [current, ...models];
  const detailFor = (m: string): string | undefined => {
    // Only state what is actually known. The checker only ever tracks cloud
    // ids, so every local model used to read "Untested" forever, and a 200 was
    // labelled "Free" even for models a paying subscriber is billed for —
    // both were claims the data doesn't support. Silence is the honest default.
    const known = availability?.[m];
    const status = m === current ? "current" : known === false ? "🔒 Subscription" : undefined;
    const caps = capabilities?.[m]?.map((c) => CAP_SHORT[c] ?? c).join("/");
    return [status, caps].filter(Boolean).join(" · ") || undefined;
  };
  return (
    <UniversalPicker
      title="Switch Model"
      // filterText pins filtering to the model name: `detail` here updates
      // asynchronously as availability checks land, and letting that drive the
      // filter meant the list could shrink under the picker's fixed index
      // between render and keypress, selecting the wrong model on Enter.
      items={all.map((m) => ({ id: m, label: m, detail: detailFor(m), filterText: m }))}
      width={width}
      rows={rows}
      active={active}
      placeholder="Type to filter models…"
      emptyText="No models available — is the provider reachable?"
      initialSelected={current ? [current] : []}
      onSubmit={(ids) => {
        if (ids[0]) onSelect(ids[0]);
      }}
    />
  );
}
