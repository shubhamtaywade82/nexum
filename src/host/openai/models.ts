/** The one model Nexum offers: the whole agent, not a raw LLM. */
export const AGENT_MODEL_ID = "nexum-agent";

const CREATED = Math.floor(Date.now() / 1000);

export interface OpenAiModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export function agentModel(): OpenAiModel {
  return { id: AGENT_MODEL_ID, object: "model", created: CREATED, owned_by: "nexum" };
}

export function modelList(): { object: "list"; data: OpenAiModel[] } {
  return { object: "list", data: [agentModel()] };
}
