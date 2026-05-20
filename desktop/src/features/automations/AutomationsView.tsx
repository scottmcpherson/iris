import { useState } from "react";
import type { FormEvent } from "react";
import { AlertCircle, Check, Info, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import type { CreateScheduledMessageInput, UpdateScheduledMessageInput } from "./useIrisAutomations";
import { ProjectMenu } from "../chat/components/ProjectMenu";
import type { IrisProject } from "../../lib/irisCore";
import type { HermesAutomation, HermesInboxMessage } from "../../types/hermes";
import { Alert, AlertDescription } from "../../shared/ui/alert";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, CardContent, CardHeader } from "../../shared/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../shared/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "../../shared/ui/field";
import { Input } from "../../shared/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../shared/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../shared/ui/tabs";
import { Textarea } from "../../shared/ui/textarea";
import type { RuntimeReadiness } from "../../app/runtimeReadiness";
import { runtimeReadinessDetail, runtimeReadinessGatewayAction } from "../../app/runtimeReadiness";

type TabKey = "active" | "paused";
type ScheduleMode = "delay" | "datetime" | "daily" | "custom";
type RepeatMode = "once" | "forever" | "count";

type AutomationsViewProps = {
  activeAutomations: HermesAutomation[];
  busyAutomationId: string | null;
  connected: boolean;
  deliveries: HermesInboxMessage[];
  deliveriesLoading: boolean;
  error: string | null;
  pausedAutomations: HermesAutomation[];
  runtimeReadiness?: RuntimeReadiness;
  gatewayActionBusy?: boolean;
  gatewayActionBusyAction?: "start" | "restart" | "stop" | null;
  projects: IrisProject[];
  selectedProjectId: string | null;
  onAcknowledgeDelivery: (messageId: string) => void;
  onCreateScheduledMessage: (input: CreateScheduledMessageInput) => Promise<string>;
  onOpenDeliveryChat: (delivery: HermesInboxMessage) => void;
  onProjectChange: (projectId: string | null) => void;
  onGatewayAction?: (action: "start" | "restart") => void;
  onRunJobAction: (jobId: string, action: "pause" | "resume" | "run" | "delete") => Promise<string>;
  onUpdateScheduledMessage: (jobId: string, input: UpdateScheduledMessageInput) => Promise<string>;
};

