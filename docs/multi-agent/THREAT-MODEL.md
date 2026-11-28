# Nexum Multi-Agent Coordination v1 — Threat Model

Companion to `docs/multi-agent/SPEC.md`. This threat model **inherits** the
repo's `SECURITY.md` posture and adds the coordination layer's specific
threats. It does not weaken, replace or reinterpret any existing control.

## 1. Premise (from SECURITY.md)

> "Nexum runs an LLM that chooses tool calls. Assume the model can be
> steered by anything it reads (prompt injection via files, web pages,
> issues, tool output). The boundaries are designed so that a steered model
> is contained by **isolation** (what code can physically reach), not merely
> by **policy** (what the model is asked or allowed to request)."

The three-agent layer adds **two more steered models** (four counting
workers). The design answer is the same: isolation and deterministic
re-validation, not prompting. The roles are scoped so that even a fully
adversarial Tracker or Predictor has nothing to attack with (read-only
postures), and a fully adversarial Commander can only produce proposals that
die at `reValidateDecision`.

## 2. Assets

| Asset | Where | Impact of compromise |
| --- | --- | --- |
| Workspace source tree | host (WorkspaceGuard) | code integrity, supply chain |
| Host filesystem beyond workspace | host | secrets, SSH keys, credentials |
| Git remotes / GitHub token | host (`git`, `gh`) | repo takeover, token scope abuse |
| Docker daemon | host, root-equivalent (SECURITY.md §4) | host compromise |
| Mission event + artifact stores | `.nexum/runs`, `src/artifacts` | audit integrity, evidence trust |
| Kit evidence journal (hash chain) | Kit workspace state | verification integrity |
| Budgets / policy config | mission policy (in-process) | runaway cost, permission widening |
| Human attention | approval prompts | approval fatigue → rubber-stamping |

## 3. Trust boundaries

1. **LLM output → system**: every role output crosses into the deterministic
   layer via schema validation + re-validation. Nothing an LLM emits is an
   instruction; it is data (`CommanderDecision` is a proposal).
2. **Tool output → LLM**: already nonce-fenced and untrusted (verified
   MCP-audit mitigation); mission reports cite tool output as evidence refs,
   never as instructions.
3. **Repository content → roles**: repo files, issues, PR text are attack
   surfaces (AGENTS.md is always read as prompt content — known gap in
   SECURITY.md §12); tracker's read-only posture is the containment.
4. **Kit CLI ↔ adapter**: argv array (no shell), regex-validated ids,
   typed union only.
5. **Child execution ↔ parent**: verified `Delegator` isolation — own
   runId, budget, cancellation, permissions; narrow-only policy inheritance.

## 4. Adversaries and attack scenarios

| ID | Adversary / scenario | Path | Existing + new controls | Residual risk |
| --- | --- | --- | --- | --- |
| T1 | Prompt injection via repo content, issue text, or tool output aimed at a role | file/issue text → role LLM → role report/decision | read-only postures for tracker/predictor (nothing to execute); commander proposals re-validated; tool outputs untrusted by design; `AGENTS.md`-as-prompt-content remains a known repo-wide gap (SECURITY.md §12) | Injection can still **waste** budget (garbage reports consume tokens) — bounded by mission budget envelope |
| T2 | Compromised Commander (worst case: arbitrary decision text) | commander output → coordinator | `reValidateDecision`: profile membership, DAG validity, budget share, caps, approval-class routing, completion-evidence check (INV-4/5/6); `Delegator.review()` before every delegate | A valid-within-profile decision still executes — that is the design (bounded autonomy), monitored by telemetry |
| T3 | Evidence poisoning: fake observations or fabricated predictions with syntactically valid refs | role → artifact store | refs must **resolve** against real stores (P2 resolution service); collectors are deterministic and re-runnable; audit replay recomputes from raw stores | A compromised collector path could still mis-attribute — mitigated by collector determinism and audit replay (§6) |
| T4 | Runaway loop / budget bypass (cost DoS) | coordinator loop | hard budget envelope (wall clock, model/tool calls, tokens, children); `LoopDetector`; replan caps; failure budget on decision rejections (INV-1/2/3) | none within one mission; cross-mission DoS bounded by ops limits (OPS-RUNBOOK) |
| T5 | Argument injection into Kit CLI | adapter argv | typed union + id regex + no shell + deny-by-default allowlist (tested) | none known |
| T6 | Evidence-chain tampering (post-hoc rewrite) | artifact store, Kit journal | artifacts immutable (`wx`, self-hash — detects accidental edits, not tamper-proof, same caveat as evolution artifacts); Kit `journal --verify` is hash-chained; audit replay cross-checks stores | deliberate local tampering by a host-level attacker is out of scope (host compromise = game over, per SECURITY.md) |
| T7 | Approval fatigue: repeated approval requests to force a rubber-stamp | coordinator → human | approval requests carry full context + rollback statement; approval timeout fails closed; escalation quality is a pilot metric | social-engineering residual — monitored in P8 pilot review |
| T8 | Kit journal tamper reported mid-mission | journal-verify failure | mission aborts, human escalation, incident record | none (fail-closed) |
| T9 | Cross-mission interference (one mission corrupting another's state) | shared stores | stores are keyed by missionId; artifacts immutable; no shared mutable mission state exists | none by construction |
| T10 | Secret exfiltration via reports/artifacts | role output → artifact store | roles have no secret-reading tools (path-policy refuses secret reads — verified guard behavior); redaction boundary on persisted artifacts; report schema forbids raw content beyond bounded fields | none known beyond existing guard gaps (symlink race — narrowed, not closed) |
| T11 | `docker` tool abuse by a worker in a trusted workspace | worker execution | unchanged existing controls (ownership labels, flag allowlist, internal network, no bind mounts) — the coordination layer adds no new docker surface | unchanged (root-equivalent daemon access remains a documented residual) |
| T12 | Unattended/CI misuse of autonomy profiles | config / env | `controlled-autonomous` requires explicit opt-in; `supervised` is default; `autoApprove` remains off by default; headless approval-less sessions fail closed | none known |

## 5. What this layer deliberately does NOT defend

Inherited verbatim from SECURITY.md §12 and the Kit's README safety note:

- Malicious code in the workspace (run untrusted workloads on a disposable
  machine or VM; the multi-agent layer is not an OS sandbox).
- Prompt injection into the model itself (containment, not prevention).
- Docker Desktop differences (test:docker not yet run there).
- A formal security audit (this document is not one).

## 6. Audit and detection

- `nexum mission audit <missionId>` reconstructs any mission from events +
  artifacts with zero LLM calls; any divergence between the reconstruction
  and the stores is an integrity incident.
- Telemetry: `mission_active`, per-role token/model consumption,
  `mission_verified_completions`, `mission_false_success`, decision
  rejection counts, escalation counts.
- Weekly pilot review (P8) treats: any false success, any successful
  permission escalation, any budget breach as a **stop-the-line** event
  (pilot pauses; autonomy does not expand).
