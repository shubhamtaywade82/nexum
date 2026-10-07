import { useCallback } from "react";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventBus } from "../../runtime/events/bus.js";
import type { BalanceResponse, UsageResponse } from "@nemesis-oss/ollama-sdk";
import type { AccountBalance, AccountUsage } from "../../models/adapters/provider.js";
import { Store } from "../../runtime/store.js";
import { CommandEffect } from "../../interaction/slash-commands.js";
import { runDoctor } from "../../cli/doctor.js";
import { formatCapability } from "../../cli/capabilities.js";
import { WorkspaceManager } from "../../platform/workspace.js";
import { workspaceStateDir } from "../../platform/paths.js";
import { saveWorkspaceConfig } from "../../cli/config.js";
import { EvolutionEngine } from "../../evolution/engine.js";
import { HarnessRegistry } from "../../evolution/registry.js";
import { formatDiagnosesText, formatHistory, loadRecentEpisodes } from "../../evolution/cli.js";
import type { AgentMode } from "../../runtime/types.js";
import { THEME_ORDER } from "../../runtime/types.js";
import type { ShellAgent } from "../App.js";

/**
 * Extracted from App.tsx — handles the execution of slash-command effects
 * (model changes, tier switches, session resume, plan runs, etc.).
 *
 * This was the single largest block inside App (~230 lines) and is now
 * a focused, testable hook with a single dependency array.
 */
