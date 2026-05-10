import type {
  HermesSessionMessage,
  HermesHistoryToolCall,
  HermesStreamToolEvent,
} from "../../types/hermes";
import { stringValue, titleCase } from "../../shared/strings";

export function streamToolEventFromHistory(message: HermesSessionMessage): HermesStreamToolEvent {
  const parsed = parseJsonObject(message.content.trim());
  const toolName = historyToolName(message, parsed);
  const status = historyToolStatus(parsed);

  return {
    id: message.id,
    callId: message.toolCallId || message.id,
    toolName,
    label: toolLabel(toolName, parsed, { terminalPrefix: true }),
    status,
    output: message.content,
  };
}

export function streamToolEventFromHistoryCall(
  message: HermesSessionMessage,
  toolCall: HermesHistoryToolCall,
  index: number,
): HermesStreamToolEvent {
  const functionCall = toolCall.function || {};
  const toolName = stringValue(functionCall.name) || stringValue(toolCall.name) || "tool";
  const argumentsText = stringValue(functionCall.arguments) || stringValue(toolCall.arguments);
  const callId = stringValue(toolCall.call_id) || stringValue(toolCall.id) || `${message.id}-call-${index}`;

  return {
    id: callId,
    callId,
    toolName,
    label: toolLabel(toolName, parseJsonObject(argumentsText.trim()), { terminalPrefix: true }),
    status: "running",
    arguments: argumentsText || undefined,
  };
}

export function mergeStreamToolEvent(
  current: HermesStreamToolEvent[],
  next: HermesStreamToolEvent,
): HermesStreamToolEvent[] {
  const key = next.callId || next.id;
  const index = current.findIndex((event) => (event.callId || event.id) === key);
  if (index === -1) return [...current, next];
  return current.map((event, itemIndex) =>
    itemIndex === index
      ? {
          ...event,
          ...next,
          id: event.id || next.id,
          toolName: next.toolName === "tool" ? event.toolName : next.toolName,
          label: next.output && !next.arguments ? event.label : next.label || event.label,
          arguments: next.arguments || event.arguments,
          output: next.output || event.output,
        }
      : event,
  );
}

export function streamToolEventFromLegacyContent(content: string): HermesStreamToolEvent {
  const parsed = parseJsonObject(content.trim());
  const toolName = legacyToolName(parsed);
  return {
    id: `legacy-${content.slice(0, 40)}`,
    toolName,
    label: toolLabel(toolName, parsed, { terminalPrefix: false }),
    status: historyToolStatus(parsed),
    output: content,
  };
}

export function toolStatusLabel(status: HermesStreamToolEvent["status"]) {
  if (status === "completed") return "Done";
  if (status === "error") return "Error";
  return "Running";
}

export function toolEventDetail(event: HermesStreamToolEvent) {
  const sections = [];
  if (event.arguments) sections.push(`input\n${prettyToolText(event.arguments)}`);
  if (event.output) sections.push(`output\n${prettyToolText(event.output)}`);
  return sections.join("\n\n");
}

function prettyToolText(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

function historyToolName(message: HermesSessionMessage, data: Record<string, unknown> | null) {
  if (message.toolName) return message.toolName;
  return legacyToolName(data);
}

function legacyToolName(data: Record<string, unknown> | null) {
  if (!data) return "tool";
  if (isSkillViewPayload(data)) return "skill_view";
  if (stringValue(data.snapshot) || stringValue(data.url) || typeof data.element_count === "number") return "browser";
  if (
    stringValue(data.output) ||
    typeof data.exit_code === "number" ||
    typeof data.duration_seconds === "number" ||
    typeof data.tool_calls_made === "number"
  ) {
    return "terminal";
  }
  return stringValue(data.name) || "tool";
}

function toolLabel(
  toolName: string,
  data: Record<string, unknown> | null,
  options: { terminalPrefix: boolean },
) {
  if (toolName === "skill_view") return skillDisplayName(data) || "skill";
  if (toolName === "terminal") {
    const command = stringValue(data?.command);
    return options.terminalPrefix && command ? `terminal: ${command}` : "terminal";
  }
  if (toolName === "browser") {
    const title = stringValue(data?.title);
    const url = stringValue(data?.url);
    return title && !/just a moment/i.test(title) ? `browser: ${title}` : url ? `browser: ${url}` : "browser";
  }
  return titleCase(toolName);
}

function historyToolStatus(data: Record<string, unknown> | null): HermesStreamToolEvent["status"] {
  if (!data) return "completed";
  const status = stringValue(data.status).toLowerCase();
  const error = data.error;
  const exitCode = typeof data.exit_code === "number" ? data.exit_code : null;
  if (
    status.includes("error") ||
    status.includes("fail") ||
    data.success === false ||
    (exitCode !== null && exitCode !== 0) ||
    (error !== null && error !== undefined && String(error).trim())
  ) {
    return "error";
  }
  return "completed";
}

function isSkillViewPayload(data: Record<string, unknown>) {
  return (
    data.success === true &&
    typeof data.name === "string" &&
    (typeof data.content === "string" || typeof data.file === "string" || typeof data.skill_dir === "string")
  );
}

function skillDisplayName(data: Record<string, unknown> | null) {
  const name = stringValue(data?.name);
  if (name) return name;
  const path = stringValue(data?.path);
  if (path) return parentOrLastPathSegment(path.split("/").filter(Boolean));
  const skillDir = stringValue(data?.skill_dir);
  if (skillDir) return lastPathSegment(skillDir.split(/[\\/]/).filter(Boolean));
  return "";
}

function parentOrLastPathSegment(parts: string[]) {
  return parts.length > 1 ? parts[parts.length - 2] : lastPathSegment(parts);
}

function lastPathSegment(parts: string[]) {
  return parts.length ? parts[parts.length - 1] : "";
}

function parseJsonObject(value: string) {
  if (!value.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}
