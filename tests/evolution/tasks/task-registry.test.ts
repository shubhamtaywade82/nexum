import { TaskRegistry } from "../../../src/evolution/tasks/task-registry.js";
import { loadCatalog } from "../../../src/evolution/tasks/task-loader.js";
import { TaskDefinition } from "../../../src/evolution/tasks/types.js";

function makeTask(id: string, deps: string[] = [], category: TaskDefinition["category"] = "learning"): TaskDefinition {
  return {
    id,
    title: `Task ${id}`,
    category,
    priority: "P0",
    schemaVersion: 1,
    objective: "test",
    execution: { mode: "diagnose", autonomous: true, allow_code_changes: false },
    inputs: [],
    investigation: ["step"],
    acceptance: ["criterion"],
    report: { required: ["task_identification"] },
    scoring: { impact: 0.5, potential: 0.5, feasibility: 0.5 },
    dependsOn: deps,
  };
}

describe("TaskRegistry", () => {
  test("indexes by id, category, and priority", () => {
    const r = new TaskRegistry([
      makeTask("EVO-001", [], "learning"),
      makeTask("EVO-002", [], "learning"),
      makeTask("EVO-011", [], "evolution_safety"),
    ]);
    expect(r.size()).toBe(3);
    expect(r.get("EVO-001")?.title).toBe("Task EVO-001");
    expect(r.has("EVO-999")).toBe(false);
    expect(r.byCat("learning").map((t) => t.id)).toEqual(["EVO-001", "EVO-002"]);
    expect(r.byCat("evolution_safety").map((t) => t.id)).toEqual(["EVO-011"]);
    expect(r.byPri("P0").length).toBe(3);
  });

  test("tracks dependents", () => {
    const r = new TaskRegistry([
      makeTask("EVO-001"),
      makeTask("EVO-002", ["EVO-001"]),
      makeTask("EVO-003", ["EVO-001"]),
      makeTask("EVO-004", ["EVO-002"]),
    ]);
    expect(r.dependentCount("EVO-001")).toBe(2);
    expect(r.dependentCount("EVO-002")).toBe(1);
    expect(r.dependentCount("EVO-003")).toBe(0);
    expect(r.dependenciesOf("EVO-004")).toEqual(["EVO-002"]);
  });

  test("topologicalOrder respects dependencies", () => {
    const r = new TaskRegistry([
      makeTask("EVO-003", ["EVO-002", "EVO-001"]),
      makeTask("EVO-002", ["EVO-001"]),
      makeTask("EVO-001"),
    ]);
    const order = r.topologicalOrder().map((t) => t.id);
    const i1 = order.indexOf("EVO-001");
    const i2 = order.indexOf("EVO-002");
    const i3 = order.indexOf("EVO-003");
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
  });

  test("topologicalOrder throws on cycle", () => {
    const r = new TaskRegistry([makeTask("EVO-001", ["EVO-002"]), makeTask("EVO-002", ["EVO-001"])]);
    expect(() => r.topologicalOrder()).toThrow(/Cycle/);
  });

  test("topologicalOrder on the real catalogue is a no-throw (DAG)", () => {
    const result = loadCatalog();
    const r = new TaskRegistry(result.catalog.tasks);
    expect(() => r.topologicalOrder()).not.toThrow();
    expect(r.topologicalOrder().length).toBe(50);
  });
});
