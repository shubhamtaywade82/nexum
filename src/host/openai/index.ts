import type { IncomingMessage, ServerResponse } from "node:http";
import { writeJson } from "../http.js";
import { handleChatCompletion } from "./chat-completions.js";
import { writeOpenAiError } from "./errors.js";
import { AGENT_MODEL_ID, agentModel, modelList } from "./models.js";
import type { OpenAiContext } from "./temporary-session.js";

/** Routes `/v1/*`: Nexum's OpenAI-compatible surface. `segments` starts with "v1". */
export async function handleOpenAiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  ctx: OpenAiContext,
): Promise<void> {
  const method = req.method ?? "GET";
  const route = segments.slice(1).join("/");

  if (method === "GET" && route === "models") {
    writeJson(res, 200, modelList());
  } else if (method === "GET" && segments[1] === "models" && segments.length === 3) {
    if (segments[2] === AGENT_MODEL_ID) writeJson(res, 200, agentModel());
    else
      writeOpenAiError(res, 404, "not_found_error", `The model "${segments[2]}" does not exist`, {
        code: "model_not_found",
      });
  } else if (method === "POST" && route === "chat/completions") {
    await handleChatCompletion(req, res, ctx);
  } else {
    writeOpenAiError(res, 404, "not_found_error", `Unknown request URL: ${method} /${segments.join("/")}`);
  }
}
