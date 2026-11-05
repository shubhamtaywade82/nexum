import React, { useState } from "react";
import { Box, Text, useInput, useMouse } from "@nemesis-oss/termina-core";
import { THEME_ORDER, ThemeName } from "../../runtime/types.js";
import { getTheme } from "../ui/theme-registry.js";
import { useTheme } from "../ui/hooks/use-theme.js";
import { MOUSE_SGR_PATTERN } from "../../interaction/mouse.js";
import { OverlayFrame } from "./OverlayFrame.js";

export interface ThemeSwitcherProps {
  current: ThemeName;
  width: number;
  rows: number;
  active: boolean;
  onSelect(theme: ThemeName): void;
}

const NAME_COL = 24; // 4-char prefix + longest name ("high-contrast-light") + margin
const SWATCH_COL = 14;

/** JS-side truncation/padding — Ink's wrap in fixed-height rows is unreliable. */
function padName(name: string): string {
  return name.length > NAME_COL - 5 ? `${name.slice(0, NAME_COL - 6)}…` : name.padEnd(NAME_COL - 5);
}

/**
 * "/theme" with no argument: every built-in palette with a live color
 * swatch rendered from that theme's own tokens, so you see what you get
 * before committing. Selection applies instantly (and persists — see
 * useCommandEffects' set-theme handler).
 */
export function ThemeSwitcher({ current, width, rows, active, onSelect }: ThemeSwitcherProps): React.JSX.Element {
  const theme = useTheme();
  const [index, setIndex] = useState(() => Math.max(0, THEME_ORDER.indexOf(current)));
  const clampedIndex = Math.min(index, THEME_ORDER.length - 1);

  // Simple windowing: keep the selected row in view when the list is taller
  // than the available rows. Budget: frame border (2) + title (1) + hint (1)
  // + one scroll indicator (1) — under-budgeting makes Ink clip a middle row.
  const listRows = Math.max(1, rows - 5);
  const windowStart = Math.max(0, Math.min(clampedIndex - (listRows - 1), THEME_ORDER.length - listRows));
  const visible = THEME_ORDER.slice(windowStart, windowStart + listRows);

  useMouse(
    (event) => {
      if (event.action === "wheel") {
        if (event.button === "wheelUp") {
          setIndex((idx) => Math.max(0, idx - 1));
        } else if (event.button === "wheelDown") {
          setIndex((idx) => Math.min(THEME_ORDER.length - 1, idx + 1));
        }
      }
    },
    { isActive: active },
  );

  useInput(
    (input, key) => {
      if (MOUSE_SGR_PATTERN.test(input)) return; // scroll/click artifact, never real text
      if (key.upArrow) {
        setIndex(Math.max(0, clampedIndex - 1));
      } else if (key.downArrow) {
        setIndex(Math.min(THEME_ORDER.length - 1, clampedIndex + 1));
      } else if (key.return) {
        onSelect(THEME_ORDER[clampedIndex]);
      }
    },
    { isActive: active },
  );

  return (
    <OverlayFrame title={`Color Theme (${THEME_ORDER.length} built-ins)`} width={width} rows={rows}>
      {windowStart > 0 && <Text color={theme.colors.mutedForeground}>{`▲ ${windowStart} more above`}</Text>}
      {visible.map((name, i) => {
        const absolute = windowStart + i;
        const t = getTheme(name);
        const isSelected = absolute === clampedIndex;
        const isCurrent = name === current;
        const bg = isSelected ? theme.colors.selection : undefined;
        const fg = isSelected ? theme.colors.selectionForeground : undefined;
        return (
          <Box key={name} height={1} width="100%" backgroundColor={bg} onClick={() => onSelect(name)}>
            <Text color={fg} wrap="truncate">
              {`${isSelected ? "› " : "  "}${isCurrent ? "●" : "○"} ${padName(name)}`}
            </Text>
            <Box width={SWATCH_COL}>
              <Text>
                <Text color={t.colors.primary}>●</Text>
                <Text color={t.colors.success}>●</Text>
                <Text color={t.colors.warning}>●</Text>
                <Text color={t.colors.error}>●</Text>
                <Text color={t.colors.accent}>●</Text>
                <Text color={t.colors.info}>●</Text>
                <Text color={t.colors.mutedForeground}>●</Text>
              </Text>
            </Box>
            {isCurrent && <Text color={fg ?? theme.colors.mutedForeground}> current</Text>}
          </Box>
        );
      })}
      {windowStart + visible.length < THEME_ORDER.length && (
        <Text color={theme.colors.mutedForeground}>
          {`▼ ${THEME_ORDER.length - windowStart - visible.length} more below`}
        </Text>
      )}
      <Text color={theme.colors.mutedForeground}>↑/↓ Navigate Enter Apply Esc Close</Text>
    </OverlayFrame>
  );
}
