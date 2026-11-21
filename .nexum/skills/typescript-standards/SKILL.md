---
name: typescript-standards
description: Production TypeScript standards and type design. Use when defining domain models, type-safe APIs, typed errors, branded types, discriminated unions, or when writing and refactoring TypeScript code under strict compiler options.
---

# TypeScript Standards & Type Design

Follow these standards to maintain compile-time correctness, runtime safety, and maintainable domain models in Nexum TypeScript codebases.

## 1. Zero `any` Policy & Safe Narrowing

- **Never use `any`**: Use `unknown` for dynamic or untrusted values (API payloads, JSON parse results, user inputs).
- **Narrow explicitly**: Use custom type guards (`isX(val: unknown): val is X`), `typeof`, `instanceof`, or validation schemas (Zod).

```typescript
export interface UserProfile {
  id: string;
  email: string;
}

export function isUserProfile(value: unknown): value is UserProfile {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && typeof candidate.email === "string";
}
```

---

## 2. Branded Types for Domain Identifiers

Prevent "Primitive Obsession" where generic strings or numbers are accidentally passed to mismatched parameters.

```typescript
export type Brand<K, T> = K & { readonly __brand: T };

export type UserId = Brand<string, "UserId">;
export type RunId = Brand<string, "RunId">;
export type UsdAmount = Brand<number, "UsdAmount">;

export function makeUserId(raw: string): UserId {
  if (!raw || raw.trim().length === 0) throw new Error("Invalid UserId");
  return raw as UserId;
}
```

---

## 3. Discriminated Unions for State Machines

Model domain states and lifecycle events as discriminated unions with an explicit `kind` or `status` tag. Ensure exhaustive checking using `assertNever`.

```typescript
export type TaskState =
  | { status: "pending"; queuedAt: number }
  | { status: "running"; startedAt: number; workerId: string }
  | { status: "completed"; finishedAt: number; result: unknown }
  | { status: "failed"; failedAt: number; error: string };

export function assertNever(x: never): never {
  throw new Error(`Unexpected object: ${JSON.stringify(x)}`);
}

export function describeTaskState(state: TaskState): string {
  switch (state.status) {
    case "pending":
      return `Queued at ${new Date(state.queuedAt).toISOString()}`;
    case "running":
      return `Running on worker ${state.workerId}`;
    case "completed":
      return "Finished successfully";
    case "failed":
      return `Failed: ${state.error}`;
    default:
      return assertNever(state);
  }
}
```

---

## 4. Result Type Error Handling

For predictable operational failures (parsing errors, validation failures, missing resources), return a `Result<T, E>` rather than throwing exceptions across boundaries.

```typescript
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
```

---

## 5. Immutability by Default

- Use `readonly` on interface properties and `ReadonlyArray<T>` or `readonly T[]` for lists.
- Avoid in-place mutations. Use object spread or array mapping.
- Keep functions pure and side-effect-free where possible.
