/**
 * Built-in evaluation fixtures for the Decision Plane.
 *
 * Each fixture is a (request, expected) pair the
 * {@link evaluateDecisionGateway} harness runs against a gateway. The
 * fixtures cover the categories the integration prompt §30 names:
 *
 *   - tool domain classification (which domain does the request need?)
 *   - tool necessity / NO_ACTION (does the request need any tool?)
 *   - task complexity
 *   - single vs multi-step
 *   - verification
 *   - groundedness
 *   - risk classification
 *
 * The expected outcomes here are the GROUND TRUTH a System One deployment
 * should approximate, not the truth a Wave 7 harness imposes. Fixtures
 * are added/retired as real System One probability distributions become
 * available. The default policy thresholds in `decision-policy.ts` are
 * tunable against these fixtures.
 *
 * These are the canonical fixture sets the Wave 8 evaluation runner uses;
 * downstream callers can also import and extend them.
 */

import type { DecisionEvaluationFixture } from "./evaluation.js";

const DOMAINS: Array<{ id: string; description: string }> = [
  { id: "filesystem", description: "read/write/patch files" },
  { id: "shell", description: "run shell commands" },
  { id: "git", description: "git operations" },
  { id: "github", description: "github operations" },
  { id: "rails", description: "rails operations" },
  { id: "database", description: "database operations" },
  { id: "browser", description: "browser automation" },
  { id: "lsp", description: "lsp / code intelligence" },
  { id: "documentation", description: "docs search" },
  { id: "testing", description: "test runner" },
  { id: "package-management", description: "package install" },
  { id: "deployment", description: "deploy / rollback" },
];

function domainRequest(id: string, context: string): DecisionEvaluationFixture["request"] {
  return {
    id,
    model: "mpuig/system-one-minicpm5-2b-q8",
    mode: "noul",
    context,
    questions: [
      {
        id: "domain",
        prompt: "Which operational domain best matches this user request?",
        choices: DOMAINS,
      },
    ],
  };
}

/**
 * Tool domain classification fixtures — the request is a clear member of
 * one domain and the fixture expects System One to select that domain (and
 * not the others).
 */
export const TOOL_DOMAIN_FIXTURES: DecisionEvaluationFixture[] = [
  {
    id: "tool-domain-filesystem",
    category: "tool-domain-classification",
    description: "request to read a file",
    request: domainRequest("tool-domain-filesystem", "Please read config.json and show me what's inside."),
    expectedSelected: ["filesystem"],
  },
  {
    id: "tool-domain-shell",
    category: "tool-domain-classification",
    description: "request to run a shell command",
    request: domainRequest("tool-domain-shell", "Run `grep -r TODO src` and tell me what's there."),
    expectedSelected: ["shell"],
  },
  {
    id: "tool-domain-git",
    category: "tool-domain-classification",
    description: "request to inspect git state",
    request: domainRequest("tool-domain-git", "Show me the git status and the last commit's diff."),
    expectedSelected: ["git"],
  },
  {
    id: "tool-domain-testing",
    category: "tool-domain-classification",
    description: "request to run tests",
    request: domainRequest("tool-domain-testing", "Run the jest test suite and tell me what failed."),
    expectedSelected: ["testing"],
  },
  {
    id: "tool-domain-mixed-filesystem-shell",
    category: "tool-domain-classification",
    description: "request that needs both filesystem and shell",
    request: domainRequest(
      "tool-domain-mixed-filesystem-shell",
      "Patch src/index.ts to add a null check, then run `npm run build` to confirm it compiles.",
    ),
    expectedSelected: ["filesystem", "shell"],
  },
];

/**
 * NO_ACTION / tool-necessity fixtures — the request is conceptual or
 * conversational; the correct decision is to select NO tools. The fixture
 * expects an empty selected set.
 */
