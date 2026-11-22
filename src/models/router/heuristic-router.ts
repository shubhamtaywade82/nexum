// Zero-latency prompt classifier. Routes to 'local', 'cloud', or 'unknown'
// before any LLM call, using deterministic regex patterns.

export type HeuristicDecision = "local" | "cloud" | "unknown";

export interface HeuristicResult {
  decision: HeuristicDecision;
  /** Which pattern label matched — useful for logging/metrics. */
  trigger?: string;
}

interface HeuristicPattern {
  re: RegExp;
  label: string;
}

const CLOUD_TRIGGERS: HeuristicPattern[] = [
  { re: /\b(prove|theorem|lemma|derive|induction)\b/i, label: "math_proof" },
  { re: /\b(why|how come|root cause|reason for)\b/i, label: "diagnosis" },
  { re: /\b(debug|refactor|optimize|race condition|deadlock)\b/i, label: "debug" },
  { re: /\b(architecture|design pattern|should I use|trade.?off)\b/i, label: "design" },
  { re: /\b(implement|algorithm|merge sort|binary search|dynamic programming)\b/i, label: "algorithm" },
  { re: /```[\s\S]{600,}```/, label: "large_code_block" },
  { re: /\b(step.by.step|multi.?step|chain of thought)\b/i, label: "multi_step" },
  { re: /\b(design|architect|plan|build).{0,30}(system|service|api|database)\b/i, label: "system_design" },
  { re: /\b(explain|understand|how does).{0,30}work\b/i, label: "explanation" },
  { re: /\b(write|implement|build).{0,50}(middleware|hook|interceptor|plugin)\b/i, label: "framework_integration" },
  { re: /\b(review|critique|audit|evaluate|verify)\b/i, label: "code_review" },
];

const LOCAL_TRIGGERS: HeuristicPattern[] = [
  { re: /\bgenerate\s+a?\s*(typescript|ts)\s+(interface|type)\b/i, label: "ts_interface" },
  { re: /\bwrite\s+a?\s*regex\b/i, label: "regex" },
  { re: /\bextract\s+.+\s+from\s+(this\s+|the\s+)?(log|text|error|stack trace)\b/i, label: "extract" },
  { re: /\bconvert\s+.+\s+to\s+(json|csv|yaml|interface)\b/i, label: "convert" },
  { re: /\bparse\s+(this|the|log|error|stack)\b/i, label: "parse" },
  { re: /\bformat\s+(this|json|data|code)\b/i, label: "format" },
  { re: /\bcreate\s+a?\s*(jest|describe block|test skeleton)\b/i, label: "test_skeleton" },
  { re: /\b(summarize|condense)\s+(this|the)\s+(log|output|error)\b/i, label: "summarize_log" },
];

/** Approximate token count threshold above which a prompt is always cloud-routed. */
const LONG_PROMPT_TOKEN_THRESHOLD = 400; // ~1600 chars

export class HeuristicRouter {
  /**
   * Classifies a prompt into a routing decision.
   *
   * Priority:
   *   1. CLOUD triggers (explicit complexity signals)
   *   2. Long prompt guard (> ~400 tokens ≈ 1600 chars)
   *   3. LOCAL triggers (deterministic boilerplate patterns)
   *   4. UNKNOWN (fall through to primary model path)
   */
  classify(prompt: string): HeuristicResult {
    // Cloud triggers take absolute priority.
    for (const t of CLOUD_TRIGGERS) {
      if (t.re.test(prompt)) return { decision: "cloud", trigger: t.label };
    }

    // Long prompts always go to cloud — small models lose context coherence.
    const approxTokens = Math.ceil(prompt.length / 4);
    if (approxTokens > LONG_PROMPT_TOKEN_THRESHOLD) {
      return { decision: "cloud", trigger: "long_prompt" };
    }

    // Local-safe boilerplate patterns.
    for (const t of LOCAL_TRIGGERS) {
      if (t.re.test(prompt)) return { decision: "local", trigger: t.label };
    }

    return { decision: "unknown" };
  }
}
