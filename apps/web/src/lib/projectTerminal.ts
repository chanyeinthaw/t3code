import { ProjectId, ThreadId, type ProjectId as ProjectIdType } from "@pulse/contracts";

const PROJECT_TERMINAL_THREAD_PREFIX = "project-terminal:";

export function projectTerminalThreadId(projectId: ProjectIdType): ThreadId {
  return ThreadId.make(`${PROJECT_TERMINAL_THREAD_PREFIX}${projectId}`);
}

export function isProjectTerminalThreadId(threadId: string): boolean {
  return threadId.startsWith(PROJECT_TERMINAL_THREAD_PREFIX);
}

export function projectIdFromProjectTerminalThreadId(threadId: string): ProjectIdType | null {
  if (!isProjectTerminalThreadId(threadId)) {
    return null;
  }
  const projectId = threadId.slice(PROJECT_TERMINAL_THREAD_PREFIX.length);
  return projectId.length > 0 ? ProjectId.make(projectId) : null;
}
