import { useState } from "react";
import type { FormEvent } from "react";
import { Check, Clock3, Pause, Play, RefreshCcw, Send, Trash2 } from "lucide-react";
import type { CreateScheduledMessageInput } from "./useHermesJobs";
import type { HermesInboxMessage, HermesJob } from "../../types/hermes";

type JobsViewProps = {
  activeJobs: HermesJob[];
  busyJobId: string | null;
  completedJobs: HermesJob[];
  deliveries: HermesInboxMessage[];
  deliveryTarget: string;
  error: string | null;
  loading: boolean;
  pausedJobs: HermesJob[];
  onAcknowledgeDelivery: (messageId: string) => void;
  onCreateScheduledMessage: (input: CreateScheduledMessageInput) => Promise<string>;
  onDeliveryTargetChange: (value: string) => void;
  onRefresh: () => void;
  onRunJobAction: (jobId: string, action: "pause" | "resume" | "run" | "delete") => Promise<string>;
};

export function JobsView({
  activeJobs,
  busyJobId,
  completedJobs,
  deliveries,
  deliveryTarget,
  error,
  loading,
  pausedJobs,
  onAcknowledgeDelivery,
  onCreateScheduledMessage,
  onDeliveryTargetChange,
  onRefresh,
  onRunJobAction,
}: JobsViewProps) {
  const [message, setMessage] = useState("");
  const [minutes, setMinutes] = useState(10);
  const [formNotice, setFormNotice] = useState("");
  const [formBusy, setFormBusy] = useState(false);

  async function submitSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormBusy(true);
    const result = await onCreateScheduledMessage({ message, minutes, deliver: deliveryTarget });
    setFormBusy(false);
    setFormNotice(result);
    if (!isFailure(result)) setMessage("");
  }

  return (
    <div className="jobs-view">
      <section className="jobs-hero">
        <div>
          <p className="eyebrow">Iris Core</p>
          <h1>Scheduled automations</h1>
        </div>
        <button type="button" className="ghost-button" onClick={onRefresh} disabled={loading}>
          <RefreshCcw size={15} className={loading ? "spin" : ""} />
          Refresh
        </button>
      </section>

      {error ? <div className="jobs-alert">{error}</div> : null}

      <div className="jobs-layout">
        <section className="jobs-create-panel">
          <div className="jobs-section-title">
            <Clock3 size={17} />
            <h2>Create scheduled message</h2>
          </div>
          <form className="jobs-form" onSubmit={submitSchedule}>
            <label>
              <span>Message</span>
              <textarea
                value={message}
                placeholder="Stretch your legs before the next call."
                onChange={(event) => setMessage(event.target.value)}
              />
            </label>
            <div className="jobs-form-row">
              <label>
                <span>Minutes</span>
                <input
                  type="number"
                  min={1}
                  max={10080}
                  value={minutes}
                  onChange={(event) => setMinutes(Number(event.target.value) || 1)}
                />
              </label>
              <label>
                <span>Delivery</span>
                <input
                  value={deliveryTarget}
                  placeholder="agentui:desktop"
                  onChange={(event) => onDeliveryTargetChange(event.target.value)}
                />
              </label>
            </div>
            {formNotice ? (
              <p className={isFailure(formNotice) ? "jobs-form-notice error" : "jobs-form-notice"}>
                {formNotice}
              </p>
            ) : null}
            <button type="submit" className="small-button jobs-submit" disabled={formBusy}>
              <Send size={14} />
              {formBusy ? "Scheduling..." : "Schedule"}
            </button>
          </form>
        </section>

        <section className="jobs-list-panel">
          <div className="jobs-section-title">
            <Play size={17} />
            <h2>Active</h2>
          </div>
          <JobList
            jobs={activeJobs}
            emptyText="No active scheduled jobs."
            busyJobId={busyJobId}
            onRunJobAction={onRunJobAction}
          />

          <div className="jobs-section-title spaced">
            <Pause size={17} />
            <h2>Paused</h2>
          </div>
          <JobList
            jobs={pausedJobs}
            emptyText="No paused jobs."
            busyJobId={busyJobId}
            onRunJobAction={onRunJobAction}
          />
        </section>

        <section className="jobs-deliveries-panel">
          <div className="jobs-section-title">
            <Check size={17} />
            <h2>Recent deliveries</h2>
          </div>
          {deliveries.length ? (
            <div className="delivery-list">
              {deliveries.map((delivery) => (
                <article key={delivery.id} className="delivery-row">
                  <div>
                    <p>{delivery.content}</p>
                    <span>{delivery.chatId} - {timeLabel(delivery.createdAt)}</span>
                  </div>
                  {!delivery.acknowledgedAt ? (
                    <button
                      type="button"
                      className="icon-button"
                      title="Mark as read"
                      onClick={() => onAcknowledgeDelivery(delivery.id)}
                    >
                      <Check size={15} />
                    </button>
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <div className="jobs-empty">No automation deliveries yet.</div>
          )}
        </section>

        <section className="jobs-completed-panel">
          <div className="jobs-section-title">
            <Clock3 size={17} />
            <h2>Completed</h2>
          </div>
          <JobList
            jobs={completedJobs}
            emptyText="No completed jobs yet."
            busyJobId={busyJobId}
            onRunJobAction={onRunJobAction}
          />
        </section>
      </div>
    </div>
  );
}

function JobList({
  jobs,
  emptyText,
  busyJobId,
  onRunJobAction,
}: {
  jobs: HermesJob[];
  emptyText: string;
  busyJobId: string | null;
  onRunJobAction: (jobId: string, action: "pause" | "resume" | "run" | "delete") => Promise<string>;
}) {
  if (!jobs.length) return <div className="jobs-empty">{emptyText}</div>;

  return (
    <div className="job-list">
      {jobs.map((job) => {
        const busy = busyJobId === job.id;
        return (
          <article key={job.id} className="job-row">
            <div className="job-row-main">
              <strong>{job.name}</strong>
              <span>{job.schedule || "Manual"} - {job.deliver || "local"}</span>
              <p>{job.prompt}</p>
            </div>
            <div className="job-row-meta">
              <span>{jobTimelineLabel(job)}</span>
              <small>{jobRunLabel(job)}</small>
              <div>
                <button
                  type="button"
                  className="icon-button"
                  title="Run now"
                  disabled={busy}
                  onClick={() => void onRunJobAction(job.id, "run")}
                >
                  <Play size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title={job.status === "paused" ? "Resume" : "Pause"}
                  disabled={busy}
                  onClick={() => void onRunJobAction(job.id, job.status === "paused" ? "resume" : "pause")}
                >
                  {job.status === "paused" ? <Play size={14} /> : <Pause size={14} />}
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title="Delete"
                  disabled={busy}
                  onClick={() => void onRunJobAction(job.id, "delete")}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function timeLabel(value: number | null) {
  if (!value) return "unknown";
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(milliseconds));
}

function jobTimelineLabel(job: HermesJob) {
  if (job.status === "active" && job.nextRunAt) return `Next ${timeLabel(job.nextRunAt)}`;
  if (job.lastRunAt) return `Last ${timeLabel(job.lastRunAt)}`;
  if (job.status === "error") return "Error";
  if (job.status === "completed") return "Completed";
  if (job.status === "paused") return "Paused";
  return job.status;
}

function jobRunLabel(job: HermesJob) {
  const runPart = job.repeat ? `${job.runCount}/${job.repeat}` : `${job.runCount} run${job.runCount === 1 ? "" : "s"}`;
  const statusPart = job.lastError || job.lastDeliveryError || job.lastStatus;
  return statusPart ? `${runPart} - ${statusPart}` : runPart;
}

function isFailure(message: string) {
  return /\b(error|failed|could not|enter|required|invalid)\b/i.test(message);
}
