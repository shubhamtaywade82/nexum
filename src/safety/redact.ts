const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: "aws",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  },
  {
    name: "generic_key",
    re: /\b(?:api[_-]?key|secret|token|password|authorization)\s*[:=]\s*['"]?[^\s'"]{8,}/gi,
  },
  {
    name: "bearer",
    re: /\bBearer\s+[A-Za-z0-9._\-+=/]{12,}/gi,
  },
  {
    name: "sk_live",
    re: /\bsk[_-](?:live|test)[_-][A-Za-z0-9]{16,}\b/gi,
  },
];

const REDACTED = "[REDACTED]";

/** Redact common secret patterns from free text. */
export function redactText(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

/** Deep-redact strings in JSON-like objects (arrays/objects). */
export function redactObject<T>(value: T): T {
  if (typeof value === "string") {
    return redactText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactObject(v)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/password|secret|token|api[_-]?key|authorization/i.test(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactObject(v);
      }
    }
    return out as T;
  }
  return value;
}
