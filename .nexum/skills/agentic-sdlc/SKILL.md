---
name: agentic-sdlc
description: Disciplined Agentic Software Development Lifecycle (SDLC) methodology. Use when designing, planning, implementing features, fixing bugs with reproduction harnesses, validating DAG plans, or executing deterministic verification using the Agentic SDLC Kit.
---

# Agentic SDLC Kit Methodology

The Agentic SDLC Kit provides a disciplined, contract-driven engineering lifecycle for AI agents. It ensures that features, bug fixes, refactorings, and migrations transition through strict verification gates without skipping essential testing and architecture checks.

## 1. Core Engineering Workflow

When tasked with implementing a feature or fixing a complex issue, follow the 5-phase SDLC sequence:

```
┌───────────┐      ┌───────────────┐      ┌───────────────┐      ┌─────────┐      ┌────────────┐
│  Inspect  │ ───> │ Validate Spec │ ───> │ Validate Plan │ ───> │   TDD   │ ───> │   Verify   │
└───────────┘      └───────────────┘      └───────────────┘      └─────────┘      └────────────┘
```

1. **Inspect (`sdlc_inspect`)**:
   - Inspect the target repository to detect language stacks, frameworks, package managers, test tooling, entry points, and CI configuration.
   - Never assume tools or conventions; let the inspection result guide file placement and commands.

2. **Validate Specification (`sdlc_validate_spec`)**:
   - Verify that requirements define clear user stories, verifiable acceptance criteria, and non-functional requirements.
   - Check risk boundaries (e.g. database schema migrations, auth changes, breaking API contracts).

3. **Validate Plan DAG (`sdlc_validate_plan`)**:
   - Before executing code changes, ensure the implementation plan forms an **acyclic directed graph (DAG)**.
   - Verify that all step dependencies exist, tasks are split into vertical slices, and rollback paths are defined.

4. **TDD Cycles (Red $\to$ Green $\to$ Refactor)**:
   - For bugs: write a reproduction test first. Verify that it fails for the expected reason.
   - Implement the smallest surgical fix to make the test pass.
   - Refactor for cleanliness, readability, and adherence to clean code rules without altering observable behavior.

5. **Deterministic Verification (`sdlc_verify`)**:
   - Execute the configured verification pipeline (typecheck, lint, unit tests, build).
   - Ensure zero regressions before declaring the task complete.

---

## 2. Tool Reference

| Tool                     | Purpose                                                                                                                                                                      |
| :----------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`sdlc_inspect`**       | Discovers stacks (`react-typescript`, `node-typescript`, `rails`), package managers (`pnpm`, `npm`), test tools (`vitest`, `jest`, `rspec`), entry points, and CI pipelines. |
| **`sdlc_validate_spec`** | Checks specifications against schema, quality, and risk invariants.                                                                                                          |
| **`sdlc_validate_plan`** | Mathematically validates implementation plans for DAG acyclicity and dependency completeness.                                                                                |
| **`sdlc_verify`**        | Runs the project's deterministic verification suite (`tests`, `lint`, `typecheck`, `build`).                                                                                 |
| **`sdlc_doctor`**        | Checks the kit toolchain health, git state, and workspace profile status.                                                                                                    |

---

## 3. Bug-Fix Invariants

When fixing bugs with the SDLC kit:

1. **Never guess the fix**: Run `sdlc_inspect` to understand the runtime and test harness.
2. **Reproduce First**: Write an automated test case that reliably reproduces the reported failure.
3. **Verify Failure**: Confirm the reproduction fails with the exact reported error.
4. **Surgical Patch**: Make the minimal change required to pass.
5. **Verify Green**: Run `sdlc_verify` to guarantee no collateral damage.
