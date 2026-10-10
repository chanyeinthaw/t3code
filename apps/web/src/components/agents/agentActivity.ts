import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export const AGENT_COMPLETION_DISPLAY_MS = 30_000;

/** Successful turns briefly show Done, including when the agent chat is already open. */
export function hasRecentAgentCompletion(
  run: Pick<NonNullable<EnvironmentThreadShell["latestRun"]>, "status" | "completedAt"> | null,
  now: number,
) {
  if (run?.status !== "completed" || run.completedAt === null) return false;
  const age = now - Date.parse(run.completedAt);
  return age >= 0 && age < AGENT_COMPLETION_DISPLAY_MS;
}
