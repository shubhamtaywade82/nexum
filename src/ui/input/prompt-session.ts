/**
 * PromptSession — the prompt's text and cursor, and the paste detection that
 * used to be spread through App's key handler.
 *
 * Every edit is applied to the latest state synchronously. The previous
 * version kept the text in React state and read the cursor from the render
 * closure, so two keystrokes delivered before the next render both edited
 * from the same cursor: two backspaces in one tick removed one character. Here
 * the render only mirrors the session (`onChange`); it is never an input.
 *
 * Paste handling:
 *   - A bracketed paste, or a multi-line chunk without markers, is appended at
 *     the end. Single-line content is inserted verbatim; multi-line content
 *     becomes a "[Pasted text #N +K lines]" label followed by the real content,
 *     so submit still sends it in full. The cursor moves past what was inserted.
 *   - Some terminals deliver a multi-line paste as one Enter per line. No person
 *     presses Enter faster than FAST_INPUT_MS, so a fast Enter is a newline in a
 *     burst; the burst collapses into the label once it goes idle for
 *     BURST_IDLE_MS. A deliberate Enter cancels a pending collapse and submits
 *     the raw text.
 */

export interface PromptState {
  readonly text: string;
  readonly cursor: number;
}

/** An Enter closer than this to the previous keypress is the terminal delivering a paste. */
export const FAST_INPUT_MS = 20;
/** A burst is collapsed once no key has arrived for this long. */
export const BURST_IDLE_MS = 60;

export interface PromptSessionOptions {
  /** Receives every committed state. The UI mirrors it; it never feeds back into the session. */
  onChange: (state: PromptState) => void;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
}

interface Burst {
  /** The prompt text as it stood when the current typing session began; the burst's text grows from here. */
  start: string;
}

export class PromptSession {
  private state: PromptState = { text: "", cursor: 0 };
  private pasteCount = 0;
  private lastInputAt = Number.NEGATIVE_INFINITY;
  private gapSincePrev = Number.POSITIVE_INFINITY;
  private sessionStart = "";
  private burst: Burst | null = null;
  private burstTimer: unknown = null;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancelScheduled: (handle: unknown) => void;

  constructor(private readonly opts: PromptSessionOptions) {
    // Date.now is read at call time, so a test that replaces it is honoured.
    this.now = opts.now ?? (() => Date.now());
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancelScheduled = opts.cancelScheduled ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get text(): string {
    return this.state.text;
  }

  get cursor(): number {
    return this.state.cursor;
  }

  get snapshot(): PromptState {
    return this.state;
  }

  /** Replaces the whole prompt (history recall, completion, reset). Cancels a pending burst. */
  replace(text: string, cursor: number = text.length): void {
    this.cancelBurst();
    this.commit({ text, cursor });
  }

  clear(): void {
    this.replace("", 0);
  }

  /**
   * Must run first for every keypress. Records the gap since the previous key, which
   * decides whether an Enter is part of a paste, and where the current typing session began.
   */
  touch(): void {
    const now = this.now();
    this.gapSincePrev = now - this.lastInputAt;
    this.lastInputAt = now;
    if (this.gapSincePrev >= FAST_INPUT_MS) this.sessionStart = this.state.text;
  }

  /**
   * Enter, after touch(). "newline" means the key was part of a paste burst and has been
   * applied; "submit" means the caller should submit (or accept a completion) with the text.
   */
  enter(): "newline" | "submit" {
    if (this.gapSincePrev < FAST_INPUT_MS) {
      if (!this.burst) this.burst = { start: this.sessionStart };
      this.armBurstTimer();
      this.commit({ text: `${this.state.text}\n`, cursor: this.state.text.length + 1 });
      return "newline";
    }
    // A deliberate Enter ends a pending burst: the raw text is what gets submitted.
    this.cancelBurst();
    return "submit";
  }

  /** Shift+Enter: a newline at the cursor. */
  newline(): void {
    this.insertAtCursor("\n");
  }

  /** Typed text. A chunk containing a line break can only be a paste delivered without markers. */
  insert(input: string): void {
    const cleaned = normalizeLineBreaks(input);
    if (cleaned.includes("\n")) this.paste(cleaned);
    else this.insertAtCursor(cleaned);
  }

  /** A bracketed paste (or any multi-line chunk): appended, collapsed when multi-line. */
  paste(raw: string): void {
    this.commit(this.appended(this.state.text, normalizeLineBreaks(raw)));
  }

  backspace(): void {
    const { text, cursor } = this.state;
    if (cursor === 0) return;
    this.commit({ text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 });
  }

  deleteForward(): void {
    const { text, cursor } = this.state;
    if (cursor >= text.length) return;
    this.commit({ text: text.slice(0, cursor) + text.slice(cursor + 1), cursor });
  }

  /** Appends at the end without collapsing: used to accept a ghost suggestion. */
  append(suffix: string): void {
    const { text } = this.state;
    this.commit({ text: text + suffix, cursor: text.length + suffix.length });
  }

  moveLeft(): void {
    this.commit({ text: this.state.text, cursor: Math.max(0, this.state.cursor - 1) });
  }

  moveRight(): void {
    this.commit({ text: this.state.text, cursor: Math.min(this.state.text.length, this.state.cursor + 1) });
  }

  moveHome(): void {
    this.commit({ text: this.state.text, cursor: 0 });
  }

  moveEnd(): void {
    this.commit({ text: this.state.text, cursor: this.state.text.length });
  }

  /** Forgets any pending burst so its timer cannot fire after the UI is gone. */
  dispose(): void {
    this.cancelBurst();
  }

  private finalizeBurst(): void {
    const burst = this.burst;
    this.burst = null;
    this.burstTimer = null;
    if (!burst) return;
    const { text } = this.state;
    if (!text.startsWith(burst.start)) return; // the text diverged from the burst; leave it alone
    const added = text.slice(burst.start.length).replace(/^\n/, "");
    if (added.split("\n").length <= 1) return;
    this.commit(this.appended(burst.start, added));
  }

  /** The state after appending `pasted` to `prev`, with the cursor past the inserted text. */
  private appended(prev: string, pasted: string): PromptState {
    const lineCount = pasted.split("\n").length;
    if (lineCount <= 1) {
      const text = prev + pasted;
      return { text, cursor: text.length };
    }
    this.pasteCount += 1;
    const prefix = prev ? `${prev}\n` : "";
    const text = `${prefix}[Pasted text #${this.pasteCount} +${lineCount} lines]\n${pasted}`;
    return { text, cursor: text.length };
  }

  private insertAtCursor(s: string): void {
    const { text, cursor } = this.state;
    this.commit({ text: text.slice(0, cursor) + s + text.slice(cursor), cursor: cursor + s.length });
  }

  private armBurstTimer(): void {
    if (this.burstTimer !== null) this.cancelScheduled(this.burstTimer);
    this.burstTimer = this.schedule(() => this.finalizeBurst(), BURST_IDLE_MS);
  }

  private cancelBurst(): void {
    if (this.burstTimer !== null) this.cancelScheduled(this.burstTimer);
    this.burstTimer = null;
    this.burst = null;
  }

  private commit(next: PromptState): void {
    this.state = next;
    this.opts.onChange(next);
  }
}

/** Terminals send a line break as \r\n, \r or \n; the session works in \n only. */
function normalizeLineBreaks(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