export const NO_ACTION_FIXTURES: DecisionEvaluationFixture[] = [
  {
    id: "no-action-greeting",
    category: "no-action",
    description: "a greeting needs no operational tool",
    request: domainRequest("no-action-greeting", "hello, what can you do?"),
    expectedSelected: [],
  },
  {
    id: "no-action-concept",
    category: "no-action",
    description: "a conceptual question needs no operational tool",
    request: domainRequest("no-action-concept", "what is dependency injection?"),
    expectedSelected: [],
  },
  {
    id: "no-action-explain",
    category: "no-action",
    description: "an explain-concept question needs no operational tool",
    request: domainRequest("no-action-explain", "explain how the React reconciler works."),
    expectedSelected: [],
  },
];

/**
 * Task complexity fixtures — the request resolves a bounded
 * simple-vs-complex decision. Used by the routing-hint evaluation.
 */
export const TASK_COMPLEXITY_FIXTURES: DecisionEvaluationFixture[] = [
  {
    id: "complexity-simple",
    category: "task-complexity",
    description: "a single-step request is 'local'-capable",
    request: {
      id: "complexity-simple",
      model: "mpuig/system-one-minicpm5-2b-q8",
      mode: "noul",
      context: "Add a single 'name' field to the user schema.",
      questions: [
        {
          id: "tier",
          prompt: "Does this need a stronger cloud model?",
          choices: [
            { id: "local", description: "small local model can answer" },
            { id: "cloud", description: "needs a stronger model" },
          ],
        },
      ],
    },
    expectedSelected: ["local"],
  },
  {
    id: "complexity-hard",
    category: "task-complexity",
    description: "a debug + refactor request needs the stronger model",
    request: {
      id: "complexity-hard",
      model: "mpuig/system-one-minicpm5-2b-q8",
      mode: "noul",
      context: "Debug a race condition in the worker pool, then refactor it to be lock-free.",
      questions: [
        {
          id: "tier",
          prompt: "Does this need a stronger cloud model?",
          choices: [
            { id: "local", description: "small local model can answer" },
            { id: "cloud", description: "needs a stronger model" },
          ],
        },
      ],
    },
    expectedSelected: ["cloud"],
  },
];

/**
 * Verification-gate fixtures — the gate decides whether the draft should
 * enter expensive critique. Used by the verification-gate evaluation.
 */
export const VERIFICATION_FIXTURES: DecisionEvaluationFixture[] = [
  {
    id: "verification-acceptable",
    category: "verification",
    description: "a clean draft does not need the expensive critic",
    request: {
      id: "verification-acceptable",
      model: "mpuig/system-one-minicpm5-2b-q8",
      mode: "noul",
      context: "Task goal: Add a null check.\nDraft answer: Added `if (user == null) return;` before the field access.",
      questions: [
        {
          id: "gate",
          prompt: "Does this draft need expensive critique?",
          choices: [
            { id: "accept", description: "acceptable as-is" },
            { id: "escalate", description: "needs critique" },
          ],
        },
      ],
    },
    expectedSelected: ["accept"],
  },
  {
    id: "verification-escalate",
    category: "verification",
    description: "a draft with a TODO marker needs the expensive critic",
    request: {
      id: "verification-escalate",
      model: "mpuig/system-one-minicpm5-2b-q8",
      mode: "noul",
      context:
        "Task goal: Fix the bug.\nDraft answer: I added a TODO here because I wasn't sure how to handle the null case.",
      questions: [
        {
          id: "gate",
          prompt: "Does this draft need expensive critique?",
          choices: [
            { id: "accept", description: "acceptable as-is" },
            { id: "escalate", description: "needs critique" },
          ],
        },
      ],
    },
    expectedSelected: ["escalate"],
  },
];

/** All built-in fixtures in one list, for the Wave 8 evaluation runner. */
export const ALL_DECISION_FIXTURES: DecisionEvaluationFixture[] = [
  ...TOOL_DOMAIN_FIXTURES,
  ...NO_ACTION_FIXTURES,
  ...TASK_COMPLEXITY_FIXTURES,
  ...VERIFICATION_FIXTURES,
];
