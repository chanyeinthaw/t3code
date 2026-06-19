import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@pulse/client-runtime";
import type {
  EnvironmentId,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
} from "@pulse/contracts";

export type ProjectRouteRef = ScopedProjectRef;
export type ProjectTabRef = ScopedThreadRef & { projectId: ProjectId };

export function projectKey(ref: Pick<ScopedProjectRef, "environmentId" | "projectId">): string {
  return scopedProjectKey(scopeProjectRef(ref.environmentId, ref.projectId));
}

export function tabKey(ref: Pick<ScopedThreadRef, "environmentId" | "threadId">): string {
  return scopedThreadKey(scopeThreadRef(ref.environmentId, ref.threadId));
}

export function makeProjectRef(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): ProjectRouteRef {
  return scopeProjectRef(environmentId, projectId);
}

export function makeProjectTabRef(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
): ProjectTabRef {
  return {
    environmentId,
    projectId,
    threadId,
  };
}

export function buildProjectListRouteParams(ref: Pick<ProjectRouteRef, "environmentId">): {
  environmentId: EnvironmentId;
} {
  return { environmentId: ref.environmentId };
}

export function buildProjectThreadsRouteParams(ref: ProjectRouteRef): {
  environmentId: EnvironmentId;
  projectId: ProjectId;
} {
  return {
    environmentId: ref.environmentId,
    projectId: ref.projectId,
  };
}

export function buildProjectThreadRouteParams(ref: ProjectTabRef): {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
} {
  return {
    environmentId: ref.environmentId,
    projectId: ref.projectId,
    threadId: ref.threadId,
  };
}
