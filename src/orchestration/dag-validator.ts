/**
 * DAG Validator and Sanitizer for Plan Steps.
 *
 * LLM-generated plans frequently suffer from structural DAG defects:
 * self-dependencies, dangling step IDs, or dependency cycles.
 * This module validates DAG invariants and sanitizes raw plans before
 * handing them to the Orchestrator, preventing mid-flight crashes.
 */

import type { PlanStep } from "../core/plan/plan-contracts.js";

export interface DagValidationResult {
  valid: boolean;
  errors: string[];
  executionOrder: string[];
  roots: string[];
  leaves: string[];
}

function findTopologicalOrder(
  steps: PlanStep[],
  stepMap: Map<string, PlanStep>,
): { cycle: string[] | null; order: string[] } {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];
  let detectedCycle: string[] | null = null;

  function dfs(id: string, path: string[]): boolean {
    if (visiting.has(id)) {
      detectedCycle = [...path, id];
      return false;
    }
    if (visited.has(id)) return true;

    visiting.add(id);
    const step = stepMap.get(id);
    if (step) {
      for (const dep of step.dependencies) {
        if (stepMap.has(dep) && !dfs(dep, [...path, id])) return false;
      }
    }
    visiting.delete(id);
    visited.add(id);
    order.push(id);
    return true;
  }

  for (const step of steps) {
    if (!visited.has(step.id) && !dfs(step.id, [])) break;
  }

  return { cycle: detectedCycle, order };
}

export function validatePlanDag(steps: PlanStep[]): DagValidationResult {
  const errors: string[] = [];
  const stepMap = new Map<string, PlanStep>();

  for (const step of steps) {
    if (stepMap.has(step.id)) {
      errors.push(`duplicate step id: "${step.id}"`);
    }
    stepMap.set(step.id, step);
  }

  for (const step of steps) {
    for (const depId of step.dependencies) {
      if (depId === step.id) {
        errors.push(`step "${step.id}" depends on itself`);
      } else if (!stepMap.has(depId)) {
        errors.push(`step "${step.id}" depends on unknown step "${depId}"`);
      }
    }
  }

  const { cycle, order } = findTopologicalOrder(steps, stepMap);
  if (cycle) {
    errors.push(`dependency cycle detected: ${cycle.join(" -> ")}`);
  }

  const dependents = new Set(steps.flatMap((s) => s.dependencies));
  const roots = steps.filter((s) => s.dependencies.length === 0).map((s) => s.id);
  const leaves = steps.filter((s) => !dependents.has(s.id)).map((s) => s.id);

  return {
    valid: errors.length === 0,
    errors,
    executionOrder: cycle ? [] : order,
    roots,
    leaves,
  };
}

export function sanitizePlanDag(steps: PlanStep[]): PlanStep[] {
  const knownIds = new Set(steps.map((s) => s.id));

  // Prune self-references, unknown references, and duplicates
  const cleaned: PlanStep[] = steps.map((step) => {
    const validDeps = step.dependencies.filter((dep) => dep !== step.id && knownIds.has(dep));
    return {
      ...step,
      dependencies: Array.from(new Set(validDeps)),
    };
  });

  const validation = validatePlanDag(cleaned);
  if (validation.valid) return cleaned;

  // Fallback: Linearize remaining steps to preserve execution viability on cycles
  return cleaned.map((step, idx) => ({
    ...step,
    dependencies: idx === 0 ? [] : [cleaned[idx - 1].id],
  }));
}
