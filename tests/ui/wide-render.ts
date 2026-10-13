/**
 * Test renderer for the Nexum TUI, driving `@nemesis-oss/termina-core`'s
 * `render()` against in-memory stdio so suites can assert on `lastFrame()`
 * and send keys through `stdin.write()`.
 *
 * `stdout.columns` is configurable and real. The renderer lays content out
 * against it, so a fixed width would clip anything wider. Multi-box rows are
 * capped by the terminal width, not by a prop passed down the React tree.
 * Most views fit in the default 100 columns (`render()`). The Dashboard view
 * needs >=130 cols to activate its 3-column layout (see
 * DashboardView.MIN_WIDTH_FOR_DASHBOARD), so it renders through `renderWide()`
 * with its own width.
 */

import { EventEmitter } from "node:events";
import { render as inkRender } from "@nemesis-oss/termina-core";
import type { ReactElement } from "react";

class WideStdout extends EventEmitter {
  columns: number;
  frames: string[] = [];
  private _lastFrame?: string;
  constructor(columns: number) {
    super();
    this.columns = columns;
  }
  write = (frame: string): void => {
    this.frames.push(frame);
    this._lastFrame = frame;
  };
  lastFrame = (): string | undefined => this._lastFrame;
}

class Stderr extends EventEmitter {
  frames: string[] = [];
  private _lastFrame?: string;
  write = (frame: string): void => {
    this.frames.push(frame);
    this._lastFrame = frame;
  };
  lastFrame = (): string | undefined => this._lastFrame;
}

class Stdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  write = (data: string): void => {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  };
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => {
    const { data } = this;
    this.data = null;
    return data;
  };
}

export interface RenderWideResult {
  lastFrame: () => string | undefined;
  stdin: Stdin;
  unmount: () => void;
}

const DEFAULT_COLUMNS = 100;

/** Renders `tree` into an in-memory terminal `columns` wide. */
export function renderWide(tree: ReactElement, columns: number): RenderWideResult {
  const stdout = new WideStdout(columns);
  const stderr = new Stderr();
  const stdin = new Stdin();
  const instance = inkRender(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    lastFrame: stdout.lastFrame,
    stdin,
    unmount: () => {
      instance.unmount();
      instance.cleanup();
    },
  };
}

/** Default-width render (100 columns) used by most suites. */
export function render(tree: ReactElement): RenderWideResult {
  return renderWide(tree, DEFAULT_COLUMNS);
}
