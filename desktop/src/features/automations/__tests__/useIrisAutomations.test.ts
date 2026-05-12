import { describe, expect, it } from "vitest";
import { automationRequestPayload, normalizeDeliveryTarget, normalizeJobsResult } from "../useIrisAutomations";
import { automationFormStateFromJob, automationScheduleValue, matchingDeliveries } from "../AutomationsView";

describe("runtime jobs helpers", () => {
  it("treats scheduled runtime jobs as active", () => {
    const jobs = normalizeJobsResult({
      jobs: [
        {
          id: "668d9c4cce40",
          name: "Iris reminder",
          prompt: "Reply exactly with this message: hello",
          schedule: {
            kind: "once",
            run_at: "2026-05-05T05:58:14.423690-04:00",
            display: "once in 1m",
          },
          schedule_display: "once in 1m",
          repeat: {
            times: 1,
            completed: 0,
          },
          enabled: true,
          state: "scheduled",
          next_run_at: "2026-05-05T05:58:14.423690-04:00",
          last_run_at: null,
          deliver: "iris:automation-chat_123",
          deliverToSessionId: "session_auto_1",
        },
      ],
    });

    expect(jobs[0]).toMatchObject({
      id: "668d9c4cce40",
      schedule: {
        kind: "once",
        display: "once in 1m",
        runAt: "2026-05-05T05:58:14.423690-04:00",
      },
      status: "active",
      enabled: true,
      repeat: 1,
      runCount: 0,
      deliver: "iris:automation-chat_123",
      deliverToSessionId: "session_auto_1",
      projectId: null,
    });
    expect(jobs[0].nextRunAt).toBeGreaterThan(0);
  });

  it("preserves completed Hermes metadata without creating a completed bucket", () => {
    const jobs = normalizeJobsResult({
      jobs: [
        {
          id: "done-1",
          name: "Done",
          state: "completed",
          schedule_display: "once in 1m",
          repeat: {
            times: 1,
            completed: 1,
          },
          last_run_at: "2026-05-05T05:59:00-04:00",
          last_status: "success",
          last_error: null,
          deliver: "iris:desktop",
        },
      ],
    });

    expect(jobs[0]).toMatchObject({
      status: "completed",
      runCount: 1,
      repeat: 1,
      lastStatus: "success",
    });
    expect(jobs[0].lastRunAt).toBeGreaterThan(0);
  });

  it("keeps disabled Hermes jobs visible as paused", () => {
    const jobs = normalizeJobsResult({
      jobs: [
        {
          id: "paused-1",
          name: "Paused reminder",
          schedule: {
            kind: "cron",
            expr: "0 9 * * *",
            display: "daily at 09:00",
          },
          enabled: false,
          state: "paused",
          next_run_at: "2026-05-10T09:00:00-04:00",
          deliver: "iris:desktop",
        },
      ],
    });

    expect(jobs[0]).toMatchObject({
      id: "paused-1",
      name: "Paused reminder",
      status: "paused",
      enabled: false,
      deliver: "iris:desktop",
    });
  });

  it("normalizes Core automations into job cards", () => {
    const jobs = normalizeJobsResult({
      automations: [
        {
          id: "job-1",
          externalJobId: "job-1",
          name: "Core reminder",
          schedule: "10m",
          prompt: "Reply exactly with this message: hello",
          status: "active",
          nextRunAt: 1_777_777_777,
          metadata: {
            deliver: "iris:core-session_1",
            repeat: 1,
            runtimeJob: {
              id: "job-1",
              schedule: {
                kind: "interval",
                minutes: 10,
                display: "every 10m",
              },
            },
          },
        },
      ],
    });

    expect(jobs[0]).toMatchObject({
      id: "job-1",
      name: "Core reminder",
      schedule: {
        kind: "interval",
        display: "every 10m",
        minutes: 10,
      },
      status: "active",
      deliver: "iris:core-session_1",
      repeat: 1,
      nextRunAt: 1_777_777_777,
    });
  });

  it("preserves rich Hermes automation fields", () => {
    const jobs = normalizeJobsResult({
      jobs: [
        {
          id: "rich-job",
          name: "Rich job",
          prompt: "Use a skill",
          schedule: { kind: "cron", expr: "30 8 * * 1-5", display: "weekdays at 8:30" },
          state: "scheduled",
          enabled: true,
          deliver: "iris:desktop",
          skills: ["summarizer"],
          skill: "summarizer",
          script: "echo hi",
          no_agent: true,
          context_from: ["project"],
          workdir: "/tmp/project",
          enabled_toolsets: ["shell", "files"],
          model: "gpt-5.5",
          provider: "openai",
          base_url: "https://api.example.test",
        },
      ],
    });

    expect(jobs[0]).toMatchObject({
      id: "rich-job",
      skills: ["summarizer"],
      skill: "summarizer",
      script: "echo hi",
      noAgent: true,
      contextFrom: ["project"],
      workdir: "/tmp/project",
      enabledToolsets: ["shell", "files"],
      model: "gpt-5.5",
      provider: "openai",
      baseUrl: "https://api.example.test",
      schedule: {
        kind: "cron",
        expr: "30 8 * * 1-5",
      },
    });
  });

  it("builds named recurring automation payloads without a finite repeat", () => {
    expect(
      automationRequestPayload(
        {
          name: "Morning standup",
          prompt: "Send the morning standup note.",
          schedule: "0 9 * * *",
          repeat: null,
          projectId: "project_1",
        },
        "default",
      ),
    ).toMatchObject({
      name: "Morning standup",
      prompt: "Send the morning standup note.",
      schedule: "0 9 * * *",
      projectId: "project_1",
    });
    expect(
      automationRequestPayload(
        {
          name: "Morning standup",
          prompt: "Send the morning standup note.",
          schedule: "0 9 * * *",
          repeat: null,
          projectId: null,
        },
        "default",
      ),
    ).not.toHaveProperty("metadata");
  });

  it("keeps legacy minute-based scheduled messages compatible", () => {
    expect(
      automationRequestPayload(
        { message: "Hydrate", minutes: 10 },
        "default",
      ),
    ).toMatchObject({
      name: "Iris reminder",
      schedule: "10m",
      prompt: "Reply exactly with this message: Hydrate",
      repeat: 1,
      projectId: null,
    });
  });

  it("normalizes legacy AgentUI delivery targets to Iris targets", () => {
    expect(normalizeDeliveryTarget("agentui:desktop")).toBe("iris:desktop");
    expect(normalizeDeliveryTarget(" agentui:core-chat-1 ")).toBe("iris:core-chat-1");
    expect(normalizeDeliveryTarget("iris:desktop")).toBe("iris:desktop");
    expect(normalizeDeliveryTarget("")).toBe("iris:desktop");
  });

  it("round-trips daily schedule mode through cron", () => {
    const schedule = automationScheduleValue({
      scheduleMode: "daily",
      minutes: 10,
      runAt: "2026-05-12T09:00",
      dailyTime: "09:05",
      customSchedule: "",
    });

    expect(schedule).toBe("5 9 * * *");
    expect(
      automationFormStateFromJob({
        id: "daily-job",
        name: "Daily",
        schedule: { kind: "cron", display: "daily at 9:05 AM", expr: schedule },
        prompt: "Prompt",
        deliver: "iris:desktop",
        deliverToSessionId: "session_auto",
        projectId: null,
        status: "active",
        enabled: true,
        nextRunAt: null,
        lastRunAt: null,
        lastStatus: "",
        lastError: "",
        lastDeliveryError: "",
        runCount: 0,
        repeat: null,
        skills: [],
        skill: null,
        script: null,
        noAgent: false,
        contextFrom: [],
        workdir: null,
        enabledToolsets: null,
        model: null,
        provider: null,
        baseUrl: null,
        createdAt: null,
        raw: {},
      }),
    ).toMatchObject({
      scheduleMode: "daily",
      dailyTime: "09:05",
    });
  });

  it("matches deliveries by automation metadata before falling back to delivery chat", () => {
    const job = normalizeJobsResult({
      jobs: [
        {
          id: "job-123",
          name: "Matcher",
          schedule_display: "once in 1m",
          state: "scheduled",
          deliver: "iris:desktop",
        },
      ],
    })[0];
    const deliveries = [
      delivery("direct", { automationId: "job-123" }, "other"),
      delivery("job-id", { jobId: "job-123" }, "other"),
      delivery("job_id", { job_id: "job-123" }, "other"),
      delivery("chat", {}, "desktop"),
      delivery("miss", {}, "another"),
    ];

    expect(matchingDeliveries(job, deliveries).map((item) => item.id)).toEqual([
      "direct",
      "job-id",
      "job_id",
      "chat",
    ]);
  });
});

function delivery(id: string, metadata: Record<string, unknown>, chatId: string) {
  return {
    cursor: 1,
    id,
    source: "hermes-cron",
    platform: "iris",
    profile: "default",
    chatId,
    content: "Delivered",
    metadata,
    createdAt: 1_777_777_777,
    acknowledgedAt: null,
  };
}
