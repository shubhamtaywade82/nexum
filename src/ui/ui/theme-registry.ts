/**
 * Nexum theme registry — the single ThemeName -> Theme token mapping.
 *
 * Themes are semantic, never raw colors: components consume tokens via
 * `useTheme()` (src/ui/ui/hooks/use-theme.ts) or the compat shim
 * `semanticColor()` (src/layout/theme-map.ts), so switching a theme never
 * requires touching a component.
 *
 * The termcn-published palettes below are vendored source (owned by this
 * repo) fetched once via `node scripts/vendor-termcn.mjs theme-<name>`;
 * the three Nexum-native palettes are hand-authored to stay byte-compatible
 * with the original hardcoded ANSI colors (default/midnight/solarized) so
 * existing output and snapshots are preserved exactly.
 */

import { THEME_ORDER, ThemeName } from "../../runtime/types.js";
import { catppuccinTheme } from "./lib/terminal-themes/catppuccin.js";
import { draculaTheme } from "./lib/terminal-themes/dracula.js";
import { githubTheme } from "./lib/terminal-themes/github.js";
import { gruvboxTheme } from "./lib/terminal-themes/gruvbox.js";
import { highContrastLightTheme } from "./lib/terminal-themes/high-contrast-light.js";
import { highContrastTheme } from "./lib/terminal-themes/high-contrast.js";
import { matrixTheme } from "./lib/terminal-themes/matrix.js";
import { monokaiTheme } from "./lib/terminal-themes/monokai.js";
import { nordTheme } from "./lib/terminal-themes/nord.js";
import { oneDarkTheme } from "./lib/terminal-themes/one-dark.js";
import { tokyoNightTheme } from "./lib/terminal-themes/tokyo-night.js";
import { vercelTheme } from "./lib/terminal-themes/vercel.js";
import type { Theme } from "./types.js";

/** Nexum-native "default": the original ANSI-named palette, unchanged. */
const nexumDefault: Theme = {
  name: "default",
  colors: {
    primary: "blue",
    primaryForeground: "white",
    secondary: "gray",
    secondaryForeground: "white",
    accent: "magenta",
    accentForeground: "white",
    success: "green",
    successForeground: "white",
    warning: "yellow",
    warningForeground: "white",
    error: "red",
    errorForeground: "white",
    info: "cyan",
    infoForeground: "white",
    background: "black",
    foreground: "white",
    muted: "gray",
    mutedForeground: "gray",
    border: "gray",
    focusRing: "blue",
    selection: "magenta",
    selectionForeground: "white",
  },
  spacing: { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 6: 6, 8: 8 },
  typography: { bold: true, sm: "dim", base: "", lg: "bold", xl: "bold" },
  border: { style: "round", color: "gray", focusColor: "blue" },
};

/** Nexum-native "midnight": the original One-Dark-flavored palette, unchanged. */
const nexumMidnight: Theme = {
  name: "midnight",
  colors: {
    primary: "#61afef",
    primaryForeground: "#282c34",
    secondary: "#5c6370",
    secondaryForeground: "#abb2bf",
    accent: "#c678dd",
    accentForeground: "#282c34",
    success: "#98c379",
    successForeground: "#282c34",
    warning: "#e5c07b",
    warningForeground: "#282c34",
    error: "#e06c75",
    errorForeground: "#282c34",
    info: "#56b6c2",
    infoForeground: "#282c34",
    background: "#282c34",
    foreground: "#abb2bf",
    muted: "#3e4451",
    mutedForeground: "#5c6370",
    border: "#3e4451",
    focusRing: "#61afef",
    selection: "#3e4451",
    selectionForeground: "#d7dce0",
  },
  spacing: { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 6: 6, 8: 8 },
  typography: { bold: true, sm: "dim", base: "", lg: "bold", xl: "bold" },
  border: { style: "round", color: "#3e4451", focusColor: "#61afef" },
};

/** Nexum-native "solarized": the original Solarized-dark palette, unchanged. */
const nexumSolarized: Theme = {
  name: "solarized",
  colors: {
    primary: "#268bd2",
    primaryForeground: "#002b36",
    secondary: "#586e75",
    secondaryForeground: "#93a1a1",
    accent: "#d33682",
    accentForeground: "#002b36",
    success: "#859900",
    successForeground: "#002b36",
    warning: "#b58900",
    warningForeground: "#002b36",
    error: "#dc322f",
    errorForeground: "#002b36",
    info: "#2aa198",
    infoForeground: "#002b36",
    background: "#002b36",
    foreground: "#93a1a1",
    muted: "#073642",
    mutedForeground: "#657b83",
    border: "#073642",
    focusRing: "#268bd2",
    selection: "#073642",
    selectionForeground: "#eee8d5",
  },
  spacing: { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 6: 6, 8: 8 },
  typography: { bold: true, sm: "dim", base: "", lg: "bold", xl: "bold" },
  border: { style: "round", color: "#073642", focusColor: "#268bd2" },
};

/**
 * Completeness is compiler-enforced: adding a ThemeName without a palette
 * fails the build, and a palette here without a ThemeName is dead weight.
 */
const REGISTRY: Record<ThemeName, Theme> = {
  default: nexumDefault,
  midnight: nexumMidnight,
  solarized: nexumSolarized,
  dracula: draculaTheme,
  nord: nordTheme,
  github: githubTheme,
  gruvbox: gruvboxTheme,
  "tokyo-night": tokyoNightTheme,
  monokai: monokaiTheme,
  catppuccin: catppuccinTheme,
  "one-dark": oneDarkTheme,
  vercel: vercelTheme,
  "high-contrast": highContrastTheme,
  "high-contrast-light": highContrastLightTheme,
  matrix: matrixTheme,
};

/** Resolve a theme by name; unknown names fall back to "default". */
export function getTheme(name: ThemeName): Theme {
  return REGISTRY[name] ?? REGISTRY.default;
}

/** All built-in theme names, in cycle order. */
export function themeNames(): readonly ThemeName[] {
  return THEME_ORDER;
}
