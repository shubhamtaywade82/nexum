import { OutcomeUnknownError, type ChatMessage, type ChatOptions, type ChatResponse } from "../adapters/provider.js";
import type { Capability } from "../catalog.js";
import type { ChatPort } from "./inference-dispatcher.js";

/**
 * Capability routing with a fallback to a fixed port. The fallback is a second send of the same request, so it is
 * allowed only when the first attempt cannot have run. A failure from before dispatch (no candidate, a refused
 * connection, a rate limit) may fall back. A paid request that may have run (OutcomeUnknownError) must not: the
 * fallback would bill the same request again.
 */
export async function routeWithFallbackOn(
  route: (capability: Capability, messages: ChatMessage[], opts?: ChatOptions) => Promise<ChatResponse>,
  fallback: ChatPort,
  capability: Capability,
  messages: ChatMessage[],
  opts?: ChatOptions,
): Promise<ChatResponse> {
  try {
    return await route(capability, messages, opts);
  } catch (e) {
    if (e instanceof OutcomeUnknownError) throw e;
    return fallback.chat(messages, opts);
  }
}
