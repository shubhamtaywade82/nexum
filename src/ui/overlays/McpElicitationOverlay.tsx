import React, { useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { spawn } from "node:child_process";
import type {
  McpElicitationFieldSchema,
  McpElicitationRequest,
  McpElicitationResponse,
} from "../../core/user-input.js";
import { validateMcpElicitationForm } from "../../core/user-input.js";
import { useTheme } from "../ui/hooks/use-theme.js";
import { OverlayFrame } from "./OverlayFrame.js";

type FieldKind = "string" | "number" | "integer" | "boolean" | "enum" | "multi-enum" | "unsupported";

function kindOf(schema: McpElicitationFieldSchema): FieldKind {
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "number") return "number";
  if (schema.type === "integer") return "integer";
  if (schema.type === "array") {
    const allowed = schema.items
      ? "enum" in schema.items
        ? schema.items.enum
        : "anyOf" in schema.items
          ? schema.items.anyOf.map((item) => item.const)
          : undefined
      : undefined;
    return allowed ? "multi-enum" : "unsupported";
  }
  if (schema.enum || schema.oneOf) return "enum";
  if (schema.type === "string") return "string";
  return "unsupported";
}

function valuesOf(schema: McpElicitationFieldSchema): string[] {
  if (schema.enum) return schema.enum;
  if (schema.oneOf) return schema.oneOf.map((item) => item.const);
  if (schema.type === "array" && schema.items) {
    return "anyOf" in schema.items ? schema.items.anyOf.map((item) => item.const) : schema.items.enum || [];
  }
  return [];
}

function labelsOf(schema: McpElicitationFieldSchema): string[] {
  return schema.oneOf ? schema.oneOf.map((item) => item.title) : valuesOf(schema);
}

function defaultOf(schema: McpElicitationFieldSchema): unknown {
  if (schema.default !== undefined) return schema.default;
  const kind = kindOf(schema);
  return kind === "boolean" ? false : kind === "multi-enum" ? [] : "";
}

async function openExternalUrl(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

    const [command, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : ["xdg-open", [url]];

    return await new Promise<boolean>((resolve) => {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    });
  } catch {
    return false;
  }
}

export interface McpElicitationOverlayProps {
  request: McpElicitationRequest;
  width: number;
  rows: number;
  onSubmit(response: McpElicitationResponse): void;
  onCancel(): void;
}