export function useCommandEffects(
  bus: EventBus,
  store: Store,
  agent: ShellAgent | undefined,
  workspaceRoot: string | undefined,
  setBusy: (busy: boolean) => void,
  uiDispatch: React.Dispatch<any>,
): (effect: CommandEffect) => Promise<void> {
  return useCallback(
    async (effect: CommandEffect): Promise<void> => {
      switch (effect.kind) {
        case "message":
          bus.publish({ type: "conversation.message", role: "system", text: effect.text });
          break;
        case "open-overlay":
          uiDispatch({ type: "open-overlay", overlay: effect.overlay });
          break;
        case "focus-view":
          uiDispatch({ type: "focus-view", view: effect.view });
          break;
        case "clear-conversation":
          bus.publish({ type: "conversation.clear" });
          break;
        case "set-model": {
          const previous = store.getState().model.name;
          if (effect.model === previous) break;
          agent?.setModel?.(effect.model);
          bus.publish({ type: "model.changed", name: effect.model });
          if (!agent?.validateModel) {
            bus.publish({ type: "notification", kind: "success", text: `Model: ${effect.model}` });
            break;
          }
          bus.publish({ type: "notification", kind: "info", text: `Validating ${effect.model}…` });
          const result = await agent.validateModel();
          if (result === true) {
            bus.publish({ type: "notification", kind: "success", text: `Model: ${effect.model}` });
          } else {
            agent?.setModel?.(previous);
            bus.publish({ type: "model.changed", name: previous });
            bus.publish({ type: "notification", kind: "error", text: `${effect.model} ${result}` });
          }
          break;
        }
        case "set-tier": {
          const previousTier = store.getState().model.provider;
          if (effect.tier === previousTier) break;
          agent?.setTier?.(effect.tier);
          bus.publish({ type: "model.changed", name: store.getState().model.name, provider: effect.tier });
          bus.publish({ type: "notification", kind: "success", text: `Tier: ${effect.tier}` });
          break;
        }
        case "activate-skill": {
          const registry = agent?.getSkillsRegistry?.();
          const meta = registry?.get(effect.id);
          if (!meta) {
            bus.publish({ type: "notification", kind: "error", text: `Unknown skill: ${effect.id}` });
            break;
          }
          agent?.pinSkill?.(effect.id);
          bus.publish({ type: "notification", kind: "success", text: `Skill pinned: ${meta.name}` });
          break;
        }
        case "init-workspace": {
          const root = workspaceRoot ?? process.cwd();
          // Route every state-path decision through the WorkspaceManager:
          // init creates `.nexum` (never the legacy `.devagent`) and migrates
          // any legacy workspace as a side effect (docs/REBRANDING.md §4).
          const mgr = new WorkspaceManager(root);
          mgr.ensure();
          const paths = mgr.paths();
          mkdirSync(paths.skillsDir, { recursive: true });
          writeFileSync(
            paths.configFile,
            JSON.stringify(
              {
                model: store.getState().model.name,
                tier: store.getState().model.provider,
                host: process.env.OLLAMA_HOST || null,
              },
              null,
              2,
            ),
          );
          bus.publish({ type: "notification", kind: "success", text: `Workspace initialized at ${mgr.dir}` });
          break;
        }
        case "reset-context":
          agent?.resetContext?.();
          bus.publish({ type: "notification", kind: "info", text: "Context reset" });
          break;
        case "resume-session":
        case "resume-session-by-id": {
          const restored =
            effect.kind === "resume-session-by-id" ? agent?.resumeSessionById?.(effect.id) : agent?.resumeSession?.();
          if (!restored || restored.length === 0) {
            bus.publish({ type: "notification", kind: "info", text: "No previous session to resume" });
            break;
          }
          bus.publish({ type: "conversation.clear" });
          for (const m of restored) {
            if (m.role !== "user" && m.role !== "assistant") continue;
            if (!m.content) continue;
            bus.publish({ type: "conversation.message", role: m.role, text: m.content });
          }
          bus.publish({
            type: "notification",
            kind: "success",
            text: `Resumed session (${restored.length} messages)`,
          });
          break;
        }
        case "toggle-sidebar":
          uiDispatch({ type: "toggle-sidebar" });
          break;
        case "run-plan": {
          if (!effect.goal && !agent?.hasResumablePlan?.()) {
            bus.publish({ type: "notification", kind: "error", text: "Usage: /plan <task description>" });
            break;
          }
          bus.publish({
            type: "notification",
            kind: "info",
            text: effect.goal ? `Planning: ${effect.goal}` : "Resuming interrupted plan…",
          });
          agent?.runPlan?.(effect.goal).catch((e: unknown) =>
            bus.publish({
              type: "notification",
              kind: "error",
              text: `Plan failed: ${e instanceof Error ? e.message : String(e)}`,
            }),
          );
          break;
        }
        case "set-theme": {
          bus.publish({ type: "theme.changed", theme: effect.theme });
          bus.publish({ type: "notification", kind: "info", text: `Theme: ${effect.theme}` });
          // Persist the choice so the next session starts themed. Best-effort:
          // the live switch already applied, a read-only workspace must not
          // turn it into an error notification.
          try {
            saveWorkspaceConfig(workspaceRoot ?? process.cwd(), { theme: effect.theme });
          } catch {
            // ignore — runtime theme switch stands, persistence is optional
          }
          break;
        }
        case "next-theme": {
          const next = THEME_ORDER[(THEME_ORDER.indexOf(store.getState().theme) + 1) % THEME_ORDER.length];
          bus.publish({ type: "theme.changed", theme: next });
          bus.publish({ type: "notification", kind: "info", text: `Theme: ${next}` });
          break;
        }
        case "show-tool-info": {
          const tool = agent?.getTools?.().find((t) => t.name === effect.name);
          bus.publish({
            type: "notification",
            kind: "info",
            text: tool ? `${tool.name} (${tool.category}): ${tool.description}` : `Unknown tool: ${effect.name}`,
          });
          break;
        }
        case "learn":
          if (agent && agent.addLearning) {
            agent.addLearning("user_preference", "user explicitly typed /learn", effect.rule);
            bus.publish({
              type: "notification",
              kind: "success",
              text: `Learned: ${effect.rule.slice(0, 40)}${effect.rule.length > 40 ? "..." : ""}`,
            });
          } else {
            bus.publish({ type: "notification", kind: "error", text: "Learning not supported by agent" });
          }
          break;
        case "set-agent-mode": {
          const valid = ["ask", "code", "architect", "review", "debug", "autonomous"];
          if (valid.includes(effect.mode)) {
            bus.publish({ type: "mode.agent", mode: effect.mode as AgentMode });
            bus.publish({ type: "notification", kind: "info", text: `Mode: ${effect.mode}` });
          }
          break;
        }
        case "run-shell": {
          bus.publish({ type: "conversation.message", role: "user", text: `Run: ${effect.command}` });
          if (agent) {
            setBusy(true);
            bus.publish({ type: "mode.changed", mode: "streaming" });
            agent
              .runUserMessage(`Run the following shell command and show me the output:\n\n${effect.command}`)
              .catch(() => {})
              .finally(() => {
                setBusy(false);
                bus.publish({ type: "model.streaming", streaming: false });
                bus.publish({ type: "mode.changed", mode: "idle" });
              });
          }
          break;
        }
        case "search":
          uiDispatch({ type: "open-overlay", overlay: "search" });
          break;
        case "next-mode": {
          const modeList = ["ask", "code", "architect", "review", "debug", "autonomous"];
          const current = store.getState().agentMode;
          const idx = modeList.indexOf(current);
          const next = modeList[(idx + 1) % modeList.length] as AgentMode;
          bus.publish({ type: "mode.agent", mode: next });
          bus.publish({ type: "notification", kind: "info", text: `Mode: ${next}` });
          break;
        }
        case "doctor": {
          bus.publish({ type: "notification", kind: "info", text: "Running system doctor…" });
          runDoctor()
            .then((report) => {
              const output = "🩺 **Nexum System Health Report**\n\n" + report.lines.map((l) => `• ${l}`).join("\n");
              bus.publish({ type: "conversation.message", role: "assistant", text: output });
              bus.publish({ type: "notification", kind: "success", text: "System check completed" });
            })
            .catch((err) => {
              bus.publish({
                type: "notification",
                kind: "error",
                text: `Doctor failed: ${err instanceof Error ? err.message : String(err)}`,
              });
            });
          break;
        }
        case "capabilities": {
          if (effect.action === "fix") {
            bus.publish({ type: "notification", kind: "info", text: "Checking the sandbox image…" });
            agent
              ?.buildSandboxImage?.()
              .then((r) => bus.publish({ type: "notification", kind: r.ok ? "success" : "error", text: r.message }))
              .catch((err: unknown) =>
                bus.publish({
                  type: "notification",
                  kind: "error",
                  text: `Sandbox build failed: ${err instanceof Error ? err.message : String(err)}`,
                }),
              );
            break;
          }
          agent
            ?.getCapabilities?.()
            .then((caps) => {
              const mark = { active: "●", available: "◐", degraded: "▲", off: "○" } as const;
              const rows = caps.map((c) => `• ${mark[c.state]} ${formatCapability(c)}`);
              bus.publish({
                type: "conversation.message",
                role: "assistant",
                text:
                  "**Capabilities** (● active ◐ on demand ▲ degraded ○ off)\n\n" +
                  rows.join("\n") +
                  (caps.some((c) => c.id === "sandbox" && c.state === "degraded")
                    ? "\n\nRun `/capabilities fix` to build the sandbox image."
                    : ""),
              });
            })
            .catch((err: unknown) =>
              bus.publish({
                type: "notification",
                kind: "error",
                text: `Capability check failed: ${err instanceof Error ? err.message : String(err)}`,
              }),
            );
          break;
        }
        case "usage": {
          if (!agent?.usageAll) {
            bus.publish({ type: "notification", kind: "error", text: "Usage is unavailable — no agent connected" });
            break;
          }
          bus.publish({ type: "notification", kind: "info", text: "Fetching Ollama Cloud usage…" });
          agent
            .usageAll(effect.range)
            .then((accounts) =>
              bus.publish({ type: "conversation.message", role: "assistant", text: formatUsage(accounts) }),
            )
            .catch((err: unknown) =>
              bus.publish({
                type: "notification",
                kind: "error",
                text: `Usage failed: ${err instanceof Error ? err.message : String(err)}`,
              }),
            );
          break;
        }
        case "balance": {
          if (!agent?.balanceAll) {
            bus.publish({ type: "notification", kind: "error", text: "Balance is unavailable — no agent connected" });
            break;
          }
          bus.publish({ type: "notification", kind: "info", text: "Fetching Ollama Cloud balance…" });
          agent
            .balanceAll()
            .then((accounts) =>
              bus.publish({ type: "conversation.message", role: "assistant", text: formatBalance(accounts) }),
            )
            .catch((err: unknown) =>
              bus.publish({
                type: "notification",
                kind: "error",
                text: `Balance failed: ${err instanceof Error ? err.message : String(err)}`,
              }),
            );
          break;
        }
        case "import-gguf": {
          if (!agent?.importGguf) {
            bus.publish({ type: "notification", kind: "error", text: "GGUF import is unavailable" });
            break;
          }
          bus.publish({ type: "notification", kind: "info", text: `Importing ${effect.model}…` });
          agent
            .importGguf(effect.model, effect.path)
            .then(() => bus.publish({ type: "notification", kind: "success", text: `Model ${effect.model} created` }))
            .catch((err: unknown) =>
              bus.publish({
                type: "notification",
                kind: "error",
                text: `Import failed: ${err instanceof Error ? err.message : String(err)}`,
              }),
            );
          break;
        }
        case "evolve":
          await handleEvolveEffect(bus, workspaceRoot, effect.action, effect.target);
          break;
        case "error":
          bus.publish({ type: "notification", kind: "error", text: effect.text });
          break;
      }
    },
    [agent, bus, setBusy, store, uiDispatch, workspaceRoot],
  );
}

