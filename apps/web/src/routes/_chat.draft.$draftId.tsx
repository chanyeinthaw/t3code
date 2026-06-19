import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { ProjectShell } from "../components/ProjectShell";
import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import { createThreadSelectorAcrossEnvironments } from "../storeSelectors";
import { useStore } from "../store";
import { buildProjectThreadRouteParams } from "../projectTabs";
import { useProjectShellUiStateStore } from "../projectShellUiStateStore";
import { scopeProjectRef, scopeThreadRef } from "@pulse/client-runtime";

function DraftChatThreadRouteView() {
  const navigate = useNavigate();
  const { draftId: rawDraftId } = Route.useParams();
  const draftId = DraftId.make(rawDraftId);
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const serverThread = useStore(
    useMemo(
      () => createThreadSelectorAcrossEnvironments(draftSession?.threadId ?? null),
      [draftSession?.threadId],
    ),
  );
  const serverThreadStarted = threadHasStarted(serverThread);
  const canonicalThreadRef = useMemo(
    () =>
      draftSession?.promotedTo
        ? serverThreadStarted
          ? draftSession.promotedTo
          : null
        : serverThread
          ? {
              environmentId: serverThread.environmentId,
              threadId: serverThread.id,
            }
          : null,
    [draftSession?.promotedTo, serverThread, serverThreadStarted],
  );

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }
    const projectId = serverThread?.projectId ?? draftSession?.projectId;
    if (!projectId) {
      return;
    }
    useProjectShellUiStateStore
      .getState()
      .openThreadTab(
        scopeProjectRef(canonicalThreadRef.environmentId, projectId),
        scopeThreadRef(canonicalThreadRef.environmentId, canonicalThreadRef.threadId),
      );
    void navigate({
      to: "/$environmentId/projects/$projectId/threads/$threadId",
      params: buildProjectThreadRouteParams({
        environmentId: canonicalThreadRef.environmentId,
        projectId,
        threadId: canonicalThreadRef.threadId,
      }),
      replace: true,
    });
  }, [canonicalThreadRef, draftSession?.projectId, navigate, serverThread?.projectId]);

  useEffect(() => {
    if (draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate]);

  if (!draftSession || canonicalThreadRef) {
    return null;
  }

  return (
    <ProjectShell
      context={{
        environmentId: draftSession.environmentId,
        projectId: draftSession.projectId,
        activeThreadId: null,
        activeView: "draft",
      }}
    >
      <ChatView
        draftId={draftId}
        environmentId={draftSession.environmentId}
        threadId={draftSession.threadId}
        reserveTitleBarControlInset={false}
        routeKind="draft"
      />
    </ProjectShell>
  );
}

export const Route = createFileRoute("/_chat/draft/$draftId")({
  component: DraftChatThreadRouteView,
});
