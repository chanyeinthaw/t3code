import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { EnvironmentId, ProjectId, ThreadId } from "@pulse/contracts";
import { scopeProjectRef, scopeThreadRef } from "@pulse/client-runtime";
import { useEffect } from "react";

import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { ProjectShell } from "../components/ProjectShell";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import { type DiffRouteSearch, parseDiffRouteSearch } from "../diffRouteSearch";
import { buildProjectThreadRouteParams } from "../projectTabs";
import { useProjectShellUiStateStore } from "../projectShellUiStateStore";
import { selectEnvironmentState, selectThreadExistsByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";

function ProjectThreadRouteView() {
  const params = Route.useParams();
  const environmentId = EnvironmentId.make(params.environmentId);
  const projectId = ProjectId.make(params.projectId);
  const threadId = ThreadId.make(params.threadId);
  const projectRef = scopeProjectRef(environmentId, projectId);
  const threadRef = scopeThreadRef(environmentId, threadId);
  const navigate = useNavigate();
  const bootstrapComplete = useStore(
    (store) => selectEnvironmentState(store, environmentId).bootstrapComplete,
  );
  const serverThread = useStore(createThreadSelectorByRef(threadRef));
  const threadExists = useStore((store) => selectThreadExistsByRef(store, threadRef));
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const draftThreadExists = useComposerDraftStore(
    (store) => store.getDraftThreadByRef(threadRef) !== null,
  );
  const openThreadTab = useProjectShellUiStateStore((state) => state.openThreadTab);
  const serverThreadStarted = threadHasStarted(serverThread);

  useEffect(() => {
    if (threadExists) {
      openThreadTab(projectRef, threadRef);
    }
  }, [openThreadTab, projectRef, threadExists, threadRef]);

  useEffect(() => {
    if (!bootstrapComplete) return;
    if (!threadExists && !draftThreadExists) {
      void navigate({
        to: "/$environmentId/projects/$projectId/threads",
        params: { environmentId, projectId },
        replace: true,
      });
    }
  }, [bootstrapComplete, draftThreadExists, environmentId, navigate, projectId, threadExists]);

  useEffect(() => {
    if (!serverThreadStarted || !draftThread?.promotedTo) return;
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread?.promotedTo, serverThreadStarted, threadRef]);

  if (!bootstrapComplete || !threadExists) return null;

  return (
    <ProjectShell
      context={{
        environmentId,
        projectId,
        activeThreadId: threadId,
        activeView: "thread",
      }}
    >
      <ChatView
        environmentId={environmentId}
        threadId={threadId}
        reserveTitleBarControlInset={false}
        routeKind="server"
      />
    </ProjectShell>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/projects/$projectId/threads/$threadId")(
  {
    validateSearch: (search) => parseDiffRouteSearch(search),
    search: { middlewares: [retainSearchParams<DiffRouteSearch>(["diff"])] },
    component: ProjectThreadRouteView,
  },
);
