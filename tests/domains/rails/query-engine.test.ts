import { KnowledgeGraph } from "../../../src/domains/rails/graph/graph.js";
import { QueryEngine } from "../../../src/domains/rails/query-engine.js";
import {
  ControllerEntity,
  ModelEntity,
  RouteEntity,
  SpecEntity,
  ViewEntity,
} from "../../../src/domains/rails/types.js";

function buildGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph();
  const user: ModelEntity = {
    id: "model:User",
    type: "model",
    name: "User",
    file: "app/models/user.rb",
    line: 1,
    table: "users",
    associations: [{ kind: "has_many", name: "orders", className: "Order", line: 2 }],
    validations: [],
    callbacks: [{ kind: "before_save", handler: "normalize_email", line: 3 }],
    scopes: [],
    concerns: [],
  };
  const controller: ControllerEntity = {
    id: "controller:UsersController",
    type: "controller",
    name: "UsersController",
    file: "app/controllers/users_controller.rb",
    line: 1,
    actions: [{ name: "show", line: 2 }],
    beforeActions: [],
    rescueHandlers: [],
    concerns: [],
  };
  const route: RouteEntity = {
    id: "route:GET /users/:id",
    type: "route",
    name: "GET /users/:id",
    file: "config/routes.rb",
    line: 2,
    verb: "GET",
    path: "/users/:id",
    controller: "users",
    action: "show",
  };
  const spec: SpecEntity = {
    id: "spec:spec/models/user_spec.rb",
    type: "spec",
    name: "spec/models/user_spec.rb",
    file: "spec/models/user_spec.rb",
    line: 1,
    subjectName: "User",
    specType: "model",
    exampleCount: 2,
  };
  graph.addEntity(user);
  graph.addEntity(controller);
  graph.addEntity(route);
  graph.addEntity(spec);
  graph.addEdge({ from: route.id, to: controller.id, type: "routes_to" });
  graph.addEdge({ from: user.id, to: spec.id, type: "tested_by" });
  return graph;
}

describe("QueryEngine", () => {
  const query = new QueryEngine(buildGraph());

  it("finds models case-insensitively", () => {
    expect(query.findModel("user")?.id).toBe("model:User");
    expect(query.findModel("Missing")).toBeUndefined();
  });

  it("finds controllers with or without the Controller suffix", () => {
    expect(query.findController("UsersController")?.id).toBe("controller:UsersController");
    expect(query.findController("users")?.id).toBe("controller:UsersController");
  });

  it("matches routes with :param segments", () => {
    expect(query.findRoute("/users/42")?.id).toBe("route:GET /users/:id");
    expect(query.findRoute("/users/:id", "get")?.id).toBe("route:GET /users/:id");
    expect(query.findRoute("/users/42/extra")).toBeUndefined();
  });

  it("returns the views a controller renders, from the edge the view scanner records", () => {
    const graph = buildGraph();
    const show: ViewEntity = {
      id: "view:users/show",
      type: "view",
      name: "users/show",
      file: "app/views/users/show.html.erb",
      line: 1,
      viewFormat: "erb",
      format: "html",
      controller: "Users",
      action: "show",
      referencedPartials: [],
    };
    graph.addEntity(show);
    // Exactly what the indexer produces for a view: from the view to its controller.
    graph.addEdge({ from: show.id, to: "controller:UsersController", type: "renders_view" });

    const engine = new QueryEngine(graph);
    expect(engine.viewsFor("UsersController").map((v) => v.id)).toEqual(["view:users/show"]);
    expect(engine.viewsFor("Missing")).toEqual([]);
  });

  it("returns routes reaching a controller", () => {
    expect(query.routesFor("users").map((r) => r.path)).toEqual(["/users/:id"]);
  });

  it("returns associations and callbacks", () => {
    expect(query.findAssociations("User")[0]).toMatchObject({ name: "orders", className: "Order" });
    expect(query.findCallbacks("User")[0]).toMatchObject({ handler: "normalize_email" });
    expect(query.findAssociations("Nope")).toEqual([]);
  });

  it("finds specs via tested_by edges and subject-name fallback", () => {
    expect(query.findSpecs("User").map((s) => s.file)).toEqual(["spec/models/user_spec.rb"]);
  });

  it("traces dependencies and dependents", () => {
    const deps = query.traceDependency("GET /users/:id");
    expect(deps?.nodes.map((n) => n.entity.id)).toContain("controller:UsersController");

    const dependents = query.traceDependency("UsersController", { direction: "dependents" });
    expect(dependents?.nodes.map((n) => n.entity.id)).toContain("route:GET /users/:id");
  });

  it("searches by substring", () => {
    expect(query.search("user").length).toBeGreaterThanOrEqual(3);
  });
});
