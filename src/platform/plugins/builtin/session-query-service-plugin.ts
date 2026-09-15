/**
 * Session query service plugin.
 */

import { defineCapabilityToken } from "../../../core/capabilities/index.js";
import { SessionQueryService } from "../../../session-query/index.js";
import { definePlugin } from "../types.js";

/** Token for the shared SessionQueryService. */
export const SESSION_QUERY_SERVICE = defineCapabilityToken<SessionQueryService>("nexum:session-query:service");

export interface SessionQueryServicePluginOptions {
  /** Pass through to SessionQueryServiceOptions. */
  eventStore?: unknown;
  sessionStore?: unknown;
}

export function sessionQueryServicePlugin(opts: SessionQueryServicePluginOptions = {}) {
  return definePlugin({
    manifest: {
      id: "session-query-service",
      name: "Session Query Service",
      version: "1.0.0",
      description: "Read-only query layer over durable session data (event read/search/trace).",
      provides: ["session-query"],
      requires: [],
    },
    setup(ctx) {
      const service = new SessionQueryService({
        eventStore: opts.eventStore as never,
        sessionStore: opts.sessionStore as never,
      });
      ctx.provide(SESSION_QUERY_SERVICE.id, service);
      ctx.declareCapability("session-query");
      ctx.log.debug("session query service registered");
    },
  });
}