async function handleEvolveEffect(
  bus: EventBus,
  workspaceRoot: string | undefined,
  action: "diagnose" | "history" | "rollback" | "benchmark",
  target?: string,
): Promise<void> {
  const root = workspaceRoot ?? process.cwd();
  const stateDir = workspaceStateDir(root);
  mkdirSync(stateDir, { recursive: true });
  const registry = new HarnessRegistry(join(stateDir, "evolution.db"));
  const engine = new EvolutionEngine({ registry });
  try {
    if (action === "history") {
      const text = formatHistory(engine.listVersions(), engine.getActiveVersion());
      bus.publish({ type: "conversation.message", role: "assistant", text: "```\n" + text + "\n```" });
      return;
    }
    if (action === "rollback") {
      if (!target) return;
      engine.rollback(target);
      bus.publish({ type: "notification", kind: "success", text: `Active harness rolled back to ${target}` });
      bus.publish({
        type: "conversation.message",
        role: "assistant",
        text: `Active harness rolled back to **${target}**.`,
      });
      return;
    }
    const episodes = loadRecentEpisodes(root, 20);
    const { diagnoses, plan } = engine.diagnoseEpisodes(episodes);
    if (action === "benchmark") {
      const suites = plan?.recommendedBenchmarkCategories ?? ["execution", "agentic-looping"];
      bus.publish({
        type: "conversation.message",
        role: "assistant",
        text: `📊 **Recommended Benchmark Suites:** ${suites.join(", ")}`,
      });
      return;
    }
    bus.publish({ type: "conversation.message", role: "assistant", text: formatDiagnosesText(diagnoses, plan) });
  } finally {
    registry.close();
  }
}

