import { describe, expect, it } from "vite-plus/test";
import { AGENT_COMPLETION_DISPLAY_MS, hasRecentAgentCompletion } from "./agentActivity";

const completedAt = "2026-10-10T10:00:00.000Z";
const completedMs = Date.parse(completedAt);

describe("agent completion status", () => {
  it("shows a successful completion briefly, then clears it at the deadline", () => {
    const run = { status: "completed" as const, completedAt };
    expect(hasRecentAgentCompletion(run, completedMs)).toBe(true);
    expect(hasRecentAgentCompletion(run, completedMs + AGENT_COMPLETION_DISPLAY_MS - 1)).toBe(true);
    expect(hasRecentAgentCompletion(run, completedMs + AGENT_COMPLETION_DISPLAY_MS)).toBe(false);
  });

  it("does not label failed, interrupted, or cancelled work Done", () => {
    for (const status of ["failed", "interrupted", "cancelled"] as const) {
      expect(hasRecentAgentCompletion({ status, completedAt }, completedMs)).toBe(false);
    }
  });

  it("ignores missing, malformed, and future completion timestamps", () => {
    expect(hasRecentAgentCompletion(null, completedMs)).toBe(false);
    expect(hasRecentAgentCompletion({ status: "completed", completedAt: null }, completedMs)).toBe(
      false,
    );
    expect(
      hasRecentAgentCompletion({ status: "completed", completedAt: "invalid" }, completedMs),
    ).toBe(false);
    expect(hasRecentAgentCompletion({ status: "completed", completedAt }, completedMs - 1)).toBe(
      false,
    );
  });
});
