/**
 * Density rules. The layout never restructures with width — the five
 * zones are permanent. Width only selects how much detail each zone gets.
 */

export type Density = "minimal" | "compact" | "normal" | "high";

/** Hard width tiers. Density only — never layout restructuring. */
export function densityForWidth(columns: number): Density {
  if (columns >= 160) return "high";
  if (columns >= 120) return "normal";
  if (columns >= 90) return "compact";
  return "minimal";
}

/** Widget detail levels, one step below density naming to keep both explicit. */
export type DetailLevel = "compact" | "normal" | "expanded" | "full";

export function detailForDensity(density: Density): DetailLevel {
  switch (density) {
    case "high":
      return "full";
    case "normal":
      return "expanded";
    case "compact":
      return "normal";
    case "minimal":
      return "compact";
  }
}

/** Maximum visible completion rows in the CompletionSurface. */
export const MAX_COMPLETION_ROWS = 6;

/**
 * Rows available to the Active View given total terminal rows.
 * Fixed chrome: Header(1) + divider(1) + ActivityStrip(1) + divider(1) +
 * Prompt(1 baseline) + divider(1) + ContextStrip(1) = 7. Pass promptRows
 * for the full prompt area height (PromptBar + optional CompletionSurface)
 * so the Active View shrinks accordingly. Never less than 3 rows.
 */
export function activeViewRows(totalRows: number, promptRows: number = 1): number {
  const fixed = 7 + (promptRows - 1);
  return Math.max(3, totalRows - fixed);
}
