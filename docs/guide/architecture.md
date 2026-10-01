# Architecture Overview

Nexum is built around an event-driven, sandboxed, multi-tier agent architecture designed for maximum autonomy, privacy, and safety.

```
┌──────────────────────────────────────────────────────────┐
│                   Ink React Terminal UI                  │
│       Conversation · Plan · Tasks · Changes · Logs       │
└────────────────────────────┬─────────────────────────────┘
                             │ Events & Dispatch
┌────────────────────────────▼─────────────────────────────┐
│               Centralized State Store (Redux)            │
│               .nexum/checkpoint.json                  │
└────────────────────────────┬─────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────┐
│                 Agent Orchestration Loop                 │
│         Parallel DAG Planner · Loop Detection            │
└──────┬──────────────┬──────────────┬──────────────┬──────┘
       │              │              │              │
┌──────▼──────┐┌──────▼──────┐┌──────▼──────┐┌──────▼──────┐
│ Capability  ││  Docker     ││   14 LSP    ││  Offline    │
│ Router      ││  Sandbox    ││   Servers   ││  DevDocs    │
│ Local/Cloud ││  --net=none ││  AST Engine ││  SQLite FTS │
└─────────────┘└─────────────┘└─────────────┘└─────────────┘
```

---

## Key Architectural Principles

1. **Local-First with Capability Fallback**:
   Every turn attempts low-latency local execution. If the model determines it needs heavy reasoning or vision capabilities, it self-escalates via `escalate_task` to the cloud tier.

2. **Isolated Docker Sandboxing**:
   All shell and build executions run in dedicated ephemeral containers with no network access (`--network=none`), bounded CPU/memory, and hard 2 MiB output ceilings with escalation kills.

3. **Immutable Single Source of Truth**:
   The entire UI is driven by an immutable event-reduced state store, ensuring clean rendering and time-travel replay capabilities.

4. **Fault Recovery & Checkpointing**:
   Multi-step plans are checkpointed to `.nexum/checkpoint.json` after every step transition. Crashed or aborted sessions resume seamlessly via `/resume`.

---

## The Three Planes

The runtime is layered so that each plane only knows about the plane below it:

```
Evolution Plane   (src/evolution)      ClosedLoopEngine — spawn mutation runs,
                                    grade them, evolve the system. Sits ABOVE
                                    the runtime and drives it through the
                                    public AgentRuntime API.
Control Plane     (src/orchestration)  Planner · TaskGraph · Scheduler ·
                                    Delegator · AgentRegistry. Decides WHAT
                                    runs and in what order; owns capability-
                                    driven delegation to child agents.
Agent Runtime     (src/runtime)        AgentRuntime — the composition root.
                                    Owns state, budgets, policies, retries,
                                    cancellation, checkpoints. Strategies
                                    (react / plan_execute / graph) own only
                                    the reasoning loop.
```

### Agent runtime services

The old god-class `Agent` was decomposed into focused services, composed by `AgentRuntime`:

| Service | Responsibility |
|----------|----------------|
| `ModelGateway` | Scored model routing (`ModelRouter → ModelSelection → ProviderAdapter`) — transport-free selection, config-driven preferences |
| `ToolGateway` | The tool pipeline: registry → schema validation → capability check → policy check → budget guard → idempotency → executor |
| `PolicyEngine` | Centralized rule chain + execution profiles (readonly / development / testing / devops / networked / production) |
| `ContextManager` | Request-scoped `ExecutionContext` — runId, messages, budget, policy, cancellation signal |
| `SessionManager` | Session lifecycle and durable history |
| `ExecutionManager` | Run orchestration, retries, checkpoints, recording |
| `ApprovalManager` | Confirmation flows for high-risk / financial tools |

### Execution contracts

Every tool declares a contract (risk, capabilities, side effects, idempotency, reversibility, timeout, concurrency, confirmation, network requirements). State-changing file edits go through CAS verification (`read → hash → patch → verify → apply atomically`). External mutations carry idempotency keys; shell executions are tracked by a lifecycle accountant (container, CPU, memory, PIDs, network mode, duration, output bytes, exit status) and persisted to `.nexum/shell-executions.jsonl`.

Domain logic (trading, Rails intelligence, Ruby tooling) lives in `src/domains` packages layered on top of the runtime — the runtime itself stays domain-neutral. The trading pipeline in particular enforces `LLM proposal → deterministic validation → risk engine → execution policy → paper/live executor`, so the LLM is never the authoritative risk or execution layer.

---

## The Decision Plane (System One)

Nexum has a separate, **bounded** Decision Plane alongside the Generation Plane. System One is not modeled as another `Provider.chat()` model — it is a small bounded decision engine used for tool-domain selection, ambiguous routing hints, and a cheap verification gate.

```
Nexum Model Plane
      │
   ┌──┴───┐
   │      │
Generation   Decision
   │      │
Provider/   DecisionGateway
Gateway     │
            SystemOneDecisionGateway (local-only, non-streaming)
            │
            SystemOneClient (SDK seam — pending upstream re-export)
```

Key invariants:

- The Decision Plane never falls back from a decision call to `Provider.chat()`.
- It is **off by default** (`NEXUM_DECISION=true` to enable) and **auto-disabled in a cloud tier** (System One is local-only).
- The decision model is independently configurable (`NEXUM_DECISION_MODEL`), independent of the primary generation `model`.
- The Decision Plane only changes *which* tools are surfaced or *whether* the expensive critic is entered — it never executes a tool, never bypasses the `ApprovalBroker`, never replaces deterministic verification.

See `docs/guide/decision-plane.md` for the full guide (gateway contract, error model, SDK adapter seam, integrations, configuration, telemetry/replay, evaluation harness).

