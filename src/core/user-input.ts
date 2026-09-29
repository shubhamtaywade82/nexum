/**
 * Shared user-input contracts for MCP elicitation.
 *
 * Agent clarification is an application-level UX feature. MCP elicitation is
 * a protocol-level server -> client request with explicit user actions.
 */
export type McpElicitationMode = "form" | "url";
export type McpElicitationAction = "accept" | "decline" | "cancel";
export type McpElicitationValue = string | number | boolean | string[];

export interface McpElicitationOneOf {
  const: string;
  title: string;
}

export interface McpElicitationFieldSchema {
  type: "string" | "number" | "integer" | "boolean" | "array";
  title?: string;
  description?: string;
  default?: McpElicitationValue;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  oneOf?: McpElicitationOneOf[];
  items?: { type: "string"; enum?: string[] } | { anyOf: McpElicitationOneOf[] };
  minItems?: number;
  maxItems?: number;
}
export interface McpElicitationFormSchema {
  type: "object";
  properties: Record<string, McpElicitationFieldSchema>;
  required?: string[];
}
export interface McpElicitationRequest {
  id: string;
  serverId: string;
  mode: McpElicitationMode;
  message: string;
  requestedSchema?: McpElicitationFormSchema;
  url?: string;
}
export interface McpElicitationResponse {
  id: string;
  action: McpElicitationAction;
  content?: Record<string, McpElicitationValue>;
}
export interface McpElicitationHandler {
  request(request: McpElicitationRequest): Promise<McpElicitationResponse>;
}

const MAX_FORM_FIELDS = 32;
const URL_SCHEMES = new Set(["http:", "https:"]);

export function validateMcpElicitationRequest(request: McpElicitationRequest): string[] {
  const problems: string[] = [];
  if (!request.id.trim()) problems.push("elicitation request id is required");
  if (!request.serverId.trim()) problems.push("elicitation server id is required");
  if (!request.message.trim()) problems.push("elicitation message is required");

  if (request.mode === "url") {
    if (!request.url) problems.push("url elicitation requires a URL");
    else {
      try {
        const parsed = new URL(request.url);
        if (!URL_SCHEMES.has(parsed.protocol))
          problems.push("url elicitation only permits http/https URLs (got " + parsed.protocol + ")");
      } catch {
        problems.push("url elicitation URL is invalid");
      }
    }
  } else {
    if (!request.requestedSchema || request.requestedSchema.type !== "object")
      problems.push("form elicitation requires an object schema");
    else if (Object.keys(request.requestedSchema.properties || {}).length > MAX_FORM_FIELDS)
      problems.push("form elicitation exceeds " + MAX_FORM_FIELDS + "-field limit");
  }
  return problems;
}

export function validateMcpElicitationForm(
  schema: McpElicitationFormSchema,
  content: Record<string, unknown>,
): string[] {
  const problems: string[] = [];
  const required = new Set(schema.required || []);
  for (const [name, field] of Object.entries(schema.properties || {})) {
    const value = content[name];
    const missing = value === undefined || value === null || (typeof value === "string" && value.length === 0);
    if (required.has(name) && missing) {
      problems.push('"' + name + '" is required');
      continue;
    }
    if (missing) continue;

    if (field.type === "string") {
      if (typeof value !== "string") problems.push('"' + name + '" must be a string');
      else {
        if (field.minLength !== undefined && value.length < field.minLength)
          problems.push('"' + name + '" must be at least ' + field.minLength + " characters");
        if (field.maxLength !== undefined && value.length > field.maxLength)
          problems.push('"' + name + '" must be at most ' + field.maxLength + " characters");
        if (field.enum && !field.enum.includes(value))
          problems.push('"' + name + '" must be one of: ' + field.enum.join(", "));
        if (field.oneOf && !field.oneOf.some((x) => x.const === value))
          problems.push('"' + name + '" must be one of the offered choices');
      }
    } else if (field.type === "number" || field.type === "integer") {
      if (typeof value !== "number" || !Number.isFinite(value)) problems.push('"' + name + '" must be a number');
      else {
        if (field.type === "integer" && !Number.isInteger(value)) problems.push('"' + name + '" must be an integer');
        if (field.minimum !== undefined && value < field.minimum)
          problems.push('"' + name + '" must be >= ' + field.minimum);
        if (field.maximum !== undefined && value > field.maximum)
          problems.push('"' + name + '" must be <= ' + field.maximum);
      }
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean") problems.push('"' + name + '" must be a boolean');
    } else if (field.type === "array") {
      if (!Array.isArray(value) || value.some((x) => typeof x !== "string"))
        problems.push('"' + name + '" must be an array of strings');
      else {
        const values = value as string[];
        if (field.minItems !== undefined && values.length < field.minItems)
          problems.push('"' + name + '" must contain at least ' + field.minItems + " item(s)");
        if (field.maxItems !== undefined && values.length > field.maxItems)
          problems.push('"' + name + '" must contain at most ' + field.maxItems + " item(s)");
        const allowed =
          field.items && "enum" in field.items
            ? field.items.enum
            : field.items && "anyOf" in field.items
              ? field.items.anyOf.map((x) => x.const)
              : undefined;
        if (allowed && values.some((x) => !allowed.includes(x)))
          problems.push('"' + name + '" contains an unsupported choice');
      }
    }
  }
  return problems;
}

export function normalizeMcpElicitationResponse(response: McpElicitationResponse): {
  action: McpElicitationAction;
  content?: Record<string, McpElicitationValue>;
} {
  if (!["accept", "decline", "cancel"].includes(response.action))
    throw new Error('unsupported MCP elicitation action "' + String(response.action) + '"');
  if (response.action !== "accept") return { action: response.action };
  return { action: response.action, ...(response.content ? { content: response.content } : {}) };
}
