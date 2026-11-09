/**
 * PromptSession: edits, paste collapsing and fast-Enter bursts, with a fake clock
 * and a fake timer so burst timing is exact.
 */
import { describe, it, expect, beforeEach } from "@jest/globals";
import { PromptSession, PromptState, BURST_IDLE_MS, FAST_INPUT_MS } from "../../../src/ui/input/prompt-session.js";

interface Harness {
  session: PromptSession;
  states: PromptState[];
  clock: { now: number };
  timers: Map<number, { fn: () => void; due: number }>;
  /** Advances time, firing any timer that comes due. */
  advance(ms: number): void;
  /** One keypress: the clock moves on by `gap` ms, then `key` is applied. */
  key(gap: number, key: (s: PromptSession) => void): void;
}

function harness(): Harness {
  const states: PromptState[] = [];
  const clock = { now: 1_000 };
  const timers = new Map<number, { fn: () => void; due: number }>();
  let nextId = 1;
  const session = new PromptSession({
    onChange: (s) => states.push(s),
    now: () => clock.now,
    schedule: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, due: clock.now + ms });
      return id;
    },
    cancelScheduled: (handle) => {
      timers.delete(handle as number);
    },
  });
  const advance = (ms: number) => {
    const target = clock.now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) break;
      clock.now = due[1].due;
      timers.delete(due[0]);
      due[1].fn();
    }
    clock.now = target;
  };
  const key = (gap: number, apply: (s: PromptSession) => void) => {
    advance(gap);
    session.touch();
    apply(session);
  };
  return { session, states, clock, timers, advance, key };
}

describe("PromptSession editing", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("types at the cursor and reports every committed state", () => {
    h.key(100, (s) => s.insert("ab"));
    h.key(100, (s) => s.moveLeft());
    h.key(100, (s) => s.insert("X"));
    expect(h.session.text).toBe("aXb");
    expect(h.session.cursor).toBe(2);
    expect(h.states.at(-1)).toEqual({ text: "aXb", cursor: 2 });
  });

  it("applies two backspaces delivered without any render in between", () => {
    h.key(100, (s) => s.insert("abc"));
    h.key(0, (s) => s.backspace());
    h.key(0, (s) => s.backspace());
    expect(h.session.text).toBe("a");
    expect(h.session.cursor).toBe(1);
  });

  it("backspace and delete do nothing at the boundaries", () => {
    h.key(100, (s) => s.backspace());
    h.key(100, (s) => s.insert("a"));
    h.key(100, (s) => s.moveHome());
    h.key(100, (s) => s.deleteForward());
    h.key(100, (s) => s.deleteForward());
    expect(h.session.text).toBe("");
    h.key(100, (s) => s.insert("a"));
    h.key(100, (s) => s.moveEnd());
    h.key(100, (s) => s.deleteForward());
    expect(h.session.text).toBe("a");
  });

  it("moves the cursor within bounds", () => {
    h.key(100, (s) => s.insert("ab"));
    h.key(100, (s) => s.moveRight());
    expect(h.session.cursor).toBe(2);
    h.key(100, (s) => s.moveHome());
    h.key(100, (s) => s.moveLeft());
    expect(h.session.cursor).toBe(0);
    h.key(100, (s) => s.moveEnd());
    expect(h.session.cursor).toBe(2);
  });

  it("a single-line paste is inserted verbatim and the cursor moves past it", () => {
    h.key(100, (s) => s.paste("ab"));
    expect(h.session.text).toBe("ab");
    expect(h.session.cursor).toBe(2);
    h.key(100, (s) => s.insert("X"));
    expect(h.session.text).toBe("abX");
  });

  it("normalizes carriage returns in a pasted chunk", () => {
    h.key(100, (s) => s.paste("a\r\nb"));
    expect(h.session.text).toBe("[Pasted text #1 +2 lines]\na\nb");
  });

  it("a multi-line paste becomes a numbered label followed by the real content", () => {
    h.key(100, (s) => s.insert("hi"));
    h.key(100, (s) => s.paste("one\ntwo\nthree"));
    expect(h.session.text).toBe("hi\n[Pasted text #1 +3 lines]\none\ntwo\nthree");
    expect(h.session.cursor).toBe(h.session.text.length);
  });

  it("numbers each multi-line paste in the session", () => {
    h.key(100, (s) => s.paste("a\nb"));
    h.key(100, (s) => s.paste("c\nd"));
    expect(h.session.text).toContain("[Pasted text #1 +2 lines]");
    expect(h.session.text).toContain("[Pasted text #2 +2 lines]");
  });

  it("a multi-line chunk typed without paste markers is treated as a paste", () => {
    h.key(100, (s) => s.insert("x\ry"));
    expect(h.session.text).toBe("[Pasted text #1 +2 lines]\nx\ny");
  });

  it("shift+enter inserts a newline at the cursor", () => {
    h.key(100, (s) => s.insert("ac"));
    h.key(100, (s) => s.moveLeft());
    h.key(100, (s) => s.newline());
    expect(h.session.text).toBe("a\nc");
    expect(h.session.cursor).toBe(2);
  });

  it("append accepts a suggestion at the end", () => {
    h.key(100, (s) => s.insert("/he"));
    h.key(100, (s) => s.append("lp "));
    expect(h.session.text).toBe("/help ");
    expect(h.session.cursor).toBe(6);
  });

  it("replace and clear set the text and cursor without collapsing", () => {
    h.key(100, (s) => s.replace("hello", 2));
    expect(h.session.snapshot).toEqual({ text: "hello", cursor: 2 });
    h.key(100, (s) => s.clear());
    expect(h.session.snapshot).toEqual({ text: "", cursor: 0 });
  });
});

