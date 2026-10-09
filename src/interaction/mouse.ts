/**
 * SGR 1006 mouse-reporting escape sequences (scroll wheel, click, double click)
 * e.g. `\x1b[<64;80;34M`.
 *
 * Supported mouse buttons:
 * - 0: Left Click
 * - 1: Middle Click
 * - 2: Right Click
 * - 64: Scroll Up
 * - 65: Scroll Down
 */

// eslint-disable-next-line no-control-regex
export const MOUSE_SGR_PATTERN = /\x1b?\[<\d+;\d+;\d+[Mm]/;

export interface MouseEventInfo {
  button: "left" | "right" | "middle" | "scroll_up" | "scroll_down";
  action: "press" | "release";
  x: number;
  y: number;
  doubleClick?: boolean;
}

let lastClickTime = 0;
let lastClickX = 0;
let lastClickY = 0;

export function parseSgrMouseEvent(input: string): MouseEventInfo | null {
  // eslint-disable-next-line no-control-regex
  const match = input.match(/\x1b?\[<(\d+);(\d+);(\d+)([Mm])/);
  if (!match) return null;

  const cb = parseInt(match[1], 10);
  const x = parseInt(match[2], 10);
  const y = parseInt(match[3], 10);
  const isRelease = match[4] === "m";

  let button: MouseEventInfo["button"];
  if (cb === 64) button = "scroll_up";
  else if (cb === 65) button = "scroll_down";
  else if ((cb & 3) === 2) button = "right";
  else if ((cb & 3) === 1) button = "middle";
  else button = "left";

  const now = Date.now();
  const isDoubleClick =
    button === "left" &&
    !isRelease &&
    now - lastClickTime < 350 &&
    Math.abs(x - lastClickX) <= 1 &&
    Math.abs(y - lastClickY) <= 1;

  if (button === "left" && !isRelease) {
    lastClickTime = now;
    lastClickX = x;
    lastClickY = y;
  }

  return {
    button,
    action: isRelease ? "release" : "press",
    x,
    y,
    doubleClick: isDoubleClick,
  };
}