export function AutomationsView({
  activeAutomations,
  busyAutomationId,
  connected,
  deliveries,
  deliveriesLoading,
  error,
  pausedAutomations,
  runtimeReadiness = connected ? "ready" : "offline",
  gatewayActionBusy = false,
  gatewayActionBusyAction = null,
  projects,
  selectedProjectId,
  onAcknowledgeDelivery,
  onCreateScheduledMessage,
  onOpenDeliveryChat,
  onProjectChange,
  onGatewayAction = () => {},
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
  const runtimeReady = runtimeReadiness === "ready";
  const runtimeAction = runtimeReadinessGatewayAction(runtimeReadiness);
  const runtimeNotice = runtimeReadinessDetail(runtimeReadiness);
  const runtimeActionLabel = gatewayActionLabel(runtimeAction, gatewayActionBusy, gatewayActionBusyAction);

  async function submitSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!runtimeReady) {
      setFormNotice(runtimeNotice || "Runtime is not ready.");
      return;
    }
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
            disabled={!runtimeReady}
            onClick={startCreating}
          >
            <Plus data-icon="inline-start" />
          </Button>
        </div>
      </header>

      <div className="jobs-body">
        {error ? (
          <Alert variant="destructive" className="jobs-alert">
            <AlertCircle />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {!runtimeReady ? (
          <Alert tone="degraded">
            <AlertCircle />
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2.5 text-current">
              <span>{runtimeNotice}</span>
              {runtimeAction ? (
                <Button
                  type="button"
                  variant="appNeutral"
                  size="appSmall"
                  disabled={gatewayActionBusy}
                  onClick={() => onGatewayAction(runtimeAction)}
                >
                  {runtimeActionLabel}
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {formOpen ? (
          <Dialog
            open={formOpen}
            onOpenChange={(open) => {
              if (!open && formBusy) return;
              if (!open) cancelEditing();
            }}
          >
            <DialogContent
              className="jobs-create-card jobs-modal-card"
              showCloseButton={false}
              onEscapeKeyDown={(event) => {
                if (formBusy) event.preventDefault();
              }}
              onPointerDownOutside={(event) => {
                if (formBusy) event.preventDefault();
              }}
            >
              <DialogHeader className="jobs-create-heading">
                <div>
                  <p className="eyebrow">Automation</p>
                  <DialogTitle>{editingJobId ? "Edit automation" : "New automation"}</DialogTitle>
                  <DialogDescription className="sr-only">
                    Schedule a prompt for Iris to deliver later.
                  </DialogDescription>
                </div>
              </DialogHeader>
              <form className="jobs-form" onSubmit={submitSchedule}>
                <FieldGroup className="jobs-form-grid">
                  {/* Mirrors Hermes _MAX_NAME_LENGTH=200 and _MAX_PROMPT_LENGTH=5000. */}
                  <Field className="jobs-form-field jobs-form-prompt">
                    <FieldLabel>Name</FieldLabel>
                    <Input
                      value={name}
                      placeholder="Morning standup"
                      maxLength={200}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </Field>
                  <Field className="jobs-form-field jobs-form-prompt">
                    <FieldLabel>Prompt</FieldLabel>
                    <Textarea
                      value={prompt}
                      placeholder="Send a concise morning standup reminder."
                      maxLength={5000}
                      onChange={(event) => setPrompt(event.target.value)}
                    />
                  </Field>
                  <Field className="jobs-form-field jobs-form-prompt">
                    <FieldLabel>Schedule</FieldLabel>
                    <Select value={scheduleMode} onValueChange={(value) => setScheduleMode(value as ScheduleMode)}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="delay">In minutes</SelectItem>
                          <SelectItem value="datetime">Date and time</SelectItem>
                          <SelectItem value="daily">Daily time</SelectItem>
                          <SelectItem value="custom">Custom</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field className="jobs-form-field jobs-project-field">
                    <FieldLabel>Project</FieldLabel>
                    <div className="composer-project-menu-wrap jobs-project-menu-wrap">
                      <ProjectMenu
                        projects={projects}
                        selectedProjectId={selectedProjectId}
                        open={projectMenuOpen}
                        disabled={!connected || !runtimeReady}
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
                  </Field>
                  {scheduleMode === "delay" ? (
                    <Field className="jobs-form-field jobs-form-wide-control">
                      <FieldLabel>Minutes</FieldLabel>
                      <Input
                        type="number"
                        min={1}
                        max={10080}
                        value={minutes}
                        onChange={(event) => setMinutes(Number(event.target.value) || 1)}
                      />
                    </Field>
                  ) : null}
                  {scheduleMode === "datetime" ? (
                    <Field className="jobs-form-field jobs-form-wide-control">
                      <FieldLabel>Run at</FieldLabel>
                      <Input type="datetime-local" value={runAt} onChange={(event) => setRunAt(event.target.value)} />
                    </Field>
                  ) : null}
                  {scheduleMode === "daily" ? (
                    <Field className="jobs-form-field jobs-form-wide-control">
                      <FieldLabel>Time</FieldLabel>
                      <Input type="time" value={dailyTime} onChange={(event) => setDailyTime(event.target.value)} />
                    </Field>
                  ) : null}
                  {scheduleMode === "custom" ? (
                    <Field className="jobs-form-field jobs-form-wide-control">
                      <FieldLabel>Custom schedule</FieldLabel>
                      <Input
                        value={customSchedule}
                        placeholder="tomorrow at 9am or cron: 0 9 * * 1-5"
                        onChange={(event) => setCustomSchedule(event.target.value)}
                      />
                    </Field>
                  ) : null}
                  <Field className="jobs-form-field">
                    <FieldLabel>Repeat</FieldLabel>
                    <Select value={repeatMode} onValueChange={(value) => setRepeatMode(value as RepeatMode)}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="once">Once</SelectItem>
                          <SelectItem value="forever">Until paused</SelectItem>
                          <SelectItem value="count">Fixed count</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  {repeatMode === "count" ? (
                    <Field className="jobs-form-field">
                      <FieldLabel>Runs</FieldLabel>
                      <Input
                        type="number"
                        min={1}
                        max={999}
                        value={repeatCount}
                        onChange={(event) => setRepeatCount(Number(event.target.value) || 1)}
                      />
                    </Field>
                  ) : null}
                </FieldGroup>
                <div className="jobs-form-footer">
                  <div className="jobs-form-status">
                    <FieldDescription className="jobs-schedule-preview">{preview}</FieldDescription>
                    {formNotice ? (
                      <Alert
                        variant={isFailure(formNotice) ? "destructive" : "default"}
                        className={isFailure(formNotice) ? "jobs-form-notice error" : "jobs-form-notice"}
                      >
                        <AlertDescription>{formNotice}</AlertDescription>
                      </Alert>
                    ) : null}
                  </div>
                  <div className="jobs-form-action">
                    <Button type="button" variant="appNeutral" size="appSmall" onClick={cancelEditing} disabled={formBusy}>
                      Cancel
                    </Button>
                    <Button type="submit" size="appSmall" disabled={formBusy || !runtimeReady}>
                      {formBusy ? "Saving..." : editingJobId ? "Save changes" : "Create"}
                    </Button>
                  </div>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        ) : null}

        <section className="jobs-list-section">
          <Tabs value={tab} onValueChange={(value) => setTab(value as TabKey)} className="gap-2">
            <TabsList
              aria-label="Automation status"
              className="h-[34px] border border-menu-border bg-secondary p-0"
            >
              <TabsTrigger
                value="active"
                className="min-w-[76px] gap-[7px] rounded-[7px] px-3"
              >
                <span>Active</span>
                {activeAutomations.length > 0 ? (
                  <Badge variant="secondary" className="bg-background/35 px-1.5 py-px text-[11px] font-extrabold text-menu-muted-foreground">
                    {activeAutomations.length}
                  </Badge>
                ) : null}
              </TabsTrigger>
              <TabsTrigger
                value="paused"
                className="min-w-[76px] gap-[7px] rounded-[7px] px-3"
              >
                <span>Paused</span>
                {pausedAutomations.length > 0 ? (
                  <Badge variant="secondary" className="bg-background/35 px-1.5 py-px text-[11px] font-extrabold text-menu-muted-foreground">
                    {pausedAutomations.length}
                  </Badge>
                ) : null}
              </TabsTrigger>
            </TabsList>
            <TabsContent value={tab} className="m-0">
              <JobList
                jobs={visibleJobs}
                emptyText={emptyText}
                runtimeReady={runtimeReady}
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
            </TabsContent>
          </Tabs>
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
            <AutomationEmptyState>{automationActivityEmptyText(deliveriesLoading)}</AutomationEmptyState>
          )}
        </section>
      </div>
    </div>
  );
}

export function automationActivityEmptyText(loading: boolean) {
  return loading ? "Loading recent activity..." : "Automation deliveries will appear here after jobs run.";
}

function JobList({
  jobs,
  emptyText,
  runtimeReady,
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
  runtimeReady: boolean;
  busyJobId: string | null;
  confirmDeleteJobId: string | null;
  selectedJobId: string | null;
  onDeleteJob: (jobId: string) => void;
  onEditJob: (job: HermesAutomation) => void;
  onRunJobAction: (jobId: string, action: "pause" | "resume" | "run" | "delete") => Promise<string>;
  onToggleDetails: (jobId: string) => void;
}) {
  if (!jobs.length) return <AutomationEmptyState>{emptyText}</AutomationEmptyState>;

  return (
    <div className="job-list">
      {jobs.map((job) => {
        const busy = busyJobId === job.id || !runtimeReady;
        const meta = jobMetaLine(job);
        const selected = selectedJobId === job.id;
        return (
          <Card
            key={job.id}
            className={selected ? "job-row selected" : "job-row"}
          >
            <CardHeader className="job-row-head">
              <div className="job-row-title">
                <span className={`job-status-dot status-${job.status}`} aria-hidden />
                <strong>{job.name}</strong>
              </div>
              <div className="job-row-actions">
                <Button
                  type="button"
                  variant="appIcon"
                  size="icon-md"
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
                </Button>
                <Button
                  type="button"
                  variant="appIcon"
                  size="icon-md"
                  title="Edit"
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    onEditJob(job);
                  }}
                >
                  <Pencil size={14} />
                </Button>
                <Button
                  type="button"
                  variant="appIcon"
                  size="icon-md"
                  title="Run now"
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    void onRunJobAction(job.id, "run");
                  }}
                >
                  <Play size={14} />
                </Button>
                <Button
                  type="button"
                  variant="appIcon"
                  size="icon-md"
                  title={job.status === "paused" ? "Resume" : "Pause"}
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    void onRunJobAction(job.id, job.status === "paused" ? "resume" : "pause");
                  }}
                >
                  {job.status === "paused" ? <Play size={14} /> : <Pause size={14} />}
                </Button>
                <Button
                  type="button"
                  variant={confirmDeleteJobId === job.id ? "appIconConfirm" : "appIconDanger"}
                  size="icon-md"
                  title={confirmDeleteJobId === job.id ? "Confirm delete" : "Delete"}
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    void onDeleteJob(job.id);
                  }}
                >
                  {confirmDeleteJobId === job.id ? <Check size={14} /> : <Trash2 size={14} />}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="job-row-content">
              {meta ? <p className="job-row-meta">{meta}</p> : null}
              {job.prompt ? <p className="job-row-prompt">{job.prompt}</p> : null}
            </CardContent>
          </Card>
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
    <Card className="jobs-detail-section" id={`job-detail-${job.id}`}>
      <CardHeader className="jobs-detail-heading">
        <div>
          <p className="eyebrow">Job detail</p>
          <h2>{job.name}</h2>
        </div>
        <Badge variant="secondary" className={`jobs-detail-status status-${job.status}`}>{job.status}</Badge>
      </CardHeader>
      <CardContent className="jobs-detail-content">
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
          <Alert variant="destructive" className="jobs-detail-error">
            <AlertDescription>{job.lastError || job.lastDeliveryError}</AlertDescription>
          </Alert>
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
            <AutomationEmptyState compact>No deliveries matched this job yet.</AutomationEmptyState>
          )}
        </div>
      </CardContent>
    </Card>
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
    <Card className={compact ? "delivery-row compact" : "delivery-row"}>
      <div className="delivery-row-main">
        <p className="delivery-row-content">{delivery.content}</p>
        <span className="delivery-row-meta">
          <Button type="button" variant="appLink" onClick={() => onOpenDeliveryChat(delivery)}>
            {delivery.chatId || "Open chat"}
          </Button>
          {" · "}
          {timeLabel(delivery.createdAt)}
        </span>
      </div>
      {!compact && !delivery.acknowledgedAt ? (
        <Button
          type="button"
          variant="appIcon"
          size="icon-md"
          title="Mark as read"
          onClick={() => onAcknowledgeDelivery(delivery.id)}
        >
          <Check size={15} />
        </Button>
      ) : null}
    </Card>
  );
}

function AutomationEmptyState({ children, compact = false }: { children: string; compact?: boolean }) {
  return (
    <Empty className={compact ? "jobs-empty compact" : "jobs-empty"}>
      <EmptyHeader>
        <EmptyTitle>{children}</EmptyTitle>
        {!compact ? <EmptyDescription>Scheduled deliveries and activity remain available once they exist.</EmptyDescription> : null}
      </EmptyHeader>
    </Empty>
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

function gatewayActionLabel(
  action: "start" | "restart" | null,
  busy: boolean,
  busyAction: "start" | "restart" | "stop" | null,
) {
  if (action === "start") return busy && busyAction === "start" ? "Starting gateway..." : "Start gateway";
  if (action === "restart") return busy && busyAction === "restart" ? "Restarting gateway..." : "Restart gateway";
  return "";
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
      Boolean(deliverySessionId && stringValue(metadata.irisSessionId) === deliverySessionId)
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