export function McpElicitationOverlay({
  request,
  width,
  rows,
  onSubmit,
  onCancel,
}: McpElicitationOverlayProps): React.JSX.Element {
  const theme = useTheme();
  const schema = request.requestedSchema;
  const fields = useMemo(() => Object.keys(schema?.properties || {}), [schema]);
  const [index, setIndex] = useState(0);
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const next: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(schema?.properties || {})) next[name] = defaultOf(field);
    return next;
  });
  const initialDraft = (() => {
    const current = fields[0] ? schema?.properties[fields[0]]?.default : undefined;
    return typeof current === "string" || typeof current === "number" ? String(current) : "";
  })();
  const [draft, setDraftState] = useState(initialDraft);
  // Keystrokes can arrive faster than React re-renders (fast typing, paste
  // followed by Enter): the ref holds the latest draft so commit() never
  // reads a stale closure.
  const draftRef = useRef(initialDraft);
  const setDraft = (update: string | ((value: string) => string)) => {
    draftRef.current = typeof update === "function" ? update(draftRef.current) : update;
    setDraftState(draftRef.current);
  };
  const [error, setError] = useState<string | null>(null);

  const name = fields[index];
  const field = name ? schema?.properties[name] : undefined;
  const kind = field ? kindOf(field) : "unsupported";
  const options = field ? valuesOf(field) : [];
  const labels = field ? labelsOf(field) : [];

  const commit = () => {
    if (!field || !name) return;

    const next = { ...values };
    if (kind === "string") {
      next[name] = draftRef.current;
    } else if (kind === "number" || kind === "integer") {
      const numeric = Number(draftRef.current);
      if (!Number.isFinite(numeric) || (kind === "integer" && !Number.isInteger(numeric))) {
        setError("Enter a valid " + kind + ".");
        return;
      }
      next[name] = numeric;
    }

    const problems = schema ? validateMcpElicitationForm(schema, next) : ["missing form schema"];
    const currentProblem = problems.find((problem) => problem.startsWith('"' + name + '"'));
    if (currentProblem) {
      setError(currentProblem);
      return;
    }

    setError(null);
    setValues(next);
    if (index < fields.length - 1) {
      setIndex((value) => value + 1);
      setDraft("");
    } else {
      const finalProblems = schema ? validateMcpElicitationForm(schema, next) : ["missing form schema"];
      if (finalProblems.length) {
        setError(finalProblems[0]);
        return;
      }
      onSubmit({
        id: request.id,
        action: "accept",
        content: next as Record<string, string | number | boolean | string[]>,
      });
    }
  };

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (request.mode === "url") {
      if (input === "d" || input === "D" || input === "n" || input === "N") {
        onSubmit({ id: request.id, action: "decline" });
        return;
      }
      if (key.return || input === "o" || input === "O") {
        void openExternalUrl(request.url || "").then((opened) => {
          if (opened) onSubmit({ id: request.id, action: "accept" });
          else setError("Could not open the external URL.");
        });
      }
      return;
    }

    if (!field || !name) return;

    if (kind === "boolean") {
      if (input === " " || input === "y" || input === "Y" || input === "n" || input === "N") {
        setValues((current) => ({
          ...current,
          [name]: input === "y" || input === "Y" ? true : input === "n" || input === "N" ? false : !current[name],
        }));
        setError(null);
      } else if (key.return) {
        commit();
      }
      return;
    }

    if (kind === "enum") {
      const current = String(values[name] ?? options[0] ?? "");
      if (key.leftArrow || key.upArrow || key.rightArrow || key.downArrow) {
        const delta = key.leftArrow || key.upArrow ? -1 : 1;
        const nextIndex = Math.max(0, Math.min(options.length - 1, options.indexOf(current) + delta));
        setValues((currentValues) => ({ ...currentValues, [name]: options[nextIndex] ?? current }));
        return;
      }
      if (/^[1-9]$/.test(input)) {
        const option = options[Number(input) - 1];
        if (option) setValues((currentValues) => ({ ...currentValues, [name]: option }));
        return;
      }
      if (key.return) commit();
      return;
    }

    if (kind === "multi-enum") {
      if (/^[1-9]$/.test(input)) {
        const option = options[Number(input) - 1];
        if (option) {
          setValues((currentValues) => {
            const selected = new Set(Array.isArray(currentValues[name]) ? (currentValues[name] as string[]) : []);
            if (selected.has(option)) selected.delete(option);
            else selected.add(option);
            return { ...currentValues, [name]: [...selected] };
          });
        }
        return;
      }
      if (key.return) commit();
      return;
    }

    if (key.backspace || key.delete) {
      setDraft((value) => value.slice(0, -1));
      return;
    }
    if (key.return || key.tab) {
      commit();
      return;
    }
    if (input && !key.ctrl && !key.meta) setDraft((value) => value + input);
  });

  if (request.mode === "url") {
    return (
      <OverlayFrame title="MCP Elicitation · External URL" width={width} rows={rows}>
        <Box flexDirection="column" marginY={1}>
          <Text bold color={theme.colors.info}>
            {request.message}
          </Text>
          <Text color={theme.colors.warning}>The MCP server requested an external browser flow.</Text>
          <Box marginY={1} borderStyle="round" borderColor={theme.colors.success} paddingX={1}>
            <Text color={theme.colors.success}>{request.url}</Text>
          </Box>
          <Text color={theme.colors.mutedForeground} dimColor>
            Enter / O = open and accept · D / N = decline · Esc = cancel
          </Text>
          {error ? <Text color={theme.colors.error}>Error: {error}</Text> : null}
        </Box>
      </OverlayFrame>
    );
  }

  if (!schema || fields.length === 0) {
    return (
      <OverlayFrame title="MCP Elicitation · Form" width={width} rows={rows}>
        <Box flexDirection="column" marginY={1}>
          <Text bold color={theme.colors.info}>
            {request.message}
          </Text>
          <Text color={theme.colors.error}>The server supplied an empty form schema.</Text>
          <Text color={theme.colors.mutedForeground} dimColor>
            Esc = cancel
          </Text>
        </Box>
      </OverlayFrame>
    );
  }

  return (
    <OverlayFrame title="MCP Elicitation · Form" width={width} rows={rows}>
      <Box flexDirection="column" marginY={1}>
        <Text bold color={theme.colors.info}>
          {request.message}
        </Text>
        <Text color={theme.colors.mutedForeground} dimColor>
          Form elicitation is for non-sensitive input. Never enter passwords, API keys, or other secrets here.
        </Text>
        <Box marginY={1} flexDirection="column">
          <Text color={theme.colors.warning}>
            Field {index + 1}/{fields.length}: {field?.title || name}
          </Text>
          {field?.description ? <Text color={theme.colors.mutedForeground}>{field.description}</Text> : null}
          {kind === "enum" ? (
            <Box flexDirection="column" marginTop={1}>
              {labels.map((label, optionIndex) => (
                <Text
                  key={optionIndex}
                  color={
                    String(values[name]) === options[optionIndex] ? theme.colors.success : theme.colors.mutedForeground
                  }
                >
                  {String(values[name]) === options[optionIndex] ? "▶ " : "  "}[{optionIndex + 1}] {label}
                </Text>
              ))}
            </Box>
          ) : kind === "multi-enum" ? (
            <Box flexDirection="column" marginTop={1}>
              {labels.map((label, optionIndex) => {
                const selected =
                  Array.isArray(values[name]) && (values[name] as string[]).includes(options[optionIndex]);
                return (
                  <Text key={optionIndex} color={selected ? theme.colors.success : theme.colors.mutedForeground}>
                    [{selected ? "x" : " "}] [{optionIndex + 1}] {label}
                  </Text>
                );
              })}
            </Box>
          ) : (
            <Box marginTop={1} borderStyle="round" borderColor={theme.colors.primary} paddingX={1}>
              <Text color={theme.colors.success}>› </Text>
              <Text>{kind === "boolean" ? String(values[name]) : draft}</Text>
            </Box>
          )}
        </Box>
        {error ? <Text color={theme.colors.error}>Error: {error}</Text> : null}
        <Text color={theme.colors.mutedForeground} dimColor>
          {kind === "enum"
            ? "↑/↓ or 1-N = choose · Enter = next/submit · Esc = cancel"
            : kind === "multi-enum"
              ? "1-N = toggle · Enter = next/submit · Esc = cancel"
              : kind === "boolean"
                ? "Space/Y/N = toggle · Enter = next/submit · Esc = cancel"
                : "Type value · Enter/Tab = next · Esc = cancel"}
        </Text>
      </Box>
    </OverlayFrame>
  );
}
