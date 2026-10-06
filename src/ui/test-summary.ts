/**
 * Test-run summaries for the TUI's test_result entries, parsed from the
 * output of run_tests / run_rspec. Recognizes Jest, Vitest, Mocha, pytest
 * and RSpec summary lines; returns null when nothing recognizable is found
 * (the generic tool card still shows the run).
 */

import type { TestFailure } from "../runtime/types.js";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: TestFailure[];
}

const MAX_FAILURES = 20;

function num(re: RegExp, text: string): number | undefined {
  const m = re.exec(text);
  return m ? Number(m[1]) : undefined;
}

export function parseTestSummary(output: string): TestSummary | null {
  // eslint-disable-next-line no-control-regex -- strip ANSI color codes from runner output
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  let passed: number | undefined;
  let failed: number | undefined;

  // Jest: "Tests:       2 failed, 40 passed, 42 total"
  const jest = /^Tests:\s+(.*)$/m.exec(text);
  if (jest) {
    passed = num(/(\d+) passed/, jest[1]) ?? 0;
    failed = num(/(\d+) failed/, jest[1]) ?? 0;
  }
  // Vitest: "Tests  2 failed | 40 passed (42)"
  if (passed === undefined) {
    const vitest = /^\s*Tests\s+(.*\(\d+\))\s*$/m.exec(text);
    if (vitest) {
      passed = num(/(\d+) passed/, vitest[1]) ?? 0;
      failed = num(/(\d+) failed/, vitest[1]) ?? 0;
    }
  }
  // RSpec: "42 examples, 2 failures"
  if (passed === undefined) {
    const rspec = /(\d+) examples?, (\d+) failures?/.exec(text);
    if (rspec) {
      failed = Number(rspec[2]);
      passed = Number(rspec[1]) - failed;
    }
  }
  // pytest: "=== 2 failed, 40 passed in 1.2s ==="
  if (passed === undefined) {
    const pytest = /=+ (.*(?:passed|failed).*) in [\d.]+s/.exec(text);
    if (pytest) {
      passed = num(/(\d+) passed/, pytest[1]) ?? 0;
      failed = num(/(\d+) failed/, pytest[1]) ?? 0;
    }
  }
  // Mocha: "40 passing" / "2 failing"
  if (passed === undefined) {
    const passing = num(/^\s*(\d+) passing/m, text);
    if (passing !== undefined) {
      passed = passing;
      failed = num(/^\s*(\d+) failing/m, text) ?? 0;
    }
  }
  if (passed === undefined || failed === undefined) return null;

  const failures: TestFailure[] = [];
  const seen = new Set<string>();
  const push = (file: string, line: number, message: string) => {
    const key = `${file}:${line}`;
    if (seen.has(key) || failures.length >= MAX_FAILURES) return;
    seen.add(key);
    failures.push({ file, line, message: message.trim().slice(0, 200) });
  };
  // RSpec: "rspec ./spec/auth_spec.rb:48 # Auth logs in"
  for (const m of text.matchAll(/^rspec \.\/(\S+?):(\d+) # (.*)$/gm)) push(m[1], Number(m[2]), m[3]);
  // pytest: "FAILED tests/test_x.py::test_y - AssertionError"
  for (const m of text.matchAll(/^FAILED (\S+?)::(\S+)(?: - (.*))?$/gm))
    push(m[1], 0, `${m[2]}${m[3] ? `: ${m[3]}` : ""}`);
  // Jest: "● Suite › case" followed later by "at ... (path:line:col)"
  for (const m of text.matchAll(/^\s*● (.+)$[\s\S]*?\(([^()\s]+\.(?:[jt]sx?|mjs|cjs)):(\d+):\d+\)/gm)) {
    push(m[2], Number(m[3]), m[1]);
  }
  return { passed: Math.max(0, passed), failed: Math.max(0, failed), failures };
}
