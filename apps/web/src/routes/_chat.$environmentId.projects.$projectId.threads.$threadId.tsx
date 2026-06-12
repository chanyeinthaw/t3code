import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";

import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../components/DiffPanelShell";
import { ProjectShell } from "../components/ProjectShell";
import { RightPanelSheet } from "../components/RightPanelSheet";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import { type DiffRouteSearch, parseDiffRouteSearch } from "../diffRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { buildProjectThreadRouteParams } from "../projectTabs";
import { useProjectShellUiStateStore } from "../projectShellUiStateStore";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { selectEnvironmentState, selectThreadExistsByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";

const DiffPanel = lazy(() => import("../components/DiffPanel"));
const DiffLoadingFallback = (props: { mode: DiffPanelMode }) => (
  <DiffPanelShell mode={props.mode} header={<DiffPanelHeaderSkeleton />}>
    <DiffPanelLoadingState label="Loading diff viewer..." />
  </DiffPanelShell>
);

const LazyDiffPanel = (props: { mode: DiffPanelMode }) => (
  <DiffWorkerPoolProvider>
    <Suspense fallback={<DiffLoadingFallback mode={props.mode} />}>
      <DiffPanel mode={props.mode} />
    </Suspense>
  </DiffWorkerPoolProvider>
);

function ProjectThreadRouteView() {
  const params = Route.useParams();
  const environmentId = EnvironmentId.make(params.environmentId);
  const projectId = ProjectId.make(params.projectId);
  const threadId = ThreadId.make(params.threadId);
  const projectRef = scopeProjectRef(environmentId, projectId);
  const threadRef = scopeThreadRef(environmentId, threadId);
  const navigate = useNavigate();
  const search = Route.useSearch();
  const bootstrapComplete = useStore(
    (store) => selectEnvironmentState(store, environmentId).bootstrapComplete,
  );
  const serverThread = useStore(useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]));
  const threadExists = useStore((store) => selectThreadExistsByRef(store, threadRef));
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const draftThreadExists = useComposerDraftStore(
    (store) => store.getDraftThreadByRef(threadRef) !== null,
  );
  const openThreadTab = useProjectShellUiStateStore((state) => state.openThreadTab);
  const serverThreadStarted = threadHasStarted(serverThread);
  const diffOpen = search.diff === "1";
  const shouldUseDiffSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const currentThreadKey = `${environmentId}:${threadId}`;
  const [diffPanelMountState, setDiffPanelMountState] = useState(() => ({
    threadKey: currentThreadKey,
    hasOpenedDiff: diffOpen,
  }));
  const hasOpenedDiff =
    diffPanelMountState.threadKey === currentThreadKey
      ? diffPanelMountState.hasOpenedDiff
      : diffOpen;
  const markDiffOpened = useCallback(() => {
    setDiffPanelMountState((previous) =>
      previous.threadKey === currentThreadKey && previous.hasOpenedDiff
        ? previous
        : { threadKey: currentThreadKey, hasOpenedDiff: true },
    );
  }, [currentThreadKey]);
  const closeDiff = useCallback(() => {
    void navigate({
      to: "/$environmentId/projects/$projectId/threads/$threadId",
      params: buildProjectThreadRouteParams({ environmentId, projectId, threadId }),
      search: { diff: undefined },
    });
  }, [environmentId, navigate, projectId, threadId]);
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

  const shouldRenderDiffContent = diffOpen || hasOpenedDiff;
  const shellContext = {
    environmentId,
    projectId,
    activeThreadId: threadId,
    activeView: "thread" as const,
  };

  if (!shouldUseDiffSheet) {
    return (
      <ProjectShell context={shellContext}>
        <div className="flex min-h-0 flex-1 overflow-hidden bg-background text-foreground">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <ChatView
              environmentId={environmentId}
              threadId={threadId}
              onDiffPanelOpen={markDiffOpened}
              reserveTitleBarControlInset={false}
              routeKind="server"
            />
          </div>
          {diffOpen ? <LazyDiffPanel mode="inline" /> : null}
        </div>
      </ProjectShell>
    );
  }

  return (
    <ProjectShell context={shellContext}>
      <ChatView
        environmentId={environmentId}
        threadId={threadId}
        onDiffPanelOpen={markDiffOpened}
        reserveTitleBarControlInset={false}
        routeKind="server"
      />
      <RightPanelSheet open={diffOpen} onClose={closeDiff}>
        {shouldRenderDiffContent ? <LazyDiffPanel mode="sheet" /> : null}
      </RightPanelSheet>
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
