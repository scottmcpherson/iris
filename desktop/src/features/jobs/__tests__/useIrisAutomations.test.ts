import { describe, expect, it } from "vitest";
import { normalizeJobsResult } from "../useIrisAutomations";

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
          deliver: "agentui:desktop",
        },
      ],
    });

    expect(jobs[0]).toMatchObject({
      id: "668d9c4cce40",
      schedule: "once in 1m",
      status: "active",
      repeat: 1,
      runCount: 0,
      deliver: "agentui:desktop",
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
          deliver: "agentui:desktop",
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
            deliver: "agentui:core-conv_1",
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
      deliver: "agentui:core-conv_1",
      repeat: 1,
      nextRunAt: 1_777_777_777,
    });
  });
});
