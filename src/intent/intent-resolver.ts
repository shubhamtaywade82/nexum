import { randomUUID } from "node:crypto";
import { ClarificationOption, ClarificationRequest, ClarificationResponse, ProjectInfo } from "../runtime/types.js";

interface TopicTemplate {
  pattern: RegExp;
  question: string;
  defaultOptions: Array<{ id: string; label: string; detail: string }>;
}

const TOPIC_TEMPLATES: TopicTemplate[] = [
  {
    pattern: /\b(oops?|object[\s-]oriented(\s+programming)?)\b/i,
    question: "Which aspect of Object-Oriented Programming (OOP) would you like to explore?",
    defaultOptions: [
      {
        id: "general",
        label: "General OOP concepts",
        detail: "Classes, objects, inheritance, polymorphism, encapsulation",
      },
      {
        id: "patterns",
        label: "Design patterns & SOLID",
        detail: "Architecture, SOLID principles, composition over inheritance",
      },
      {
        id: "practical",
        label: "Practical code examples",
        detail: "Real-world walkthroughs and hands-on demonstrations",
      },
      {
        id: "interview",
        label: "Interview preparation",
        detail: "Common interview questions, core definitions, and trade-offs",
      },
    ],
  },
  {
    pattern: /\b(auth|authentication|login)\b/i,
    question: "What type of authentication approach do you want to use?",
    defaultOptions: [
      { id: "jwt", label: "JWT / Token-based", detail: "Stateless JSON Web Tokens with refresh tokens" },
      { id: "session", label: "Session / Cookie-based", detail: "Server-side sessions with secure HTTP-only cookies" },
      { id: "oauth", label: "OAuth2 / Social login", detail: "Third-party login via GitHub, Google, or OIDC provider" },
    ],
  },
  {
    pattern: /\b(caching?|cache)\b/i,
    question: "Which caching strategy or layer do you want to explore?",
    defaultOptions: [
      { id: "in_memory", label: "In-memory caching", detail: "Process-level Map, LRU cache, or node-cache" },
      {
        id: "distributed",
        label: "Distributed caching (Redis)",
        detail: "Redis key-value store, TTLs, and cache invalidation",
      },
      { id: "http", label: "HTTP / Browser caching", detail: "Cache-Control headers, ETags, and CDN caching" },
    ],
  },
  {
    pattern: /\b(api|endpoints?|rest(\s*api)?)\b/i,
    question: "What aspect of API design or implementation do you need?",
    defaultOptions: [
      { id: "rest", label: "RESTful API design", detail: "Resource modeling, HTTP methods, status codes, conventions" },
      {
        id: "crud",
        label: "CRUD implementation",
        detail: "Standard create, read, update, delete endpoints with validation",
      },
      {
        id: "security",
        label: "API security & rate-limiting",
        detail: "Headers, rate limits, CORS, input sanitization",
      },
    ],
  },
  {
    pattern: /\b(testing?|unit\s*tests?)\b/i,
    question: "What testing level or practice should we focus on?",
    defaultOptions: [
      { id: "unit", label: "Unit tests", detail: "Isolated tests for individual functions and classes with mocks" },
      {
        id: "integration",
        label: "Integration tests",
        detail: "Testing multiple components and database interactions",
      },
      {
        id: "tdd",
        label: "Test-Driven Development (TDD)",
        detail: "Red-Green-Refactor workflow and test-first mindset",
      },
    ],
  },
];

const LANGUAGE_SPECIFIERS =
  /\b(in\s+)?(typescript|javascript|python|ruby|java|c\+\+|c#|golang|go|rust|php|swift|kotlin)\b/i;
const CODE_FILE_PATTERN = /[\w/-]+\.[a-z]{2,5}\b/i;

function hasSpecificTarget(prompt: string): boolean {
  // Prompts with explicit languages, file extensions, or long detail already have sufficient clarity.
  if (LANGUAGE_SPECIFIERS.test(prompt)) return true;
  if (CODE_FILE_PATTERN.test(prompt)) return true;
  const wordCount = prompt.trim().split(/\s+/).length;
  return wordCount > 7;
}

export class IntentResolver {
  checkAmbiguity(prompt: string, projectInfo?: ProjectInfo): ClarificationRequest | null {
    const trimmed = prompt.trim();
    if (!trimmed || hasSpecificTarget(trimmed)) return null;

    const matched = TOPIC_TEMPLATES.find((t) => t.pattern.test(trimmed));
    if (!matched) return null;

    const options: ClarificationOption[] = [];
    // Inject workspace language as first option when detected to ground recommendations in reality.
    if (projectInfo?.language) {
      const lang = projectInfo.language;
      options.push({
        id: `workspace_${lang.toLowerCase()}`,
        label: `In ${lang} (current workspace)`,
        detail: `Focused specifically on ${lang} conventions in this project`,
      });
    }

    for (const opt of matched.defaultOptions) {
      options.push(opt);
    }

    options.push({
      id: "custom",
      label: "Custom instructions...",
      detail: "Specify your own focus, language, or custom requirements",
      isCustom: true,
    });

    const id = `clar-${randomUUID()}`;
    return { id, prompt: trimmed, question: matched.question, options, allowCustom: true };
  }

  refinePrompt(originalPrompt: string, response: ClarificationResponse, options: ClarificationOption[]): string {
    const custom = response.customText?.trim();
    if (custom) {
      return `${originalPrompt.trim()} (Custom instructions: ${custom})`;
    }

    const matched = options.find((o) => o.id === response.selectedId);
    if (!matched || matched.isCustom) {
      return originalPrompt.trim();
    }

    return `${originalPrompt.trim()} — specifically ${matched.label}: ${matched.detail ?? matched.label}`;
  }
}
