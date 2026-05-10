import { describe, expect, it } from "vitest";
import { automationRequestPayload, normalizeDeliveryTarget, normalizeJobsResult } from "../useIrisAutomations";

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
          deliver: "iris:desktop",
        },
      ],
    });

    expect(jobs[0]).toMatchObject({
      id: "668d9c4cce40",
      schedule: "once in 1m",
      status: "active",
      repeat: 1,
      runCount: 0,
      deliver: "iris:desktop",
    });
    expect(jobs[0].nextRunAt).toBeGreaterThan(0);
  });

  it("keeps completed Hermes metadata for history cards", () => {
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
          schedule_display: "daily at 09:00",
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
      deliver: "iris:desktop",
    });
  });

  it("normalizes Core automations into job cards", () => {
    const jobs = normalizeJobsResult({
      automations: [
        {
          id: "auto_1",
          externalJobId: "job-1",
          name: "Core reminder",
          schedule: "10m",
          prompt: "Reply exactly with this message: hello",
          status: "active",
          nextRunAt: 1_777_777_777,
          metadata: {
            deliver: "iris:core-session_1",
            repeat: 1,
          },
        },
      ],
    });

    expect(jobs[0]).toMatchObject({
      id: "auto_1",
      name: "Core reminder",
      schedule: "10m",
      status: "active",
      deliver: "iris:core-session_1",
      repeat: 1,
      nextRunAt: 1_777_777_777,
    });
  });

  it("builds named recurring automation payloads without a finite repeat", () => {
    expect(
      automationRequestPayload(
        {
          name: "Morning standup",
          prompt: "Send the morning standup note.",
          schedule: "daily at 09:00",
          repeat: null,
          deliver: "iris:desktop",
        },
        "iris:fallback",
        "default",
      ),
    ).toMatchObject({
      name: "Morning standup",
      prompt: "Send the morning standup note.",
      schedule: "daily at 09:00",
      deliver: "iris:desktop",
      metadata: {
        kind: "scheduled-message",
        profile: "default",
      },
    });
  });

  it("keeps legacy minute-based scheduled messages compatible", () => {
    expect(
      automationRequestPayload(
        { message: "Hydrate", minutes: 10 },
        "iris:desktop",
        "default",
      ),
    ).toMatchObject({
      name: "Iris reminder",
      schedule: "10m",
      prompt: "Reply exactly with this message: Hydrate",
      repeat: 1,
      deliver: "iris:desktop",
    });
  });

  it("normalizes legacy AgentUI delivery targets to Iris targets", () => {
    expect(normalizeDeliveryTarget("agentui:desktop")).toBe("iris:desktop");
    expect(normalizeDeliveryTarget(" agentui:core-chat-1 ")).toBe("iris:core-chat-1");
    expect(normalizeDeliveryTarget("iris:desktop")).toBe("iris:desktop");
    expect(normalizeDeliveryTarget("")).toBe("iris:desktop");
  });
});
