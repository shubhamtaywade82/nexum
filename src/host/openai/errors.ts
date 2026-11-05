import type { ServerResponse } from "node:http";
import { writeJson } from "../http.js";

/** The error types OpenAI clients know how to branch on. */
export type OpenAiErrorType = "invalid_request_error" | "authentication_error" | "not_found_error" | "server_error";

/** Writes an error in OpenAI's envelope: `{ error: { message, type, param, code } }`. */
export function writeOpenAiError(
  res: ServerResponse,
  status: number,
  type: OpenAiErrorType,
  message: string,
  extra: { code?: string; param?: string } = {},
): void {
  writeJson(res, status, { error: { message, type, param: extra.param ?? null, code: extra.code ?? null } });
}

export const BUSY_MESSAGE = "this conversation already has a response in progress";

/** 409 for a second request on a conversation whose previous answer is still being produced. */
export function writeConversationBusy(res: ServerResponse): void {
  writeOpenAiError(res, 409, "invalid_request_error", BUSY_MESSAGE, { code: "conversation_busy" });
}
