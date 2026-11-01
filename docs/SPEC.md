# Nexum Terminal Specification (Frozen)

> **Historical design spec.** It predates the current layout: the UI lives in `src/ui/` (not `src/tui/`), and the view list is out of date. For the current architecture, see the [Architecture](/guide/architecture) guide. Kept for context, not as a reference.

This document freezes the product model. Changes here are breaking changes
and require deliberate review — the point of this file is that the product
cannot drift back into a web-dashboard shape.

## 1. What Nexum is

- A terminal-native agent operating environment.
- Built around always-running actors.
- One fixed layout; only content density changes with terminal size.
- The bottom HUD always exposes the most relevant live state.

What Nexum is **not**: a browser UI in a terminal, a dashboard app, a
page-based navigation app, or a file-explorer replacement.

> **The design principle:** everything is alive. You are only changing what
> you observe.

## 2. Permanent layout contract

```
┌──────────────────────────────────────────────────────────────────────┐
│ Header                                                               │
├──────────────────────────────────────────────────────────────────────┤
│                         Active View                                  │
├──────────────────────────────────────────────────────────────────────┤
│ Activity Strip                                                       │
├──────────────────────────────────────────────────────────────────────┤
│ Prompt                                                               │
├──────────────────────────────────────────────────────────────────────┤
│ Context Strip                                                        │
└──────────────────────────────────────────────────────────────────────┘
```

Rules (all zones, all sizes, no exceptions):

- Every zone always exists. No zone ever disappears or moves.
- No sidebars unless explicitly toggled as overlays.
- No browser-style tabs, no cards, no dashboard grid.

Zone semantics:

| Zone           | Contents                                                             |
| -------------- | -------------------------------------------------------------------- |
| Header         | product, workspace, model, branch, context usage, agent state, clock |
| Active View    | exactly one focused actor view (see §6)                              |
| Activity Strip | live health of **all** actors; never navigation                      |
| Prompt         | the single command input                                             |
| Context Strip  | dynamic live status for the current runtime mode                     |

Implementation: `src/tui/App.tsx`, zones in `src/tui/zones/`.

## 3. Visual language (frozen)

One theme: dark terminal. Colors are **semantic only**
(`src/layout/theme-map.ts`):

- green = healthy / done
- blue = active / focused
- yellow = waiting / warning
- red = error / blocked
- purple/magenta = thinking / model activity
- gray = muted / secondary

Monospace only, minimal borders, dense text. No shadows, gradients,
rounded corners, browser chrome, icon spam, or web-card spacing.
**If it looks like a web app, it is wrong.**

## 4. Runtime model

The UI is a pure reflection of runtime state.

- **Actors** (`src/runtime/types.ts`, always alive): conversation, planner,
  executor, tasks, git, logs, memory, models, mcp.
- **Event bus** (`src/runtime/events.ts`): every actor publishes events
  (`task.created`, `task.progress`, `tool.started`, `tool.completed`,
  `tool.failed`, `model.streaming`, `context.changed`, `git.changed`,
  `logs.appended`, `memory.updated`, `approval.requested`, …).
- **State store** (`src/runtime/store.ts`): the single source of truth —
  actor states, task graph, tool queue, session metadata, context metrics.
- **Task state machine** (`src/runtime/task-machine.ts`): invalid task
  transitions are rejected.
- **Renderer** (`src/tui/`): maps state to terminal output. **No business
  logic inside rendering.**

Data flow, strictly one direction:

```
Agent runtime → EventBus → Store → Layout (density/tokens) → Ink renderer
User input   → Input manager (keybindings/prompt) → UiCommands + bus events
```

## 5. Layout engine and resize behavior

The layout never restructures with width. Width only selects density
(`src/layout/density.ts`):

| Columns | Density | Widget detail |
| ------- | ------- | ------------- |
| ≥ 160   | high    | full          |
| 120–159 | normal  | expanded      |
| 90–119  | compact | normal        |
| < 90    | minimal | compact       |

What changes with density: detail level, wrapping, omitted secondary
status items, truncation, compact labels. What never changes: the zones.
No rearranging panels, no "mobile layout", no dashboard collapse logic.

## 6. Status system

All strips are built from priority-ordered `StatusToken`s
(`src/layout/status-tokens.ts`). When width shrinks, lower-priority tokens
disappear first; the strip never wraps or overflows. Errored actors get
top priority so they can never be elided.

Activity Strip format (`src/layout/strips.ts`):

```
Chat✓  Exec▶  Tasks3  Git2  Logs12  Mem✓  MCP✓  Tok48k/71k
```

