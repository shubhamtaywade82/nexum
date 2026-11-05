/**
 * Compat shim over the Nexum theme registry (src/ui/ui/theme-registry.ts).
 *
 * Colors are semantic only: healthy = done, active = focused, waiting =
 * warning, error = blocked, thinking = model activity, muted = de-emphasized.
 * The active theme is driven by the store's "theme.changed" event (see
 * runtime/store.ts), mirrored here into `activeThemeName` so the call sites
 * using semanticColor()/themeColors() don't each need `state.theme` threaded
 * through as a parameter.
 *
 * New components should prefer `useTheme()` from src/ui/ui/ and consume the
 * full token set; this module exists for the legacy non-React call sites.
 */

import { ActorHealth, ThemeName } from "../../runtime/types.js";
import { getTheme } from "../ui/theme-registry.js";
import type { Theme } from "../ui/types.js";

interface SemanticPalette {
  healthy: string;
  active: string;
  waiting: string;
  error: string;
  thinking: string;
  muted: string;
  border: string;
  focusBorder: string;
  // Token aliases onto the same values — lets call sites speak either the
  // legacy health vocabulary or the ink-ui token vocabulary.
  primary: string;
  success: string;
  warning: string;
  info: string;
  accent: string;
  foreground: string;
  mutedForeground: string;
  selection: string;
  selectionForeground: string;
}

/** Project the full Theme token set onto the legacy 8-slot semantic palette. */
function paletteFor(theme: Theme): SemanticPalette {
  return {
    healthy: theme.colors.success,
    active: theme.colors.primary,
    waiting: theme.colors.warning,
    error: theme.colors.error,
    thinking: theme.colors.accent,
    muted: theme.colors.mutedForeground,
    border: theme.colors.border,
    focusBorder: theme.border.focusColor,
    primary: theme.colors.primary,
    success: theme.colors.success,
    warning: theme.colors.warning,
    info: theme.colors.info,
    accent: theme.colors.accent,
    foreground: theme.colors.foreground,
    mutedForeground: theme.colors.mutedForeground,
    selection: theme.colors.selection,
    selectionForeground: theme.colors.selectionForeground,
  };
}

let activeThemeName: ThemeName = "default";

/** Only the store's reducer calls this, in lockstep with "theme.changed". */
export function setActiveTheme(name: ThemeName): void {
  activeThemeName = name;
}

export function semanticColor(health: ActorHealth): string {
  return paletteFor(getTheme(activeThemeName))[health];
}

export function themeColors(name: ThemeName = activeThemeName): SemanticPalette {
  return paletteFor(getTheme(name));
}
