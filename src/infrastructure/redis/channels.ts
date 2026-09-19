/**
 * Redis channel naming (docs/plan §8) — kept centralized so the Nexum
 * Host's publisher and a future CLI/attach subscriber never drift apart
 * on the naming scheme.
 */
export function runChannel(runId: string): string {
  return `nexum:run:${runId}`;
}

export function sessionChannel(sessionId: string): string {
  return `nexum:session:${sessionId}`;
}
