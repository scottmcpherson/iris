import { useEffect, useMemo, useRef, useState } from "react";
import {
  createAgentUICoreAutomation,
  deleteAgentUICoreAutomation,
  getAgentUICoreAutomationEvents,
  getAgentUICoreAgentForProfile,
  getAgentUICoreAutomations,
  getAgentUICoreEvents,
  pauseAgentUICoreAutomation,
  resumeAgentUICoreAutomation,
  runAgentUICoreAutomation,
  updateAgentUICoreAutomation,
  type AgentUICoreAgent,
  type AgentUICoreEvent,
} from "../../lib/agentuiCore";
import { coreEventToInboxMessage } from "../../lib/irisRuntime";
import { rawStringValue } from "../../shared/strings";
import type {
  HermesAutomation,
  HermesAutomationSchedule,
  HermesInboxMessage,
  HermesJobStatus,
  HermesRuntimeConfig,
} from "../../types/hermes";

const defaultDeliveryTarget = "iris:desktop";
const legacyDeliveryPrefix = "agentui:";

export type CreateScheduledMessageInput = {
  name?: string;
  prompt: string;
  schedule: string;
  repeat?: number | null;
  deliver?: string;
  projectId?: string | null;
};

export type UpdateScheduledMessageInput = {
  name?: string;
  prompt: string;
  schedule: string;
  repeat?: number | null;
  deliver?: string;
  projectId?: string | null;
};

type AutomationPayloadResult =
  | { ok: true; payload: ReturnType<typeof automationRequestPayload> }
  | { ok: false; error: string };

type AutomationRequestPayload = {
  name: string;
  schedule: string;
  prompt: string;
  repeat?: number | null;
  deliver?: string;
  projectId?: string | null;
};

export type LegacyCreateScheduledMessageInput = {
  message: string;
  name?: string;
  minutes?: number;
  deliver?: string;
  projectId?: string | null;
};

