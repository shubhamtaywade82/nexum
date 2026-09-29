import { describe, it, expect } from "@jest/globals";
import { createHmac } from "node:crypto";
import { WebhookService, type WebhookEvent } from "../../src/webhooks/index.js";

const SECRET = "whsec_test";

function signed(rawBody: string, ts = Math.floor(Date.now() / 1000)): Record<string, string> {
  const sig = createHmac("sha256", SECRET).update(`${ts}.${rawBody}`).digest("hex");
  return { "X-Webhook-Signature": sig, "X-Webhook-Timestamp": String(ts) };
}

function service(): { svc: WebhookService; delivered: WebhookEvent[] } {
  const svc = new WebhookService({ inMemory: true });
  svc.registerEndpoint({ id: "ep", path: "/webhooks/ep", secret: SECRET, active: true });
  const delivered: WebhookEvent[] = [];
  svc.addRule({ id: "r", handle: (e) => void delivered.push(e) });
  return { svc, delivered };
}

describe("WebhookService verification", () => {
  it("delivers a correctly signed, fresh request", async () => {
    const { svc, delivered } = service();
    const rawBody = JSON.stringify({ side: "buy", qty: 1 });
    const event = await svc.receive({ endpointId: "ep", type: "order", rawBody, headers: signed(rawBody) });
    expect(event.verified).toBe(true);
    expect(event.delivered).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].payload).toEqual({ side: "buy", qty: 1 });
  });

  it("rejects an exact replay inside the freshness window", async () => {
    const { svc, delivered } = service();
    const rawBody = JSON.stringify({ action: "deploy" });
    const headers = signed(rawBody);
    const first = await svc.receive({ endpointId: "ep", type: "deploy", rawBody, headers });
    const replay = await svc.receive({ endpointId: "ep", type: "deploy", rawBody, headers });
    expect(first.verified).toBe(true);
    expect(replay.verified).toBe(false);
    expect(replay.verificationError).toMatch(/replayed request/);
    expect(delivered).toHaveLength(1);
  });

  it("does not let a replay slip through by changing the unsigned type", async () => {
    const { svc, delivered } = service();
    const rawBody = JSON.stringify({ a: 1 });
    const headers = signed(rawBody);
    await svc.receive({ endpointId: "ep", type: "benign", rawBody, headers });
    const replay = await svc.receive({ endpointId: "ep", type: "trade.execute", rawBody, headers });
    expect(replay.verified).toBe(false);
    expect(delivered).toHaveLength(1);
  });

  it("delivers the signed body, never a caller-supplied payload", async () => {
    const { svc, delivered } = service();
    const rawBody = JSON.stringify({ qty: 1 });
    await svc.receive({
      endpointId: "ep",
      type: "order",
      rawBody,
      payload: { qty: 1_000_000 },
      headers: signed(rawBody),
    });
    expect(delivered[0].payload).toEqual({ qty: 1 });
  });

  it("keeps a non-JSON signed body as a string", async () => {
    const { svc, delivered } = service();
    const rawBody = "plain text event";
    await svc.receive({ endpointId: "ep", type: "t", rawBody, headers: signed(rawBody) });
    expect(delivered[0].payload).toBe("plain text event");
  });

  it("rejects bad signatures and stale timestamps without consuming the replay slot", async () => {
    const { svc, delivered } = service();
    const rawBody = JSON.stringify({ a: 1 });
    const good = signed(rawBody);
    const tampered = await svc.receive({
      endpointId: "ep",
      type: "t",
      rawBody: JSON.stringify({ a: 2 }),
      headers: good,
    });
    expect(tampered.verificationError).toBe("signature mismatch");

    const stale = await svc.receive({
      endpointId: "ep",
      type: "t",
      rawBody,
      headers: signed(rawBody, Math.floor(Date.now() / 1000) - 3600),
    });
    expect(stale.verificationError).toMatch(/timestamp too old/);

    const ok = await svc.receive({ endpointId: "ep", type: "t", rawBody, headers: good });
    expect(ok.verified).toBe(true);
    expect(delivered).toHaveLength(1);
  });

  it("tracks replays per endpoint", async () => {
    const svc = new WebhookService({ inMemory: true });
    svc.registerEndpoint({ id: "a", path: "/a", secret: SECRET, active: true });
    svc.registerEndpoint({ id: "b", path: "/b", secret: SECRET, active: true });
    const rawBody = "{}";
    const headers = signed(rawBody);
    expect((await svc.receive({ endpointId: "a", type: "t", rawBody, headers })).verified).toBe(true);
    expect((await svc.receive({ endpointId: "b", type: "t", rawBody, headers })).verified).toBe(true);
    expect((await svc.receive({ endpointId: "a", type: "t", rawBody, headers })).verified).toBe(false);
  });
});