const usd = (n: number): string => `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;

function usageLines(u: UsageResponse): string {
  const t = u.totals;
  const tokens =
    t.input_tokens !== undefined
      ? `\u2022 Tokens: ${t.input_tokens.toLocaleString()} in (${(t.cached_input_tokens ?? 0).toLocaleString()} cached)` +
        ` / ${(t.output_tokens ?? 0).toLocaleString()} out`
      : "";
  // `partial` marks the in-progress bucket — including it would report a
  // half-elapsed hour as a real drop in traffic.
  const recent = u.buckets.filter((b) => !b.partial && b.request_count > 0).slice(-3);
  const rows = recent.length
    ? `\n\nRecent ${u.granularity}s:\n` +
      recent.map((b) => `\u2022 ${b.from} \u2014 ${b.request_count} req, ${usd(b.usage_usd ?? 0)}`).join("\n")
    : "";
  return (
    `(${u.range}, ${u.scope})\n\n\u2022 Requests: ${t.request_count.toLocaleString()}\n` +
    `\u2022 Spend: ${usd(t.usage_usd ?? 0)}${tokens}${rows}`
  );
}

function formatUsage(accounts: AccountUsage[]): string {
  if (accounts.length === 0) return "**Ollama Cloud usage**\n\nNo Ollama Cloud API key configured.";
  const sections = accounts.map((a) =>
    a.usage ? `**${a.label}**\n${usageLines(a.usage)}` : `**${a.label}**\n\u2022 \u2717 ${a.error ?? "unavailable"}`,
  );
  // Pools exist for availability, so the pool's real cost has to be visible
  // without adding the per-key numbers up by hand.
  const ok = accounts.flatMap((a) => (a.usage ? [a.usage] : []));
  if (ok.length > 1) {
    const requests = ok.reduce((n, u) => n + u.totals.request_count, 0);
    const spend = ok.reduce((n, u) => n + (u.totals.usage_usd ?? 0), 0);
    sections.unshift(
      `**${ok.length} accounts**\n\n\u2022 Requests: ${requests.toLocaleString()}\n\u2022 Spend: ${usd(spend)}`,
    );
  }
  return `**Ollama Cloud usage**\n\n${sections.join("\n\n---\n\n")}`;
}

function balanceLines(b: BalanceResponse): string {
  const lines =
    "balance_usd" in b.included
      ? [
          `\u2022 Included: ${usd(b.included.balance_usd)} of ${usd(b.included.allowance_usd)}`,
          `\u2022 Period: ${b.included.period.from} \u2192 ${b.included.period.until}`,
        ]
      : [
          `\u2022 Session limit: ${b.included.session.remaining_percent}% left (resets ${b.included.session.resets_at})`,
          `\u2022 Weekly limit: ${b.included.weekly.remaining_percent}% left (resets ${b.included.weekly.resets_at})`,
        ];
  lines.push(`\u2022 Purchased: ${usd(b.purchased.balance_usd)}`);
  return lines.join("\n");
}

function formatBalance(accounts: AccountBalance[]): string {
  if (accounts.length === 0) return "**Ollama Cloud balance**\n\nNo Ollama Cloud API key configured.";
  const sections = accounts.map((a) =>
    a.balance
      ? `**${a.label}**\n${balanceLines(a.balance)}`
      : `**${a.label}**\n\u2022 \u2717 ${a.error ?? "unavailable"}`,
  );
  const ok = accounts.flatMap((a) => (a.balance ? [a.balance] : []));
  if (ok.length > 1) {
    // Purchased credits are the only figure that sums across accounts —
    // legacy plans report percentages, which don't add up.
    const purchased = ok.reduce((n, b) => n + b.purchased.balance_usd, 0);
    sections.unshift(`**${ok.length} accounts**\n\n\u2022 Purchased: ${usd(purchased)}`);
  }
  return `**Ollama Cloud balance**\n\n${sections.join("\n\n---\n\n")}`;
}
