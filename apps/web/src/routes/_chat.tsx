import { useNavigate } from "@tanstack/react-router";
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { scopedProjectKey, scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import type { SidebarThreadSummary } from "../types";
import { useCallback, useEffect } from "react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { dispatchPreviewAction } from "../components/preview/previewActionBus";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import {
  startNewLocalThreadFromContext,
  startNewThreadFromContext,
} from "../lib/chatThreadActions";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveShortcutCommand, threadTraversalDirectionFromCommand } from "../keybindings";
import { useProjectShellUiStateStore, type ProjectShellUiState } from "../projectShellUiStateStore";
import { navigateToProjectThread, navigateToProjectThreads } from "../projectRouteNavigation";
import { selectSidebarThreadsForProjectRef, useStore } from "../store";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isPreviewSupportedInRuntime } from "../previewStateStore";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { resolveSidebarNewThreadEnvMode } from "~/components/Sidebar.logic";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "~/rpc/serverState";

function findAdjacentOpenedThread(
  state: ProjectShellUiState,
  projectRef: { environmentId: EnvironmentId; projectId: ProjectId },
  activeThreadRef: ScopedThreadRef | null,
  direction: "next" | "previous",
): SidebarThreadSummary | null {
  const pKey = scopedProjectKey(projectRef);
  const openedKeys = state.openedThreadKeysByProjectKey[pKey];
  if (!openedKeys || openedKeys.length === 0) return null;

  // Determine the current position in the opened tabs list.
  // If there's no active thread, start from the beginning (for "next") or end (for "previous").
  let currentIndex = -1;
  if (activeThreadRef) {
    const activeKey = `${activeThreadRef.environmentId}:${activeThreadRef.threadId}`;
    currentIndex = openedKeys.indexOf(activeKey);
  }

  // Also check if we need to resolve thread IDs to opened keys.
  // The opened keys use "environmentId:threadId" format. If the active thread is in a different
  // project, treat it as if none is active.
  if (currentIndex === -1) {
    currentIndex = direction === "next" ? -1 : openedKeys.length;
  }

  const nextIndex =
    direction === "next"
      ? (currentIndex + 1) % openedKeys.length
      : (currentIndex - 1 + openedKeys.length) % openedKeys.length;

  const nextKey = openedKeys[nextIndex];
  if (!nextKey) return null;

  // Resolve the thread key to an actual thread in our store.
  const threads = selectSidebarThreadsForProjectRef(useStore.getState(), projectRef);
  return (
    threads.find((thread) => {
      const threadKey = `${thread.environmentId}:${thread.id}`;
      return threadKey === nextKey && thread.archivedAt === null;
    }) ?? null
  );
}

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  const keybindings = useServerKeybindings();
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  // The `previewOpen` shortcut-context flag here uses the store-only value;
  // the URL-aware arbitration lives inside ChatView's `onTogglePreview`,
  // which we invoke via the action bus to avoid duplicating the rule.
  const previewOpen = useRightPanelStore((state) =>
    routeThreadRef
      ? selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "preview"
      : false,
  );
  const appSettings = useSettings();
  const navigate = useNavigate();

  const handleThreadTraversal = useCallback(
    (direction: "next" | "previous") => {
      const { openedThreadKeysByProjectKey } = useProjectShellUiStateStore.getState();

      // Find which project we're currently in. Try the routeThreadRef first, then defaultProjectRef.
      const candidateRefs: Array<{ environmentId: EnvironmentId; projectId: ProjectId }> = [];
      if (routeThreadRef) {
        const storeState = useStore.getState();
        const envState = storeState.environmentStateById[routeThreadRef.environmentId];
        if (envState) {
          // Look through all projects for a thread matching the routeThreadRef.
          for (const project of Object.values(envState.projectById)) {
            for (const tid of envState.threadIdsByProjectId[project.id] ?? []) {
              if (tid === routeThreadRef.threadId) {
                candidateRefs.push({
                  environmentId: routeThreadRef.environmentId,
                  projectId: project.id,
                });
                break;
              }
            }
            if (candidateRefs.length > 0) break;
          }
        }
      }
      if (defaultProjectRef) {
        candidateRefs.push(defaultProjectRef);
      }

      // Try each candidate project until we find one with opened tabs.
      for (const projectRef of candidateRefs) {
        const pKey = scopedProjectKey(projectRef);
        const openedKeys = openedThreadKeysByProjectKey[pKey];
        if (!openedKeys || openedKeys.length === 0) continue;

        const thread = findAdjacentOpenedThread(
          useProjectShellUiStateStore.getState(),
          projectRef,
          routeThreadRef ?? null,
          direction,
        );

        if (thread) {
          void navigateToProjectThread(navigate, scopeThreadRef(thread.environmentId, thread.id));
          return;
        }

        // No adjacent thread found but there are opened tabs — navigate to threads list.
        void navigateToProjectThreads(navigate, projectRef);
        return;
      }

      // No opened tabs at all — a no-op.
    },
    [defaultProjectRef, navigate, routeThreadRef],
  );

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
        },
      });

      if (useCommandPaletteStore.getState().open) {
        return;
      }

      if (event.key === "Escape" && selectedThreadKeysSize > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      if (command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        void startNewLocalThreadFromContext({
          activeDraftThread,
          activeThread,
          defaultProjectRef,
          defaultThreadEnvMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
          handleNewThread,
        });
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread,
          defaultProjectRef,
          defaultThreadEnvMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
          handleNewThread,
        });
        return;
      }

      const direction = threadTraversalDirectionFromCommand(command);
      if (direction) {
        event.preventDefault();
        event.stopPropagation();
        handleThreadTraversal(direction);
        return;
      }

      if (command === "preview.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (!routeThreadRef) return;
        if (!isPreviewSupportedInRuntime()) {
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: "Preview is desktop-only",
              description: "Open T3 Code in the desktop app to use the in-app preview.",
            }),
          );
          return;
        }
        dispatchPreviewAction("toggle-panel");
        return;
      }

      // The remaining preview commands only fire when the panel is the
      // currently-focused tenant. The `when: previewFocus` rule already
      // gates this, but defend against the keybinding being misconfigured.
      if (
        command === "preview.refresh" ||
        command === "preview.focusUrl" ||
        command === "preview.zoomIn" ||
        command === "preview.zoomOut" ||
        command === "preview.resetZoom"
      ) {
        event.preventDefault();
        event.stopPropagation();
        const action =
          command === "preview.refresh"
            ? "refresh"
            : command === "preview.focusUrl"
              ? "focus-url"
              : command === "preview.zoomIn"
                ? "zoom-in"
                : command === "preview.zoomOut"
                  ? "zoom-out"
                  : "reset-zoom";
        dispatchPreviewAction(action);
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activeDraftThread,
    activeThread,
    clearSelection,
    handleNewThread,
    handleThreadTraversal,
    keybindings,
    defaultProjectRef,
    previewOpen,
    routeThreadRef,
    selectedThreadKeysSize,
    terminalOpen,
    appSettings.defaultThreadEnvMode,
  ]);

  return null;
}

function ChatRouteLayout() {
  return (
    <>
      <ChatRouteGlobalShortcuts />
      <Outlet />
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ChatRouteLayout,
});
