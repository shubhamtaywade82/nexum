/**
 * Product agents (review item 40) — consume Nexum Core, own product scope.
 *
 * Dependency direction (enforced by layering):
 *   ollama-sdk → Nexum Core → DevAgent / CryptoAgent
 *
 *   DevAgent     software engineering (filesystem/process/git/lsp packs)
 *   CryptoAgent  trading (trading pack + deterministic execution pipeline)
 *
 * MAC v1 role agents (ADR-0001) — inert, capability-scoped registrations:
 *   Tracker / Predictor / Commander coordinate missions; they own no
 *   runtime logic and mount no write surface (P1 registration; behavior
 *   lands in P3–P5 per docs/multi-agent/ROADMAP.md).
 */

export { DevAgent, DEVAGENT_DESCRIPTOR, type DevAgentOptions } from "./devagent/dev-agent.js";
export { CryptoAgent, cryptoAgentDescriptor, type CryptoAgentOptions } from "./cryptoagent/crypto-agent.js";

export { trackerDescriptor } from "./tracker/tracker-agent.js";
export { predictorDescriptor } from "./predictor/predictor-agent.js";
export { commanderDescriptor } from "./commander/commander-agent.js";
