import { useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { Check, Info, Pause, Pencil, Play, Plus, Send, Trash2, X } from "lucide-react";
import type { CreateScheduledMessageInput, UpdateScheduledMessageInput } from "./useIrisAutomations";
import { ProjectMenu } from "../chat/components/ProjectMenu";
import type { IrisProject } from "../../lib/agentuiCore";
import type { HermesAutomation, HermesInboxMessage } from "../../types/hermes";
import { Button } from "../../shared/ui/button";

type TabKey = "active" | "paused";
type ScheduleMode = "delay" | "datetime" | "daily" | "custom";
type RepeatMode = "once" | "forever" | "count";

type AutomationsViewProps = {
  activeAutomations: HermesAutomation[];
  busyAutomationId: string | null;
  connected: boolean;
  deliveries: HermesInboxMessage[];
  error: string | null;
  pausedAutomations: HermesAutomation[];
  projects: IrisProject[];
  selectedProjectId: string | null;
  onAcknowledgeDelivery: (messageId: string) => void;
  onCreateScheduledMessage: (input: CreateScheduledMessageInput) => Promise<string>;
  onOpenDeliveryChat: (delivery: HermesInboxMessage) => void;
  onProjectChange: (projectId: string | null) => void;
  onRunJobAction: (jobId: string, action: "pause" | "resume" | "run" | "delete") => Promise<string>;
  onUpdateScheduledMessage: (jobId: string, input: UpdateScheduledMessageInput) => Promise<string>;
};

const tabOrder: TabKey[] = ["active", "paused"];

export function AutomationsView({
  activeAutomations,
  busyAutomationId,
  connected,
  deliveries,
  error,
  pausedAutomations,
  projects,
  selectedProjectId,
  onAcknowledgeDelivery,
  onCreateScheduledMessage,
  onOpenDeliveryChat,
  onProjectChange,
  onRunJobAction,
  onUpdateScheduledMessage,
}: AutomationsViewProps) {
  const allJobs = [...activeAutomations, ...pausedAutomations];
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>("delay");
  const [minutes, setMinutes] = useState(10);
  const [runAt, setRunAt] = useState(() => dateTimeLocalValue(Date.now() + 10 * 60 * 1000));
  const [dailyTime, setDailyTime] = useState("09:00");
  const [customSchedule, setCustomSchedule] = useState("tomorrow at 9am");
  const [repeatMode, setRepeatMode] = useState<RepeatMode>("once");
  const [repeatCount, setRepeatCount] = useState(5);
  const [formNotice, setFormNotice] = useState("");
  const [formBusy, setFormBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [tab, setTab] = useState<TabKey>("active");
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [confirmDeleteJobId, setConfirmDeleteJobId] = useState<string | null>(null);

  const visibleJobs =
    tab === "active" ? activeAutomations : pausedAutomations;
  const selectedJob = allJobs.find((job) => job.id === selectedJobId) || null;
  const schedule = automationScheduleValue({ scheduleMode, minutes, runAt, dailyTime, customSchedule });
  const repeat = repeatValue(repeatMode, repeatCount);
  const preview = schedulePreview({ scheduleMode, minutes, runAt, dailyTime, customSchedule, repeatMode, repeatCount });
  const emptyText =
    tab === "active"
      ? "No active automations."
      : "No paused automations.";

  async function submitSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormBusy(true);
    const input = { name, prompt, schedule, repeat, projectId: selectedProjectId || null };
    const result = editingJobId
      ? await onUpdateScheduledMessage(editingJobId, input)
      : await onCreateScheduledMessage(input);
    setFormBusy(false);
    setFormNotice(result);
    if (!isFailure(result)) {
      setEditingJobId(null);
      setFormOpen(false);
      setPrompt("");
      setName("");
    }
  }

  function startCreating() {
    resetForm();
    setFormOpen(true);
  }

  function startEditing(job: HermesAutomation) {
    const form = automationFormStateFromJob(job);
    setEditingJobId(job.id);
    setSelectedJobId(job.id);
    setFormOpen(true);
    setName(form.name);
    setPrompt(form.prompt);
    setScheduleMode(form.scheduleMode);
    setMinutes(form.minutes);
    setRunAt(form.runAt);
    setDailyTime(form.dailyTime);
    setCustomSchedule(form.customSchedule);
    setRepeatMode(form.repeatMode);
    setRepeatCount(form.repeatCount);
    onProjectChange(job.projectId || null);
    setFormNotice("");
  }

  function cancelEditing() {
    resetForm();
    setFormOpen(false);
  }

  function resetForm() {
    setEditingJobId(null);
    setName("");
    setPrompt("");
    setScheduleMode("delay");
    setMinutes(10);
    setRunAt(dateTimeLocalValue(Date.now() + 10 * 60 * 1000));
    setDailyTime("09:00");
    setCustomSchedule("tomorrow at 9am");
    setRepeatMode("once");
    setRepeatCount(5);
    setProjectMenuOpen(false);
    setFormNotice("");
  }

  function handleTabsKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = tabOrder.indexOf(tab);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabOrder.length - 1
          : event.key === "ArrowRight"
            ? (currentIndex + 1) % tabOrder.length
            : (currentIndex - 1 + tabOrder.length) % tabOrder.length;
    const nextTab = tabOrder[nextIndex];
    setTab(nextTab);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-jobs-tab="${nextTab}"]`)?.focus();
    });
  }

  async function deleteJob(jobId: string) {
    if (confirmDeleteJobId !== jobId) {
      setConfirmDeleteJobId(jobId);
      return;
    }
    setConfirmDeleteJobId(null);
    const result = await onRunJobAction(jobId, "delete");
    if (result) setFormNotice(result);
    if (!result && selectedJobId === jobId) setSelectedJobId(null);
  }

  return (
    <div className="jobs-view">
      <header className="jobs-header agent-list-header">
        <div>
          <h1>Automations</h1>
        </div>
        <div className="jobs-header-actions">
          <Button
            type="button"
            size="icon-md"
            aria-label="Create automation"
            title="Create automation"
            onClick={startCreating}
          >
            <Plus data-icon="inline-start" />
          </Button>
        </div>
      </header>

      <div className="jobs-body">
        {error ? <div className="jobs-alert">{error}</div> : null}

        {formOpen ? (
          <div
            className="jobs-modal-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !formBusy) cancelEditing();
            }}
          >
            <section
              className="jobs-create-card jobs-modal-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="jobs-form-title"
            >
              <div className="jobs-create-heading">
                <div>
                  <p className="eyebrow">Automation</p>
                  <h2 id="jobs-form-title">{editingJobId ? "Edit automation" : "New automation"}</h2>
                </div>
                <button type="button" className="icon-button" title="Close" onClick={cancelEditing} disabled={formBusy}>
                  <X size={15} />
                </button>
              </div>
              <form className="jobs-form" onSubmit={submitSchedule}>
                <div className="jobs-form-grid">
                  {/* Mirrors Hermes _MAX_NAME_LENGTH=200 and _MAX_PROMPT_LENGTH=5000. */}
                  <label className="jobs-form-field jobs-form-prompt">
                    <span>Name</span>
                    <input
                      value={name}
                      placeholder="Morning standup"
                      maxLength={200}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                  <label className="jobs-form-field jobs-form-prompt">
                    <span>Prompt</span>
                    <textarea
                      value={prompt}
                      placeholder="Send a concise morning standup reminder."
                      maxLength={5000}
                      onChange={(event) => setPrompt(event.target.value)}
                    />
                  </label>
                  <label className="jobs-form-field jobs-form-prompt">
                    <span>Schedule</span>
                    <select value={scheduleMode} onChange={(event) => setScheduleMode(event.target.value as ScheduleMode)}>
                      <option value="delay">In minutes</option>
                      <option value="datetime">Date and time</option>
                      <option value="daily">Daily time</option>
                      <option value="custom">Custom</option>
                    </select>
                  </label>
                  <div className="jobs-form-field jobs-project-field">
                    <span>Project</span>
                    <div className="composer-project-menu-wrap jobs-project-menu-wrap">
                      <ProjectMenu
                        projects={projects}
                        selectedProjectId={selectedProjectId}
                        open={projectMenuOpen}
                        disabled={!connected}
                        title="Choose project"
                        locked={false}
                        connected={connected}
                        side="bottom"
                        onOpenChange={setProjectMenuOpen}
                        onSelect={(projectId) => {
                          onProjectChange(projectId);
                          setProjectMenuOpen(false);
                        }}
                      />
                    </div>
                  </div>
                  {scheduleMode === "delay" ? (
                    <label className="jobs-form-field jobs-form-wide-control">
                      <span>Minutes</span>
                      <input
                        type="number"
                        min={1}
                        max={10080}
                        value={minutes}
                        onChange={(event) => setMinutes(Number(event.target.value) || 1)}
                      />
                    </label>
                  ) : null}
                  {scheduleMode === "datetime" ? (
                    <label className="jobs-form-field jobs-form-wide-control">
                      <span>Run at</span>
                      <input type="datetime-local" value={runAt} onChange={(event) => setRunAt(event.target.value)} />
                    </label>
                  ) : null}
                  {scheduleMode === "daily" ? (
                    <label className="jobs-form-field jobs-form-wide-control">
                      <span>Time</span>
                      <input type="time" value={dailyTime} onChange={(event) => setDailyTime(event.target.value)} />
                    </label>
                  ) : null}
                  {scheduleMode === "custom" ? (
                    <label className="jobs-form-field jobs-form-wide-control">
                      <span>Custom schedule</span>
                      <input
                        value={customSchedule}
                        placeholder="tomorrow at 9am or cron: 0 9 * * 1-5"
                        onChange={(event) => setCustomSchedule(event.target.value)}
                      />
                    </label>
                  ) : null}
                  <label className="jobs-form-field">
                    <span>Repeat</span>
                    <select value={repeatMode} onChange={(event) => setRepeatMode(event.target.value as RepeatMode)}>
                      <option value="once">Once</option>
                      <option value="forever">Until paused</option>
                      <option value="count">Fixed count</option>
                    </select>
                  </label>
                  {repeatMode === "count" ? (
                    <label className="jobs-form-field">
                      <span>Runs</span>
                      <input
                        type="number"
                        min={1}
                        max={999}
                        value={repeatCount}
                        onChange={(event) => setRepeatCount(Number(event.target.value) || 1)}
                      />
                    </label>
                  ) : null}
                </div>
                <div className="jobs-form-footer">
                  <div className="jobs-form-status">
                    <p className="jobs-schedule-preview">{preview}</p>
                    {formNotice ? (
                      <p className={isFailure(formNotice) ? "jobs-form-notice error" : "jobs-form-notice"}>
                        {formNotice}
                      </p>
                    ) : null}
                  </div>
                  <div className="jobs-form-action">
                    <button type="button" className="small-button settings-button" onClick={cancelEditing} disabled={formBusy}>
                      Cancel
                    </button>
                    <Button type="submit" size="appSmall" disabled={formBusy}>
                      <Send data-icon="inline-start" />
                      {formBusy ? "Saving..." : editingJobId ? "Save changes" : "Schedule"}
                    </Button>
                  </div>
                </div>
              </form>
            </section>
          </div>
        ) : null}

        <section className="jobs-list-section">
          <div className="jobs-tabs" role="tablist" aria-label="Automation status" onKeyDown={handleTabsKeyDown}>
            <TabButton
              tabKey="active"
              label="Active"
              count={activeAutomations.length}
              selected={tab === "active"}
              onSelect={() => setTab("active")}
            />
            <TabButton
              tabKey="paused"
              label="Paused"
              count={pausedAutomations.length}
              selected={tab === "paused"}
              onSelect={() => setTab("paused")}
            />
          </div>
          <div id={`jobs-tabpanel-${tab}`} role="tabpanel" aria-label={`${tab} automations`}>
            <JobList
              jobs={visibleJobs}
              emptyText={emptyText}
              busyJobId={busyAutomationId}
              confirmDeleteJobId={confirmDeleteJobId}
              selectedJobId={selectedJobId}
              onDeleteJob={deleteJob}
              onEditJob={startEditing}
              onRunJobAction={onRunJobAction}
              onToggleDetails={(jobId) =>
                setSelectedJobId((current) => current === jobId ? null : jobId)
              }
            />
          </div>
        </section>

        {selectedJob ? (
          <JobDetail
            job={selectedJob}
            deliveries={matchingDeliveries(selectedJob, deliveries)}
            onOpenDeliveryChat={onOpenDeliveryChat}
          />
        ) : null}

        <section className="jobs-activity-section">
          <p className="eyebrow">Recent activity</p>
          {deliveries.length ? (
            <div className="delivery-list">
              {deliveries.map((delivery) => (
                <DeliveryRow
                  key={delivery.id}
                  delivery={delivery}
                  onAcknowledgeDelivery={onAcknowledgeDelivery}
                  onOpenDeliveryChat={onOpenDeliveryChat}
                />
              ))}
            </div>
          ) : (
            <p className="jobs-empty">Automation deliveries will appear here after jobs run.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function TabButton({
  tabKey,
  label,
  count,
  selected,
  onSelect,
}: {
  tabKey: TabKey;
  label: string;
  count: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`jobs-tab-${tabKey}`}
      aria-controls={`jobs-tabpanel-${tabKey}`}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-jobs-tab={tabKey}
      className={selected ? "jobs-tab selected" : "jobs-tab"}
      onClick={onSelect}
    >
      <span>{label}</span>
      {count > 0 ? <span className="jobs-tab-count">{count}</span> : null}
    </button>
  );
}

function JobList({
  jobs,
  emptyText,
  busyJobId,
  confirmDeleteJobId,
  selectedJobId,
  onDeleteJob,
  onEditJob,
  onRunJobAction,
  onToggleDetails,
}: {
  jobs: HermesAutomation[];
  emptyText: string;
  busyJobId: string | null;
  confirmDeleteJobId: string | null;
  selectedJobId: string | null;
  onDeleteJob: (jobId: string) => void;
  onEditJob: (job: HermesAutomation) => void;
  onRunJobAction: (jobId: string, action: "pause" | "resume" | "run" | "delete") => Promise<string>;
  onToggleDetails: (jobId: string) => void;
}) {
  if (!jobs.length) return <p className="jobs-empty">{emptyText}</p>;

  return (
    <div className="job-list">
      {jobs.map((job) => {
        const busy = busyJobId === job.id;
        const meta = jobMetaLine(job);
        const selected = selectedJobId === job.id;
        return (
          <article
            key={job.id}
            className={selected ? "job-row selected" : "job-row"}
          >
            <div className="job-row-head">
              <div className="job-row-title">
                <span className={`job-status-dot status-${job.status}`} aria-hidden />
                <strong>{job.name}</strong>
              </div>
              <div className="job-row-actions">
                <button
                  type="button"
                  className="icon-button"
                  title="Job details"
                  aria-expanded={selected}
                  aria-controls={`job-detail-${job.id}`}
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleDetails(job.id);
                  }}
                >
                  <Info size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title="Edit"
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    onEditJob(job);
                  }}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title="Run now"
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    void onRunJobAction(job.id, "run");
                  }}
                >
                  <Play size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title={job.status === "paused" ? "Resume" : "Pause"}
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    void onRunJobAction(job.id, job.status === "paused" ? "resume" : "pause");
                  }}
                >
                  {job.status === "paused" ? <Play size={14} /> : <Pause size={14} />}
                </button>
                <button
                  type="button"
                  className={confirmDeleteJobId === job.id ? "icon-button danger pending" : "icon-button danger"}
                  title={confirmDeleteJobId === job.id ? "Confirm delete" : "Delete"}
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    void onDeleteJob(job.id);
                  }}
                >
                  {confirmDeleteJobId === job.id ? <Check size={14} /> : <Trash2 size={14} />}
                </button>
              </div>
            </div>
            {meta ? <p className="job-row-meta">{meta}</p> : null}
            {job.prompt ? <p className="job-row-prompt">{job.prompt}</p> : null}
          </article>
        );
      })}
    </div>
  );
}

function JobDetail({
  job,
  deliveries,
  onOpenDeliveryChat,
}: {
  job: HermesAutomation;
  deliveries: HermesInboxMessage[];
  onOpenDeliveryChat: (delivery: HermesInboxMessage) => void;
}) {
  return (
    <section className="jobs-detail-section" id={`job-detail-${job.id}`}>
      <div className="jobs-detail-heading">
        <div>
          <p className="eyebrow">Job detail</p>
          <h2>{job.name}</h2>
        </div>
        <span className={`jobs-detail-status status-${job.status}`}>{job.status}</span>
      </div>
      <dl className="jobs-detail-grid">
        <div>
          <dt>Schedule</dt>
          <dd>{scheduleDisplay(job) || "Manual"}</dd>
        </div>
        <div>
          <dt>Delivery</dt>
          <dd>{jobDeliveryLabel(job)}</dd>
        </div>
        <div>
          <dt>Runs</dt>
          <dd>{jobRunLabel(job)}</dd>
        </div>
        <div>
          <dt>Next</dt>
          <dd>{job.nextRunAt ? timeLabel(job.nextRunAt) : "Not scheduled"}</dd>
        </div>
      </dl>
      {job.prompt ? <p className="jobs-detail-prompt">{job.prompt}</p> : null}
      {job.lastError || job.lastDeliveryError ? (
        <p className="jobs-detail-error">{job.lastError || job.lastDeliveryError}</p>
      ) : null}
      <div className="jobs-detail-history">
        <p className="eyebrow">Run history</p>
        {deliveries.length ? (
          <div className="delivery-list compact">
            {deliveries.map((delivery) => (
              <DeliveryRow
                key={delivery.id}
                delivery={delivery}
                onAcknowledgeDelivery={() => undefined}
                onOpenDeliveryChat={onOpenDeliveryChat}
                compact
              />
            ))}
          </div>
        ) : (
          <p className="jobs-empty compact">No deliveries matched this job yet.</p>
        )}
      </div>
    </section>
  );
}

function DeliveryRow({
  delivery,
  compact = false,
  onAcknowledgeDelivery,
  onOpenDeliveryChat,
}: {
  delivery: HermesInboxMessage;
  compact?: boolean;
  onAcknowledgeDelivery: (messageId: string) => void;
  onOpenDeliveryChat: (delivery: HermesInboxMessage) => void;
}) {
  return (
    <article className={compact ? "delivery-row compact" : "delivery-row"}>
      <div className="delivery-row-main">
        <p>{delivery.content}</p>
        <span>
          <button type="button" className="inline-link" onClick={() => onOpenDeliveryChat(delivery)}>
            {delivery.chatId || "Open chat"}
          </button>
          {" · "}
          {timeLabel(delivery.createdAt)}
        </span>
      </div>
      {!compact && !delivery.acknowledgedAt ? (
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

function jobMetaLine(job: HermesAutomation) {
  return [scheduleDisplay(job) || "Manual", jobDeliveryLabel(job), jobTimelineLabel(job), jobRunLabel(job)]
    .filter(Boolean)
    .join(" · ");
}

function jobDeliveryLabel(job: HermesAutomation) {
  if (job.projectId) return "Project";
  if (job.deliverToSessionId) return "No project";
  return job.deliver || "No project";
}

function jobTimelineLabel(job: HermesAutomation) {
  if (job.status === "active" && job.nextRunAt) return `Next ${timeLabel(job.nextRunAt)}`;
  if (job.lastRunAt) return `Last ${timeLabel(job.lastRunAt)}`;
  if (job.status === "error") return "Error";
  if (job.status === "paused") return "Paused";
  return job.status;
}

function jobRunLabel(job: HermesAutomation) {
  const runPart = job.repeat
    ? `${job.runCount}/${job.repeat}`
    : `${job.runCount} run${job.runCount === 1 ? "" : "s"}`;
  const statusPart = job.lastError || job.lastDeliveryError || job.lastStatus;
  return statusPart ? `${runPart} · ${statusPart}` : runPart;
}

export function automationScheduleValue({
  scheduleMode,
  minutes,
  runAt,
  dailyTime,
  customSchedule,
}: {
  scheduleMode: ScheduleMode;
  minutes: number;
  runAt: string;
  dailyTime: string;
  customSchedule: string;
}) {
  if (scheduleMode === "delay") return `${Math.max(1, Math.floor(minutes || 1))}m`;
  if (scheduleMode === "datetime") return localInputToIso(runAt);
  if (scheduleMode === "daily") {
    const [hours = "9", minutes = "0"] = (dailyTime || "09:00").split(":");
    return `${Number(minutes) || 0} ${Number(hours) || 9} * * *`;
  }
  return customSchedule.trim();
}

function repeatValue(repeatMode: RepeatMode, repeatCount: number) {
  if (repeatMode === "forever") return null;
  if (repeatMode === "count") return Math.max(1, Math.floor(repeatCount || 1));
  return 1;
}

function schedulePreview(input: {
  scheduleMode: ScheduleMode;
  minutes: number;
  runAt: string;
  dailyTime: string;
  customSchedule: string;
  repeatMode: RepeatMode;
  repeatCount: number;
}) {
  const repeatLabel =
    input.repeatMode === "forever"
      ? "and keep repeating until paused"
      : input.repeatMode === "count"
        ? `for ${Math.max(1, Math.floor(input.repeatCount || 1))} runs`
        : "once";
  if (input.scheduleMode === "delay") {
    const date = new Date(Date.now() + Math.max(1, Math.floor(input.minutes || 1)) * 60 * 1000);
    return `Will deliver ${timeLabel(Math.floor(date.getTime() / 1000))}, ${repeatLabel}.`;
  }
  if (input.scheduleMode === "datetime") {
    const date = new Date(input.runAt);
    return Number.isNaN(date.getTime())
      ? "Choose a date and time."
      : `Will deliver ${timeLabel(Math.floor(date.getTime() / 1000))}, ${repeatLabel}.`;
  }
  if (input.scheduleMode === "daily") {
    return `Will deliver next at ${nextDailyLabel(input.dailyTime)}, ${repeatLabel}.`;
  }
  return input.customSchedule.trim()
    ? `Runtime schedule: ${input.customSchedule.trim()}, ${repeatLabel}.`
    : "Enter a custom schedule.";
}

function nextDailyLabel(time: string) {
  const [hours = "9", minutes = "0"] = time.split(":");
  const next = new Date();
  next.setHours(Number(hours) || 9, Number(minutes) || 0, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return timeLabel(Math.floor(next.getTime() / 1000));
}

export function automationFormStateFromJob(job: HermesAutomation) {
  const schedule = scheduleEditValue(job);
  const delayMatch = schedule.match(/^(\d+)m$/i);
  const dailyMatch = schedule.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  const date = Date.parse(schedule);
  const dailyTime = dailyMatch
    ? `${dailyMatch[2].padStart(2, "0")}:${dailyMatch[1].padStart(2, "0")}`
    : "09:00";
  return {
    name: job.name || "",
    prompt: job.prompt || "",
    scheduleMode: delayMatch ? "delay" as ScheduleMode : dailyMatch ? "daily" as ScheduleMode : Number.isFinite(date) ? "datetime" as ScheduleMode : "custom" as ScheduleMode,
    minutes: delayMatch ? Number(delayMatch[1]) : 10,
    runAt: Number.isFinite(date) ? dateTimeLocalValue(date) : dateTimeLocalValue(Date.now() + 10 * 60 * 1000),
    dailyTime,
    customSchedule: delayMatch || dailyMatch || Number.isFinite(date) ? schedule || "tomorrow at 9am" : schedule,
    repeatMode: job.repeat == null ? "forever" as RepeatMode : job.repeat === 1 ? "once" as RepeatMode : "count" as RepeatMode,
    repeatCount: job.repeat && job.repeat > 1 ? job.repeat : 5,
  };
}

function dateTimeLocalValue(value: number) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function localInputToIso(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function matchingDeliveries(job: HermesAutomation, deliveries: HermesInboxMessage[]) {
  const jobIds = new Set([
    job.id,
    stringValue(job.raw.externalJobId),
    stringValue(job.raw.jobId),
    stringValue(job.raw.job_id),
  ].filter(Boolean));
  const deliverChatId = job.resolvedDeliveryTarget?.chatId || job.deliver.replace(/^iris:/, "");
  const deliverySessionId = job.resolvedDeliveryTarget?.sessionId || job.deliverToSessionId;
  return deliveries.filter((delivery) => {
    const metadata = delivery.metadata || {};
    return (
      jobIds.has(stringValue(metadata.automationId)) ||
      jobIds.has(stringValue(metadata.jobId)) ||
      jobIds.has(stringValue(metadata.job_id)) ||
      Boolean(deliverChatId && delivery.chatId === deliverChatId) ||
      Boolean(deliverySessionId && stringValue(metadata.agentuiSessionId) === deliverySessionId)
    );
  });
}

function scheduleDisplay(job: HermesAutomation) {
  return job.schedule.display;
}

function scheduleEditValue(job: HermesAutomation) {
  if (job.schedule.kind === "cron" && job.schedule.expr) return job.schedule.expr;
  if (job.schedule.kind === "once" && job.schedule.runAt) return job.schedule.runAt;
  return job.schedule.display;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function isFailure(message: string) {
  return /\b(error|failed|could not|enter|required|invalid)\b/i.test(message);
}
