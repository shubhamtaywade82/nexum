/**
 * TaskRegistry — in-memory index of loaded tasks. Read-only after load.
 *
 * Architecture: docs/evolution/architecture.md
 */

import { TaskCategory, TaskDefinition, TaskPriority } from "./types.js";

export class TaskRegistry {
  private readonly byId = new Map<string, TaskDefinition>();
  private readonly byCategory = new Map<TaskCategory, TaskDefinition[]>();
  private readonly byPriority = new Map<TaskPriority, TaskDefinition[]>();
  private readonly dependents = new Map<string, string[]>();

  constructor(tasks: TaskDefinition[]) {
    for (const t of tasks) {
      this.byId.set(t.id, t);
      push(this.byCategory, t.category, t);
      push(this.byPriority, t.priority, t);
      for (const dep of t.dependsOn) {
        push(this.dependents, dep, t.id);
      }
    }
  }

  /** Number of registered tasks. */
  size(): number {
    return this.byId.size;
  }

  /** All registered tasks, in catalogue order. */
  all(): TaskDefinition[] {
    return [...this.byId.values()];
  }

  /** Returns the task with the given id, or undefined. */
  get(id: string): TaskDefinition | undefined {
    return this.byId.get(id);
  }

  /** Returns true if a task with the given id exists. */
  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Tasks in a category, in catalogue order. */
  byCat(category: TaskCategory): TaskDefinition[] {
    return [...(this.byCategory.get(category) ?? [])];
  }

  /** Tasks in a priority bucket, in catalogue order. */
  byPri(priority: TaskPriority): TaskDefinition[] {
    return [...(this.byPriority.get(priority) ?? [])];
  }

  /**
   * Number of other tasks that depend on this one. Used by the prioritizer as
   * the "dependency importance" factor.
   */
  dependentCount(id: string): number {
    return this.dependents.get(id)?.length ?? 0;
  }

  /** Returns the set of task ids this task directly depends on. */
  dependenciesOf(id: string): string[] {
    const t = this.byId.get(id);
    return t ? [...t.dependsOn] : [];
  }

  /**
   * Topological order over depends_on. Tasks with no dependencies come first.
   * If the graph has a cycle, an error is thrown (the catalogue must be a DAG).
   */
  topologicalOrder(): TaskDefinition[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const out: TaskDefinition[] = [];

    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`Cycle detected in task catalogue at ${id}`);
      }
      visiting.add(id);
      const t = this.byId.get(id);
      if (t) {
        for (const dep of t.dependsOn) visit(dep);
        out.push(t);
      }
      visiting.delete(id);
      visited.add(id);
    };

    for (const id of this.byId.keys()) visit(id);
    return out;
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}