Context Strip is mode-driven:

- idle — `Mode:NORMAL │ Model:… │ Workspace:… │ Ctrl+P Palette`
- planning — `Planning │ Step 2/8 │ … │ Esc Cancel`
- editing — `Tool:edit_file │ … │ Ctrl+Z Undo`
- testing — `Tool:pnpm test │ … │ ETA 00:42 │ Ctrl+C Stop`
- approval — `Waiting for approval │ Enter Approve │ N Reject │ D View Diff`
- streaming — `Generating... │ 81 tok/s │ … │ Ctrl+C Stop Generation`

While idle, the Git, Logs, and Memory views substitute view-specific
strips (branch/modified/ahead/behind; INFO/WARN/ERROR counts; memory
counts).

## 7. Active views

Focus changes what is observed, never what runs. Views
(`src/tui/views/`): Conversation, Execution, Tasks, Git, Logs, Memory,
Models, MCP — mapped to keys 1–8 in that order.

## 8. Keyboard contract

| Key             | Action                                            |
| --------------- | ------------------------------------------------- |
| 1–8             | focus a view                                      |
| Tab / Shift+Tab | next / previous view (prompt empty)               |
| Ctrl+P          | command palette                                   |
| Ctrl+B          | actors overlay                                    |
| Ctrl+F          | search everywhere                                 |
| z               | zoom active view (detail → full; zones unchanged) |
| Esc             | close overlay / cancel                            |
| ?               | help                                              |
| q               | quit (prompt empty)                               |

While the prompt has text, bare keys type into the prompt; Ctrl chords
stay global. Changing focus must not stop background actors.

Note: Ctrl+M is bound to the model switcher in the resolver, but real
terminals send CR for Ctrl+M (indistinguishable from Enter), so the
reachable paths are `/model` with no args and the palette action.

## 9. Overlay system

Overlays (`src/tui/overlays/`): command palette, actors, help, diff
preview, approval dialog, model switcher, search everywhere. Rules:
ephemeral, never replace runtime state, always closable with Esc, must
work at small terminal sizes.

Every searchable list reuses one component — `UniversalPicker`
(`src/tui/overlays/UniversalPicker.tsx`, pure logic in
`src/interaction/picker.ts`): type to filter, ↑/↓ navigate, Enter
select; multi-select mode toggles with Space and confirms with Enter.
New pickers must build on it, not reimplement list UIs.

## 10. Interaction layer

Typing flows through `src/interaction/` — independent of the agent
runtime and of Ink:

- `keybindings.ts` — pure key → UiCommand resolver.
- `ui-state.ts` — presentation state (active view, overlay, zoom).
- `slash-commands.ts` — plugin registry (`SlashCommand`), `/help`,
  `/clear`, `/model`, `/reset`, view-focus commands, `/quit`.
- `history.ts` — deduped prompt history with draft preservation and
  reverse search.
- `completion.ts` — ghost text (Tab accepts all, Right Arrow one word)
  and slash-command autocomplete rendered in the Context Strip.
- `templates.ts` — `@` prompt templates (`@review`, `@tests`,
  `@refactor`, `@docs`, `@security`); selecting inserts the template
  body into the prompt.
- `picker.ts` — universal filter/window logic shared by all pickers.
- `search.ts` — the Ctrl+F index over conversation, logs, memory,
  tasks, tool calls, git files, and commands; results focus the owning
  view.

Input modes are implicit today (NORMAL typing, COMMAND via `/` and the
palette, APPROVAL while an approval is pending); new modes must be added
to this table, not bolted onto views.

## 11. Testing contract

- Unit: state transitions, task machine, token prioritization, density
  selection, truncation, keybindings, overlay open/close, slash commands,
  history, completion (`tests/runtime`, `tests/layout`,
  `tests/interaction`).
- Snapshots: 80×24, 100×30, 120×30, 160×45, 220×60
  (`tests/tui/snapshots.test.tsx`).
- Interaction: focus switching, approval flow, streaming flow, prompt
  flow (`tests/tui/App.test.tsx`).
- Regression: no overflow, no clipped prompt, no lost zones at any size.

## 12. Frozen decisions

Keep: one permanent layout, live activity strip, dynamic context strip,
actor-based runtime, adaptive detail only, keyboard-first interaction.

Removed (do not reintroduce): dashboards, web tabs, card layouts, default
navigation sidebars, fixed multi-column page grids, decorative UI.

Mandatory: every actor always alive, every action observable, every
status line informative, every view terminal-native, every resize safe.
