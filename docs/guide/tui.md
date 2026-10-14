# Terminal UI & Keybindings

Nexum features an interactive React terminal interface built on termina (`@nemesis-oss/termina-core`, an Ink-compatible renderer) with alternate screen buffer support (`\x1b[?1049h`).

---

## Primary Views

1. **Conversation View (`/chat` or `Ctrl+1`)**:
   Main chat interface with streamed tokens, syntax-highlighted markdown, and inline execution transcripts.

2. **Execution DAG View (`/dag` or `Ctrl+2`)**:
   Visual dependency graph of active and completed plan steps.

3. **Tasks View (`/tasks` or `Ctrl+3`)**:
   Multi-step task breakdown and status trackers.

4. **Changes & Diffs (`/git` or `Ctrl+4`)**:
   Unified diff viewer with addition/deletion counts.

5. **Logs View (`/logs` or `Ctrl+5`)**:
   Real-time system events, tool invocations, and debug traces.

---

## Global Keybindings

| Shortcut | Action                                     |
| :------- | :----------------------------------------- |
| `Ctrl+M` | Open Model Switcher overlay                |
| `Ctrl+P` | Open Universal Command Palette             |
| `Ctrl+D` | Open Execution DAG overlay                 |
| `Ctrl+K` | Open Search Everywhere                     |
| `Ctrl+B` | Toggle Sidebar (Sessions, Tools, Skills)   |
| `Ctrl+C` | Cancel in-flight turn (Double press quits) |

---

## Essential Slash Commands

- `/doctor`: Run system diagnostics
- `/plan <goal>`: Decompose and run an autonomous plan
- `/commit [msg]`: Stage changes and generate a commit message
- `/review`: Review working copy for code smells & security
- `/model <name>`: Switch active LLM (persists automatically)
- `/tier local|cloud`: Switch execution tier
- `/resume`: Restore conversation and plan from previous session
- `/theme [name]`: Change color theme — no argument opens a live-preview picker; selection persists to `.nexum/config.json`

---

## Color Themes

The TUI is fully theme-driven: every component resolves colors from semantic
tokens (`primary`, `success`, `warning`, `error`, `info`, `accent`,
`mutedForeground`, `selection`, …) provided by the vendored [termcn
(ink-ui)](https://github.com/shadcn-labs/termcn) component layer in
`src/tui/ui/`. Changing a theme never requires touching a component.

**Built-in themes (15):** `default`, `midnight`, `solarized` (Nexum-native)
plus `dracula`, `nord`, `github`, `gruvbox`, `tokyo-night`, `monokai`,
`catppuccin`, `one-dark`, `vercel`, `high-contrast`, `high-contrast-light`,
`matrix` (vendored palettes).

Switching:

- `/theme` — opens an interactive picker with live color swatches
- `/theme <name>` — apply directly (Tab-completes theme names)
- `NEXUM_THEME=<name> nexum` — start themed via environment
- `"theme": "<name>"` in `.nexum/config.json` — persisted default
  (`/theme` writes this automatically on every switch)

The active theme applies instantly across every zone, overlay, and view —
no restart. Terminal color-depth degradation (truecolor → 256 → 16) is
handled by the rendering layer, so hex palettes degrade gracefully.

Adding a theme: drop a palette file into `src/tui/ui/lib/terminal-themes/`
(or vendor one with `node scripts/vendor-termcn.mjs theme-<name>`), then
register it in `src/tui/ui/theme-registry.ts` and add its name to
`THEME_ORDER` in `src/runtime/types.ts` — the compiler enforces that every
name has a palette.
