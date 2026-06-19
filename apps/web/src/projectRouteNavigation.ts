import { scopeProjectRef, scopeThreadRef } from "@pulse/client-runtime";
import type { EnvironmentId, ProjectId, ScopedThreadRef, ThreadId } from "@pulse/contracts";

import { buildProjectThreadRouteParams, buildProjectThreadsRouteParams } from "./projectTabs";
import { useProjectShellUiStateStore } from "./projectShellUiStateStore";
import { selectThreadByRef, useStore } from "./store";

type Navigate = (options: any) => Promise<void>;

export function projectThreadRouteParamsForRef(ref: ScopedThreadRef): {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
} | null {
  const thread = selectThreadByRef(useStore.getState(), ref);
  if (!thread) return null;
  return buildProjectThreadRouteParams({
    environmentId: ref.environmentId,
    projectId: thread.projectId,
    threadId: ref.threadId,
  });
}

export async function navigateToProjectThread(
  navigate: Navigate,
  ref: ScopedThreadRef,
  options?: {
    replace?: boolean;
    search?: any;
  },
): Promise<boolean> {
  const thread = selectThreadByRef(useStore.getState(), ref);
  if (!thread) return false;
  useProjectShellUiStateStore
    .getState()
    .openThreadTab(scopeProjectRef(ref.environmentId, thread.projectId), ref);
  await navigate({
    to: "/$environmentId/projects/$projectId/threads/$threadId",
    params: buildProjectThreadRouteParams({
      environmentId: ref.environmentId,
      projectId: thread.projectId,
      threadId: ref.threadId,
    }),
    ...(options?.replace ? { replace: true } : {}),
    ...(options?.search ? { search: options.search } : {}),
  });
  return true;
}

export async function navigateToProjectThreads(
  navigate: Navigate,
  projectRef: { environmentId: EnvironmentId; projectId: ProjectId },
  options?: { replace?: boolean },
): Promise<void> {
  await navigate({
    to: "/$environmentId/projects/$projectId/threads",
    params: buildProjectThreadsRouteParams(
      scopeProjectRef(projectRef.environmentId, projectRef.projectId),
    ),
    ...(options?.replace ? { replace: true } : {}),
  });
}

export function threadRef(environmentId: EnvironmentId, threadId: ThreadId): ScopedThreadRef {
  return scopeThreadRef(environmentId, threadId);
}
