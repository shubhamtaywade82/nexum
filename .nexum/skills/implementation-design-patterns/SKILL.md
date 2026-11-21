---
name: implementation-design-patterns
description: Apply Gang of Four (GoF) design patterns to TypeScript codebases using Refactoring.Guru idioms. Use when refactoring unwieldy classes, replacing complex branching or giant switches, introducing extensible seams, or when code smells call for Strategy, Factory, Adapter, Observer, Command, or State patterns.
---

# Implementation Design Patterns (TypeScript & Refactoring.Guru)

Use this skill when designing or refactoring TypeScript code. Prioritize minimal, surgical abstractions (KISS and YAGNI first). Never introduce a design pattern speculatively; introduce a pattern only when verified code smells or concrete requirements demand an explicit seam.

## 1. Core Decision Principle: NO_PATTERN First

Before choosing a pattern, verify:

1. **Rule of Three**: Do you have at least 3 concrete variations or distinct implementations? If only 1 or 2, use plain functions or a simple conditional.
2. **Deep vs. Shallow Modules**: Keep the public interface minimal while hiding complex orchestration behind the seam.
3. **When NOT to Use**: If standard language features (first-class functions, object literals, module closures) solve the problem simply, do not introduce classes, interfaces, or factories.

---

## 2. Creational Patterns

### Strategy & Factory Method

- **When to Use**: When creating an object whose exact runtime type depends on runtime context or configuration.
- **When NOT to Use**: When instantiation is straightforward or variations are fixed compile-time constants.
- **TypeScript Idiom**: Prefer a discriminated lookup map or factory function over parallel inheritance hierarchies.

```typescript
export type StorageType = "s3" | "local" | "memory";

export interface StorageDriver {
  read(key: string): Promise<Buffer>;
  write(key: string, data: Buffer): Promise<void>;
}

export class StorageFactory {
  private static readonly drivers = new Map<StorageType, () => StorageDriver>();

  static register(type: StorageType, factory: () => StorageDriver): void {
    this.drivers.set(type, factory);
  }

  static create(type: StorageType): StorageDriver {
    const factory = this.drivers.get(type);
    if (!factory) throw new Error(`Unsupported storage type: ${type}`);
    return factory();
  }
}
```

### Builder Pattern

- **When to Use**: Constructing complex immutable objects with multiple optional stages, configurations, or validation steps.
- **When NOT to Use**: When an object has fewer than 4 parameters; use an options interface instead.

---

## 3. Structural Patterns

### Adapter Pattern

- **When to Use**: Integrating an external library, legacy subsystem, or MCP tool into your internal contract without leaking third-party types.
- **When NOT to Use**: When you control both interfaces; refactor the interface directly rather than adding wrapping layers.

```typescript
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
}

export class RedisAdapter implements KeyValueStore {
  constructor(
    private readonly redisClient: {
      get(k: string): Promise<string | null>;
      setEx(k: string, s: number, v: string): Promise<void>;
    },
  ) {}

  async get(key: string): Promise<string | null> {
    return this.redisClient.get(key);
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    const ttlSeconds = ttlMs ? Math.max(1, Math.floor(ttlMs / 1000)) : 3600;
    await this.redisClient.setEx(key, ttlSeconds, value);
  }
}
```

### Decorator Pattern

- **When to Use**: Adding cross-cutting behavior (telemetry, caching, retries, rate limiting) transparently to an existing interface without modifying the underlying class.
- **When NOT to Use**: When the behavior alters business logic invariants.

---

## 4. Behavioral Patterns

### Strategy Pattern

- **When to Use**: Swapping algorithms, evaluation heuristics, or mutation policies at runtime based on configuration or environment.
- **When NOT to Use**: When the variation is a simple scalar value or boolean flag.

```typescript
export interface ScoringStrategy {
  score(tokens: number, latencyMs: number, pass: boolean): number;
}

export class AccuracyFirstStrategy implements ScoringStrategy {
  score(_tokens: number, _latencyMs: number, pass: boolean): number {
    return pass ? 100 : 0;
  }
}

export class EfficiencyStrategy implements ScoringStrategy {
  score(tokens: number, latencyMs: number, pass: boolean): number {
    if (!pass) return 0;
    const speedScore = Math.max(0, 50 - latencyMs / 1000);
    const tokenScore = Math.max(0, 50 - tokens / 100);
    return speedScore + tokenScore;
  }
}
```

### Command Pattern

- **When to Use**: Encapsulating operations as standalone objects to support queuing, undo/redo, task scheduling, or persistent audit logging.
- **When NOT to Use**: When operations run synchronously and never need queuing or rollback.

### Observer Pattern

- **When to Use**: Publishing state changes or telemetry to multiple loosely coupled listeners (e.g., EventBus, Store listeners).
- **When NOT to Use**: When a direct 1:1 method call or callback suffices.

---

## 5. Refactoring.Guru Smell-to-Pattern Catalog

| Code Smell                                | Architectural Symptoms                                         | Target Pattern                           |
| :---------------------------------------- | :------------------------------------------------------------- | :--------------------------------------- |
| **Long Method / Divergent Change**        | Single method handles validation, transformation, and storage. | **Extract Class** + **Strategy**         |
| **Giant Switch / Conditional Complexity** | Type checks or conditionals deciding algorithm execution.      | **Strategy** or **Polymorphic Dispatch** |
| **Shotgun Surgery**                       | Changing a data format requires edits in 5 different files.    | **Adapter** or **Facade**                |
| **Feature Envy**                          | Class frequently reaches into another class's internal fields. | **Move Method** + **Encapsulation**      |
| **Primitive Obsession**                   | Raw numbers/strings representing currency, IDs, coordinates.   | **Value Object** / **Branded Types**     |
