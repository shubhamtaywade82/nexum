import {
  isValidRunTransition,
  CreateRunRequestSchema,
  ResolveInteractionRequestSchema,
  PROTOCOL_VERSION,
  ErrorCodes,
} from "../../src/protocol/types.js";

describe("Protocol v1", () => {
  describe("PROTOCOL_VERSION", () => {
    it("is 1.0.0", () => {
      expect(PROTOCOL_VERSION).toBe("1.0.0");
    });
  });

  describe("isValidRunTransition", () => {
    it("allows queued -> running", () => {
      expect(isValidRunTransition("queued", "running")).toBe(true);
    });

    it("allows queued -> cancelled", () => {
      expect(isValidRunTransition("queued", "cancelled")).toBe(true);
    });

    it("allows queued -> interrupted", () => {
      expect(isValidRunTransition("queued", "interrupted")).toBe(true);
    });

    it("allows running -> completed", () => {
      expect(isValidRunTransition("running", "completed")).toBe(true);
    });

    it("allows running -> failed", () => {
      expect(isValidRunTransition("running", "failed")).toBe(true);
    });

    it("allows running -> cancelled", () => {
      expect(isValidRunTransition("running", "cancelled")).toBe(true);
    });

    it("allows running -> interrupted", () => {
      expect(isValidRunTransition("running", "interrupted")).toBe(true);
    });

    it("rejects terminal state transitions", () => {
      expect(isValidRunTransition("completed", "running")).toBe(false);
      expect(isValidRunTransition("failed", "running")).toBe(false);
      expect(isValidRunTransition("cancelled", "running")).toBe(false);
      expect(isValidRunTransition("interrupted", "running")).toBe(false);
    });

    it("rejects queued -> completed directly", () => {
      expect(isValidRunTransition("queued", "completed")).toBe(false);
    });
  });

  describe("CreateRunRequestSchema", () => {
    it("accepts valid goal", () => {
      const res = CreateRunRequestSchema.safeParse({ goal: "Build feature" });
      expect(res.success).toBe(true);
    });

    it("rejects empty goal", () => {
      const res = CreateRunRequestSchema.safeParse({ goal: "" });
      expect(res.success).toBe(false);
    });

    it("rejects missing goal", () => {
      const res = CreateRunRequestSchema.safeParse({});
      expect(res.success).toBe(false);
    });
  });

  describe("ResolveInteractionRequestSchema", () => {
    it("accepts approval response", () => {
      const res = ResolveInteractionRequestSchema.safeParse({ approved: true, reason: "LGTM" });
      expect(res.success).toBe(true);
    });

    it("accepts clarification response", () => {
      const res = ResolveInteractionRequestSchema.safeParse({ selectedId: "opt-1" });
      expect(res.success).toBe(true);
    });

    it("accepts elicitation response", () => {
      const res = ResolveInteractionRequestSchema.safeParse({ response: "api-key-123" });
      expect(res.success).toBe(true);
    });
  });

  describe("ErrorCodes", () => {
    it("defines standard codes", () => {
      expect(ErrorCodes.NOT_FOUND).toBe("not_found");
      expect(ErrorCodes.SESSION_BUSY).toBe("session_busy");
      expect(ErrorCodes.UNAUTHORIZED).toBe("unauthorized");
      expect(ErrorCodes.SERVER_NOT_READY).toBe("server_not_ready");
      expect(ErrorCodes.INTERNAL_ERROR).toBe("internal_error");
    });
  });
});