describe("PromptSession fast-Enter bursts", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("a deliberate Enter submits and leaves the text for the caller", () => {
    h.key(100, (s) => s.insert("hello"));
    let decision: "newline" | "submit" | undefined;
    h.key(100, (s) => {
      decision = s.enter();
    });
    expect(decision).toBe("submit");
    expect(h.session.text).toBe("hello");
  });

  it("a fast Enter is a newline, and a burst of typed lines collapses into a label once idle", () => {
    // A terminal paste arrives as fast keystrokes: the first character opens the typing session.
    h.key(100, (s) => s.insert("one"));
    let decision: "newline" | "submit" | undefined;
    h.key(FAST_INPUT_MS - 5, (s) => {
      decision = s.enter();
    });
    expect(decision).toBe("newline");
    h.key(FAST_INPUT_MS - 5, (s) => s.insert("two"));
    expect(h.session.text).toBe("one\ntwo");

    h.advance(BURST_IDLE_MS);
    expect(h.session.text).toBe("[Pasted text #1 +2 lines]\none\ntwo");
    expect(h.session.cursor).toBe(h.session.text.length);
  });

  it("a burst that starts after a pause keeps the text typed before it", () => {
    h.key(100, (s) => s.insert("keep"));
    h.key(100, (s) => s.moveRight()); // a new typing session starts after "keep"
    h.key(FAST_INPUT_MS - 5, (s) => s.enter());
    h.key(FAST_INPUT_MS - 5, (s) => s.insert("a"));
    h.key(FAST_INPUT_MS - 5, (s) => s.enter());
    h.key(FAST_INPUT_MS - 5, (s) => s.insert("b"));
    h.advance(BURST_IDLE_MS);
    expect(h.session.text).toBe("keep\n[Pasted text #1 +2 lines]\na\nb");
  });

  it("a burst with no pasted line after its newline is left as a plain newline", () => {
    h.key(100, (s) => s.insert("a"));
    h.key(100, (s) => s.moveEnd());
    h.key(FAST_INPUT_MS - 5, (s) => s.enter());
    h.advance(BURST_IDLE_MS);
    expect(h.session.text).toBe("a\n");
  });

  it("a deliberate Enter cancels a pending collapse and leaves the raw text to submit", () => {
    h.key(100, (s) => s.insert("a"));
    h.key(FAST_INPUT_MS - 5, (s) => s.enter());
    h.key(FAST_INPUT_MS - 5, (s) => s.insert("b"));
    // Deliberate: slower than FAST_INPUT_MS, but before the burst goes idle.
    let decision: "newline" | "submit" | undefined;
    h.key(FAST_INPUT_MS * 2, (s) => {
      decision = s.enter();
    });
    expect(decision).toBe("submit");
    expect(h.timers.size).toBe(0);
    h.advance(BURST_IDLE_MS * 2);
    expect(h.session.text).toBe("a\nb");
  });

  it("replace cancels a pending collapse so a later timer cannot rewrite new text", () => {
    h.key(100, (s) => s.insert("a"));
    h.key(FAST_INPUT_MS - 5, (s) => s.enter());
    h.key(FAST_INPUT_MS - 5, (s) => s.insert("b"));
    h.key(100, (s) => s.replace("fresh\nwords\nhere"));
    expect(h.timers.size).toBe(0);
    h.advance(BURST_IDLE_MS * 2);
    expect(h.session.text).toBe("fresh\nwords\nhere");
  });

  it("dispose cancels the pending timer", () => {
    h.key(100, (s) => s.insert("a"));
    h.key(FAST_INPUT_MS - 5, (s) => s.enter());
    h.session.dispose();
    expect(h.timers.size).toBe(0);
  });

  it("a burst whose text was edited back past its start is left alone", () => {
    h.key(100, (s) => s.insert("keep"));
    h.key(100, (s) => s.moveRight()); // the typing session starts with "keep" in place
    h.key(FAST_INPUT_MS - 5, (s) => s.enter());
    h.key(FAST_INPUT_MS - 5, (s) => s.insert("x"));
    h.key(0, (s) => s.backspace());
    h.key(0, (s) => s.backspace());
    h.key(0, (s) => s.backspace());
    expect(h.session.text).toBe("kee");
    h.advance(BURST_IDLE_MS);
    expect(h.session.text).toBe("kee");
  });
});
