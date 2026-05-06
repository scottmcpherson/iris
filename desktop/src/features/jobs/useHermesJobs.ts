import { useEffect, useMemo, useRef, useState } from "react";
import {
  createAgentUICoreAutomation,
  deleteAgentUICoreAutomation,
  getAgentUICoreAgentForProfile,
  getAgentUICoreAutomations,
  getAgentUICoreEvents,
  pauseAgentUICoreAutomation,
  resumeAgentUICoreAutomation,
  runAgentUICoreAutomation,
} from "../../lib/agentuiCore";
import { coreEventToInboxMessage } from "../../lib/hermes";
import type { HermesInboxMessage, HermesJob, HermesJobStatus, HermesRuntimeConfig } from "../../types/hermes";

const deliveryTargetStorageKey = "hermes.desktop.jobs.deliveryTarget";

export type CreateScheduledMessageInput = {
  message: string;
  minutes: number;
  name?: string;
  deliver?: string;
};

export function useAgentUIAutomations(runtimeConfig: HermesRuntimeConfig, profile = "default") {
  const [jobs, setJobs] = useState<HermesJob[]>([]);
  const [deliveries, setDeliveries] = useState<HermesInboxMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deliveryTarget, setDeliveryTarget] = useState(() => loadDeliveryTarget());
  const inboxCursorRef = useRef(0);

  const activeJobs = useMemo(() => jobs.filter((job) => job.status === "active"), [jobs]);
  const pausedJobs = useMemo(() => jobs.filter((job) => job.status === "paused"), [jobs]);
  const completedJobs = useMemo(() => jobs.filter((job) => !["active", "paused"].includes(job.status)), [jobs]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void pollDeliveries();
      void loadJobs({ silent: true });
    }, 6000);
    return () => window.clearInterval(timer);
  }, [profile, runtimeConfig.gatewayUrl, runtimeConfig.managementApiUrl]);

  function updateDeliveryTarget(value: string) {
    const normalized = value.trim() || "agentui:desktop";
    setDeliveryTarget(normalized);
    localStorage.setItem(deliveryTargetStorageKey, normalized);
  }

  async function refresh() {
    setLoading(true);
    await Promise.all([loadJobs(), pollDeliveries()]);
    setLoading(false);
  }

  async function loadJobs(options: { silent?: boolean } = {}) {
    try {
      const agentResult = await getAgentUICoreAgentForProfile(profile, runtimeConfig);
      if (!agentResult.ok || !agentResult.agent) {
        throw new Error(agentError(agentResult) || "Could not resolve Iris agent.");
      }
      const result = await getAgentUICoreAutomations(agentResult.agent.id, runtimeConfig);
      if (!result.ok) throw new Error(result.error || "Could not load scheduled jobs.");
      setJobs(normalizeJobsResult(result));
      setError(null);
    } catch (error) {
      if (!options.silent) {
        setError(error instanceof Error ? error.message : "Could not load scheduled jobs.");
      }
    }
  }

  async function pollDeliveries() {
    const agentResult = await getAgentUICoreAgentForProfile(profile, runtimeConfig);
    if (!agentResult.ok || !agentResult.agent) return;
    const result = await getAgentUICoreEvents(inboxCursorRef.current, 50, runtimeConfig, agentResult.agent.id);
    if (!result.ok) return;
    inboxCursorRef.current = result.cursor || inboxCursorRef.current;
    const messages = result.events
      .filter((event) => event.type.startsWith("message.assistant") || event.type === "message.error")
      .map((event) => coreEventToInboxMessage(event, profile));
    if (!messages.length) return;
    setDeliveries((current) => {
      const byId = new Map(current.map((message) => [message.id, message]));
      for (const message of messages) {
        const metadata = message.metadata as Record<string, unknown>;
        if (message.source === "hermes-cron" || metadata.automationId || metadata.jobId) {
          byId.set(message.id, message);
        }
      }
      return [...byId.values()].sort((left, right) => right.createdAt - left.createdAt).slice(0, 50);
    });
  }

  async function createScheduledMessage(input: CreateScheduledMessageInput) {
    const message = input.message.trim();
    if (!message) return "Enter a message to schedule.";
    const minutes = Math.max(1, Math.floor(input.minutes || 1));
    const deliver = (input.deliver || deliveryTarget).trim() || "agentui:desktop";
    updateDeliveryTarget(deliver);
    const agentResult = await getAgentUICoreAgentForProfile(profile, runtimeConfig);
    if (!agentResult.ok || !agentResult.agent) return agentError(agentResult) || "Could not resolve Iris agent.";
    const result = await createAgentUICoreAutomation(
      {
        agentId: agentResult.agent.id,
        name: input.name?.trim() || "Iris reminder",
        schedule: `${minutes}m`,
        prompt: `Reply exactly with this message: ${message}`,
        repeat: 1,
        deliver,
        metadata: {
          kind: "scheduled-message",
          profile,
        },
      },
      runtimeConfig,
    );
    if (!result.ok) return result.error || "Could not create scheduled message.";
    await loadJobs();
    return `Scheduled for ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  }

  async function runJobAction(jobId: string, action: "pause" | "resume" | "run" | "delete") {
    setBusyJobId(jobId);
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
      setBusyJobId(null);
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
    activeJobs,
    acknowledgeDelivery,
    busyJobId,
    completedJobs,
    createScheduledMessage,
    deliveries,
    deliveryTarget,
    error,
    jobs,
    loading,
    pausedJobs,
    refresh,
    runJobAction,
    updateDeliveryTarget,
  };
}

export const useHermesJobs = useAgentUIAutomations;

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

function normalizeJob(row: Record<string, unknown>): HermesJob {
  const schedule = row.schedule && typeof row.schedule === "object" && !Array.isArray(row.schedule)
    ? row.schedule as Record<string, unknown>
    : null;
  const repeat = row.repeat && typeof row.repeat === "object" && !Array.isArray(row.repeat)
    ? row.repeat as Record<string, unknown>
    : null;
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : {};
  return {
    id: stringValue(row.id || row.jobId || row.job_id),
    name: stringValue(row.name) || "Untitled job",
    schedule: stringValue(row.schedule_display || schedule?.display || row.schedule || row.scheduleText || row.cron || row.when),
    prompt: stringValue(row.prompt),
    deliver: stringValue(row.deliver || row.delivery || metadata.deliver || row.deliverToConversationId),
    status: normalizeJobStatus(row.status || row.state || (row.enabled === false ? "paused" : "active")),
    nextRunAt: timestampValue(row.nextRunAt || row.next_run_at || row.nextRun || row.next_run || schedule?.run_at),
    lastRunAt: timestampValue(row.lastRunAt || row.last_run_at || row.lastRun || row.last_run),
    lastStatus: stringValue(row.lastStatus || row.last_status),
    lastError: stringValue(row.lastError || row.last_error),
    lastDeliveryError: stringValue(row.lastDeliveryError || row.last_delivery_error),
    runCount: Math.floor(numberValue(row.runCount || row.run_count || row.runs || repeat?.completed) || 0),
    repeat: numberValue(repeat?.times || row.repeat || metadata.repeat),
    createdAt: timestampValue(row.createdAt || row.created_at),
    raw: row,
  };
}

function normalizeJobStatus(value: unknown): HermesJobStatus {
  const status = stringValue(value).toLowerCase();
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

function stringValue(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
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

function loadDeliveryTarget() {
  try {
    return localStorage.getItem(deliveryTargetStorageKey) || "agentui:desktop";
  } catch {
    return "agentui:desktop";
  }
}

function agentError(value: unknown) {
  return value && typeof value === "object" && "error" in value
    ? String((value as { error?: unknown }).error || "")
    : "";
}
