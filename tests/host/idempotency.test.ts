import { IdempotencyStore, fingerprintBody } from "../../src/host/idempotency.js";

describe("IdempotencyStore", () => {
  const body = fingerprintBody({ goal: "sync records" });

  it("reserves a new key, then replays the completed response for the same body", () => {
    const store = new IdempotencyStore();
    expect(store.begin("POST /sessions", "k1", body)).toEqual({ kind: "reserved" });
    store.complete("POST /sessions", "k1", { status: 201, body: { id: "s1" } });

    expect(store.begin("POST /sessions", "k1", body)).toEqual({
      kind: "replay",
      response: { status: 201, body: { id: "s1" } },
    });
  });

  it("refuses a key reused with a different body instead of replaying the old response", () => {
    const store = new IdempotencyStore();
    store.begin("POST /sessions", "k1", body);
    store.complete("POST /sessions", "k1", { status: 201, body: { id: "s1" } });

    const other = fingerprintBody({ goal: "delete everything" });
    expect(store.begin("POST /sessions", "k1", other)).toEqual({ kind: "conflict" });
  });

  it("refuses a duplicate that arrives while the first request is still running", () => {
    const store = new IdempotencyStore();
    store.begin("POST /sessions/s1/runs", "k1", body);
    expect(store.begin("POST /sessions/s1/runs", "k1", body)).toEqual({ kind: "in_progress" });
  });

  it("releases a reservation after a failed attempt so the client can retry", () => {
    const store = new IdempotencyStore();
    store.begin("POST /sessions", "k1", body);
    store.release("POST /sessions", "k1");
    expect(store.begin("POST /sessions", "k1", body)).toEqual({ kind: "reserved" });
  });

  it("never releases a completed response through release()", () => {
    const store = new IdempotencyStore();
    store.begin("POST /sessions", "k1", body);
    store.complete("POST /sessions", "k1", { status: 201, body: { id: "s1" } });
    store.release("POST /sessions", "k1");
    expect(store.begin("POST /sessions", "k1", body).kind).toBe("replay");
  });

  it("scopes a key to its route, so one key cannot replay another endpoint's response", () => {
    const store = new IdempotencyStore();
    store.begin("POST /sessions/a/runs", "k1", body);
    store.complete("POST /sessions/a/runs", "k1", { status: 201, body: { run: "a" } });

    expect(store.begin("POST /sessions/b/runs", "k1", body)).toEqual({ kind: "reserved" });
  });

  it("expires a completed response after the TTL", () => {
    let now = 1_000;
    const store = new IdempotencyStore({ ttlMs: 500, now: () => now });
    store.begin("POST /sessions", "k1", body);
    store.complete("POST /sessions", "k1", { status: 201, body: { id: "s1" } });

    now += 499;
    expect(store.begin("POST /sessions", "k1", body).kind).toBe("replay");

    now += 2;
    expect(store.begin("POST /sessions", "k1", body)).toEqual({ kind: "reserved" });
  });

  it("evicts the oldest completed responses beyond the size cap", () => {
    const store = new IdempotencyStore({ maxEntries: 2 });
    for (const key of ["k1", "k2", "k3"]) {
      store.begin("POST /sessions", key, body);
      store.complete("POST /sessions", key, { status: 201, body: { key } });
    }

    expect(store.size).toBe(2);
    expect(store.begin("POST /sessions", "k1", body)).toEqual({ kind: "reserved" });
    expect(store.begin("POST /sessions", "k3", body).kind).toBe("replay");
  });

  it("never evicts a request that is still running, even over the cap", () => {
    const store = new IdempotencyStore({ maxEntries: 1 });
    store.begin("POST /sessions", "running", body);
    store.begin("POST /sessions", "other", body);
    store.complete("POST /sessions", "other", { status: 201, body: {} });

    expect(store.begin("POST /sessions", "running", body)).toEqual({ kind: "in_progress" });
  });

  it("fingerprints equal JSON to the same digest and different JSON to a different one", () => {
    expect(fingerprintBody({ a: 1 })).toBe(fingerprintBody({ a: 1 }));
    expect(fingerprintBody({ a: 1 })).not.toBe(fingerprintBody({ a: 2 }));
    expect(fingerprintBody(undefined)).not.toBe(fingerprintBody({}));
  });
});