export function useAgentUIAutomations(runtimeConfig: HermesRuntimeConfig, profile = "default", active = true) {
  const [automations, setAutomations] = useState<HermesAutomation[]>([]);
  const [deliveries, setDeliveries] = useState<HermesInboxMessage[]>([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [deliveriesLoadedKey, setDeliveriesLoadedKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyAutomationId, setBusyAutomationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inboxCursorRef = useRef(0);
  const deliveriesRequestRef = useRef(0);
  const deliveriesLoadingStartedAtRef = useRef(0);
  const deliveriesLoadingTimerRef = useRef<number | null>(null);

  const activeAutomations = useMemo(
    () => automations.filter((automation) => automation.enabled && automation.status !== "paused" && automation.status !== "error"),
    [automations],
  );
  const pausedAutomations = useMemo(() => automations.filter((automation) => automation.status === "paused"), [automations]);
  const deliveriesScopeKey = `${profile}:${runtimeConfig.coreApiUrl || ""}`;

  useEffect(() => {
    if (!active) return;
    const requestId = deliveriesRequestRef.current + 1;
    deliveriesRequestRef.current = requestId;
    inboxCursorRef.current = 0;
    beginDeliveriesLoading();
    void refresh(requestId, deliveriesScopeKey);
    const timer = window.setInterval(() => {
      void refreshSilently();
    }, 6000);
    return () => {
      window.clearInterval(timer);
      clearDeliveriesLoadingTimer();
    };
  }, [active, deliveriesScopeKey]);

  async function refresh(deliveriesRequestId = deliveriesRequestRef.current, scopeKey = deliveriesScopeKey) {
    setLoading(true);
    try {
      const agent = await resolveAgent();
      if (!agent) return;
      await Promise.all([loadJobsForAgent(agent.id), loadRecentDeliveries(agent.id, deliveriesRequestId, true, scopeKey)]);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not load automations.");
      if (deliveriesRequestId === deliveriesRequestRef.current) {
        finishDeliveriesLoading(deliveriesRequestId, scopeKey, false);
      }
    } finally {
      setLoading(false);
    }
  }

  async function refreshSilently() {
    try {
      const agent = await resolveAgent();
      if (!agent) return;
      await Promise.all([pollDeliveries(agent.id), loadJobsForAgent(agent.id)]);
    } catch {
      // Background polling should not replace the visible error from an explicit refresh.
    }
  }

  async function loadJobs(options: { silent?: boolean } = {}) {
    try {
      const agent = await resolveAgent();
      if (!agent) return;
      await loadJobsForAgent(agent.id);
    } catch (error) {
      if (!options.silent) {
        setError(error instanceof Error ? error.message : "Could not load scheduled jobs.");
      }
    }
  }

  async function loadJobsForAgent(agentId: string) {
    const result = await getAgentUICoreAutomations(agentId, runtimeConfig);
    if (!result.ok) throw new Error(result.error || "Could not load scheduled jobs.");
    setAutomations(normalizeJobsResult(result));
    setError(null);
  }

  async function pollDeliveries(agentId?: string) {
    const resolvedAgentId = agentId || (await resolveAgent())?.id;
    if (!resolvedAgentId) return;
    if (!inboxCursorRef.current) {
      await loadRecentDeliveries(resolvedAgentId, deliveriesRequestRef.current, false, deliveriesScopeKey);
      return;
    }
    const result = await getAgentUICoreEvents(inboxCursorRef.current, 50, runtimeConfig, resolvedAgentId);
    if (!result.ok) return;
    inboxCursorRef.current = result.cursor || inboxCursorRef.current;
    const messages = automationDeliveryMessagesFromEvents(result.events, profile);
    mergeDeliveries(messages);
  }

  async function loadRecentDeliveries(
    agentId: string,
    requestId = deliveriesRequestRef.current,
    showLoading = true,
    scopeKey = deliveriesScopeKey,
  ) {
    if (showLoading) beginDeliveriesLoading();
    const result = await getAgentUICoreAutomationEvents(50, runtimeConfig, agentId);
    if (requestId !== deliveriesRequestRef.current) return;
    const messages = result.ok ? sortDeliveries(automationDeliveryMessagesFromEvents(result.events, profile)) : [];
    if (result.ok) {
      inboxCursorRef.current = result.cursor || latestEventCursor(result.events) || inboxCursorRef.current;
      setDeliveries(messages);
    }
    finishDeliveriesLoading(requestId, scopeKey, messages.length > 0);
  }

  function beginDeliveriesLoading() {
    clearDeliveriesLoadingTimer();
    deliveriesLoadingStartedAtRef.current = Date.now();
    setDeliveriesLoading(true);
  }

  function finishDeliveriesLoading(requestId: number, scopeKey: string, hasDeliveries: boolean) {
    if (requestId !== deliveriesRequestRef.current) return;
    setDeliveriesLoadedKey(scopeKey);
    if (hasDeliveries) {
      setDeliveriesLoading(false);
      return;
    }
    const remaining = Math.max(0, 750 - (Date.now() - deliveriesLoadingStartedAtRef.current));
    if (!remaining) {
      setDeliveriesLoading(false);
      return;
    }
    deliveriesLoadingTimerRef.current = window.setTimeout(() => {
      if (requestId === deliveriesRequestRef.current) {
        setDeliveriesLoading(false);
      }
    }, remaining);
  }

  function clearDeliveriesLoadingTimer() {
    if (deliveriesLoadingTimerRef.current == null) return;
    window.clearTimeout(deliveriesLoadingTimerRef.current);
    deliveriesLoadingTimerRef.current = null;
  }

  async function resolveAgent(): Promise<AgentUICoreAgent | null> {
    const agentResult = await getAgentUICoreAgentForProfile(profile, runtimeConfig);
    if (!agentResult.ok || !agentResult.agent) {
      throw new Error(agentError(agentResult) || "Could not resolve Iris agent.");
    }
    return agentResult.agent;
  }

  function mergeDeliveries(messages: HermesInboxMessage[]) {
    if (!messages.length) return;
    setDeliveries((current) => {
      const byId = new Map(current.map((message) => [message.id, message]));
      for (const message of messages) {
        byId.set(message.id, message);
      }
      return sortDeliveries([...byId.values()]);
    });
  }

  async function createScheduledMessage(input: CreateScheduledMessageInput | LegacyCreateScheduledMessageInput) {
    const normalized = automationPayloadFromInput(input, profile);
    if (!normalized.ok) return normalized.error;
    const agentResult = await getAgentUICoreAgentForProfile(profile, runtimeConfig);
    if (!agentResult.ok || !agentResult.agent) return agentError(agentResult) || "Could not resolve Iris agent.";
    const result = await createAgentUICoreAutomation(
      {
        agentId: agentResult.agent.id,
        ...normalized.payload,
      },
      runtimeConfig,
    );
    if (!result.ok) return result.error || "Could not create scheduled message.";
    await loadJobs();
    return "Automation scheduled.";
  }

  async function updateScheduledMessage(jobId: string, input: UpdateScheduledMessageInput) {
    const normalized = automationPayloadFromInput(input, profile);
    if (!normalized.ok) return normalized.error;
    const result = await updateAgentUICoreAutomation(jobId, normalized.payload, runtimeConfig);
    if (!result.ok) return result.error || "Could not update scheduled message.";
    await loadJobs();
    return "Automation updated.";
  }

  async function runJobAction(jobId: string, action: "pause" | "resume" | "run" | "delete") {
    setBusyAutomationId(jobId);
    try {
      const result =
        action === "pause"
          ? await pauseAgentUICoreAutomation(jobId, runtimeConfig)
          : action === "resume"
            ? await resumeAgentUICoreAutomation(jobId, runtimeConfig)
            : action === "run"
              ? await runAgentUICoreAutomation(jobId, runtimeConfig)
              : await deleteAgentUICoreAutomation(jobId, runtimeConfig);
      if (!result.ok) throw new Error(result.error || `Could not ${action} job.`);
      await loadJobs();
      return "";
    } catch (error) {
      const message = error instanceof Error ? error.message : `Could not ${action} job.`;
      setError(message);
      return message;
    } finally {
      setBusyAutomationId(null);
    }
  }

  async function acknowledgeDelivery(messageId: string) {
    setDeliveries((current) =>
      current.map((message) =>
        message.id === messageId
          ? { ...message, acknowledgedAt: Math.floor(Date.now() / 1000) }
          : message,
      ),
    );
  }

  return {
    activeAutomations,
    acknowledgeDelivery,
    busyAutomationId,
    createScheduledMessage,
    deliveries,
    deliveriesLoading: isAutomationActivityLoading(active, deliveriesLoading, deliveriesLoadedKey, deliveriesScopeKey),
    error,
    automations,
    loading,
    pausedAutomations,
    refresh,
    runJobAction,
    updateScheduledMessage,
  };
}

export const useIrisAutomations = useAgentUIAutomations;

export function isAutomationActivityLoading(
  active: boolean,
  loading: boolean,
  loadedKey: string,
  scopeKey: string,
) {
  return loading || (active && loadedKey !== scopeKey);
}

export function automationDeliveryMessagesFromEvents(events: AgentUICoreEvent[], profile: string) {
  return events
    .filter((event) => event.type.startsWith("message.assistant") || event.type === "message.error")
    .map((event) => coreEventToInboxMessage(event, profile))
    .filter(isAutomationDeliveryMessage);
}

export function isAutomationDeliveryMessage(message: HermesInboxMessage) {
  const metadata = message.metadata as Record<string, unknown>;
  return (
    message.source === "hermes-cron" ||
    Boolean(metadata.automationId) ||
    Boolean(metadata.jobId) ||
    Boolean(metadata.job_id)
  );
}

function sortDeliveries(messages: HermesInboxMessage[]) {
  return [...messages].sort((left, right) => right.createdAt - left.createdAt).slice(0, 50);
}

function latestEventCursor(events: AgentUICoreEvent[]) {
  return events.reduce((cursor, event) => Math.max(cursor, event.cursor || 0), 0);
}

export function normalizeJobsResult(result: Record<string, unknown>) {
  const rawJobs =
    (Array.isArray(result.jobs) && result.jobs) ||
    (Array.isArray(result.automations) && result.automations) ||
    (Array.isArray(result.items) && result.items) ||
    (Array.isArray(result.data) && result.data) ||
    [];
  return rawJobs
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map(normalizeJob)
    .sort((left, right) => (left.nextRunAt || 0) - (right.nextRunAt || 0));
}

function normalizeJob(row: Record<string, unknown>): HermesAutomation {
  const metadata = recordValue(row.metadata);
  const runtimeJob = recordValue(metadata.runtimeJob);
  const source = runtimeJob ? { ...row, ...runtimeJob } : row;
  const schedule = row.schedule && typeof row.schedule === "object" && !Array.isArray(row.schedule)
    ? row.schedule as Record<string, unknown>
    : source.schedule && typeof source.schedule === "object" && !Array.isArray(source.schedule)
      ? source.schedule as Record<string, unknown>
    : null;
  const repeat = row.repeat && typeof row.repeat === "object" && !Array.isArray(row.repeat)
    ? row.repeat as Record<string, unknown>
    : source.repeat && typeof source.repeat === "object" && !Array.isArray(source.repeat)
      ? source.repeat as Record<string, unknown>
    : null;
  const status = normalizeJobStatus(source.status || source.state || (source.enabled === false || row.enabled === false ? "paused" : "active"));
  const enabled = booleanValue(source.enabled ?? row.enabled, status !== "paused");
  return {
    id: rawStringValue(row.id || source.id || source.jobId || source.job_id),
    name: rawStringValue(source.name) || "Untitled job",
    schedule: normalizeSchedule(row, source, schedule),
    prompt: rawStringValue(source.prompt),
    deliver: rawStringValue(source.deliver || source.delivery || metadata.deliver || row.deliverToSessionId),
    deliverToSessionId: rawStringValue(row.deliverToSessionId || metadata.deliverToSessionId),
    projectId: nullableStringValue(row.projectId || metadata.projectId),
    resolvedDeliveryTarget: recordValue(row.resolvedDeliveryTarget || metadata.resolvedDeliveryTarget),
    status,
    enabled,
    nextRunAt: timestampValue(row.nextRunAt || source.nextRunAt || source.next_run_at || source.nextRun || source.next_run || schedule?.run_at),
    lastRunAt: timestampValue(row.lastRunAt || source.lastRunAt || source.last_run_at || source.lastRun || source.last_run),
    lastStatus: rawStringValue(source.lastStatus || source.last_status),
    lastError: rawStringValue(source.lastError || source.last_error),
    lastDeliveryError: rawStringValue(source.lastDeliveryError || source.last_delivery_error),
    runCount: Math.floor(numberValue(source.runCount || source.run_count || source.runs || repeat?.completed) || 0),
    repeat: numberValue(repeat?.times || source.repeat || metadata.repeat),
    skills: stringArrayValue(source.skills),
    skill: nullableStringValue(source.skill),
    script: nullableStringValue(source.script),
    noAgent: booleanValue(source.noAgent ?? source.no_agent, false),
    contextFrom: stringArrayValue(source.contextFrom ?? source.context_from),
    workdir: nullableStringValue(source.workdir),
    enabledToolsets: arrayOrNull(source.enabledToolsets ?? source.enabled_toolsets),
    model: nullableStringValue(source.model),
    provider: nullableStringValue(source.provider),
    baseUrl: nullableStringValue(source.baseUrl ?? source.base_url),
    createdAt: timestampValue(row.createdAt || source.createdAt || source.created_at),
    raw: runtimeJob || row,
  };
}

function normalizeSchedule(
  row: Record<string, unknown>,
  source: Record<string, unknown>,
  schedule: Record<string, unknown> | null,
): HermesAutomationSchedule {
  const display = rawStringValue(
    row.schedule_display ||
      source.schedule_display ||
      schedule?.display ||
      (typeof row.schedule === "string" ? row.schedule : "") ||
      (typeof source.schedule === "string" ? source.schedule : "") ||
      source.cron ||
      source.when,
  );
  const kind = rawStringValue(schedule?.kind).toLowerCase();
  const normalizedKind =
    kind === "once" || kind === "interval" || kind === "cron"
      ? kind
      : "unknown";
  return {
    kind: normalizedKind,
    display,
    ...(rawStringValue(schedule?.run_at || schedule?.runAt) ? { runAt: rawStringValue(schedule?.run_at || schedule?.runAt) } : {}),
    ...(numberValue(schedule?.minutes) !== null ? { minutes: numberValue(schedule?.minutes) || 0 } : {}),
    ...(rawStringValue(schedule?.expr) ? { expr: rawStringValue(schedule?.expr) } : {}),
  };
}

function normalizeJobStatus(value: unknown): HermesJobStatus {
  const status = rawStringValue(value).toLowerCase();
  if (status.includes("pause")) return "paused";
  if (status.includes("complete") || status.includes("done")) return "completed";
  if (status.includes("error") || status.includes("fail")) return "error";
  if (
    status.includes("active") ||
    status.includes("run") ||
    status.includes("enabled") ||
    status.includes("scheduled") ||
    status.includes("pending")
  ) return "active";
  return "unknown";
}

function numberValue(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampValue(value: unknown): number | null {
  const number = numberValue(value);
  if (number !== null) return number;
  if (typeof value !== "string" || !value.trim()) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null;
}

function agentError(value: unknown) {
  return value && typeof value === "object" && "error" in value
    ? String((value as { error?: unknown }).error || "")
    : "";
}

function automationPayloadFromInput(
  input: CreateScheduledMessageInput | UpdateScheduledMessageInput | LegacyCreateScheduledMessageInput,
  profile: string,
): AutomationPayloadResult {
  const payload = automationRequestPayload(input, profile);
  if (!payload.prompt) return { ok: false, error: "Enter a prompt to schedule." };
  if (!payload.schedule) return { ok: false, error: "Enter a schedule." };
  return { ok: true, payload };
}

export function automationRequestPayload(
  input: CreateScheduledMessageInput | UpdateScheduledMessageInput | LegacyCreateScheduledMessageInput,
  profile: string,
): AutomationRequestPayload {
  void profile;
  const legacyMinutes =
    "minutes" in input && input.minutes != null
      ? Math.max(1, Math.floor(input.minutes || 1))
      : null;
  const prompt = "prompt" in input
    ? input.prompt.trim()
    : `Reply exactly with this message: ${input.message.trim()}`;
  const schedule = "schedule" in input
    ? input.schedule.trim()
    : `${legacyMinutes || 1}m`;
  const repeat = "repeat" in input
    ? normalizeRepeat(input.repeat)
    : 1;
  const deliver = input.deliver ? normalizeDeliveryTarget(input.deliver) : "";
  const projectId = "projectId" in input ? normalizeProjectId(input.projectId) : null;
  return {
    name: input.name?.trim() || "Iris reminder",
    schedule,
    prompt,
    ...(repeat !== undefined ? { repeat } : {}),
    ...(deliver ? { deliver } : {}),
    projectId,
  };
}

export function normalizeDeliveryTarget(value: string) {
  const target = value.trim() || defaultDeliveryTarget;
  return target.startsWith(legacyDeliveryPrefix)
    ? `iris:${target.slice(legacyDeliveryPrefix.length)}`
    : target;
}

function normalizeRepeat(value: number | null | undefined) {
  if (value === null || value === undefined) return undefined;
  return Math.max(1, Math.floor(value || 1));
}

function normalizeProjectId(value: string | null | undefined) {
  const projectId = rawStringValue(value);
  return projectId || null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => rawStringValue(item)).filter(Boolean) : [];
}

function arrayOrNull(value: unknown): string[] | null {
  const rows = stringArrayValue(value);
  return rows.length ? rows : null;
}

function nullableStringValue(value: unknown): string | null {
  const text = rawStringValue(value);
  return text || null;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}
