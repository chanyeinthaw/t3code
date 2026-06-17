"use client";

import { scopedThreadKey } from "@t3tools/client-runtime";
import type {
  DesktopPreviewBridge,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationRequest,
  PreviewAutomationResponse,
  PreviewAutomationStatus,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useCallback, useEffect, useId, useRef } from "react";

import { ensureEnvironmentApi } from "~/environmentApi";
import { selectThreadPreviewState, usePreviewStateStore } from "~/previewStateStore";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import { resolveBrowserNavigationTarget } from "~/browser/browserTargetResolver";
import {
  startBrowserRecording,
  stopBrowserRecording,
  useBrowserRecordingStore,
} from "~/browser/browserRecording";

import { getPreviewBridge } from "./previewBridge";

const waitForDesktopOverlay = async (
  threadRef: ScopedThreadRef,
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const state = selectThreadPreviewState(usePreviewStateStore.getState().byThreadKey, threadRef);
    const tabId = state.snapshot?.tabId;
    const bridge = getPreviewBridge();
    if (tabId && state.desktopOverlay && bridge) {
      const status = await bridge.automation.status(tabId);
      if (status.available) return;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  const error = new Error(`Preview webview did not register within ${timeoutMs}ms.`);
  error.name = "PreviewAutomationTimeoutError";
  throw error;
};

const waitForNavigationReadiness = async (
  tabId: string,
  readiness: PreviewAutomationNavigateInput["readiness"],
  timeoutMs: number,
): Promise<void> => {
  const bridge = getPreviewBridge();
  if (!bridge || readiness === "none") return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (readiness === "domContentLoaded") {
      const readyState = await bridge.automation.evaluate(tabId, {
        expression: "document.readyState",
      });
      if (readyState === "interactive" || readyState === "complete") return;
    } else {
      const status = await bridge.automation.status(tabId);
      if (!status.loading) return;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  const error = new Error(`Preview navigation did not become ready within ${timeoutMs}ms.`);
  error.name = "PreviewAutomationTimeoutError";
  throw error;
};

const readActivePreviewTabId = (
  threadRef: ScopedThreadRef,
  fallbackTabId: string | null = null,
): string | null => {
  const activeSurface = selectActiveRightPanelSurface(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  );
  if (activeSurface?.kind === "preview" && activeSurface.resourceId)
    return activeSurface.resourceId;

  const state = selectThreadPreviewState(usePreviewStateStore.getState().byThreadKey, threadRef);
  return state.activeTabId ?? state.snapshot?.tabId ?? fallbackTabId;
};

const currentStatus = async (
  threadRef: ScopedThreadRef,
  visible: boolean,
): Promise<PreviewAutomationStatus> => {
  const state = selectThreadPreviewState(usePreviewStateStore.getState().byThreadKey, threadRef);
  const tabId = readActivePreviewTabId(threadRef);
  const bridge = getPreviewBridge();
  const desktopOverlay = tabId ? (state.desktopByTabId[tabId] ?? null) : null;
  if (tabId && bridge && desktopOverlay) {
    const status = await bridge.automation.status(tabId);
    return { ...status, visible };
  }
  const snapshot = tabId ? (state.sessions[tabId] ?? state.snapshot) : state.snapshot;
  const navStatus = snapshot?.navStatus;
  return {
    available: Boolean(bridge?.automation),
    visible,
    tabId,
    url: navStatus && navStatus._tag !== "Idle" ? navStatus.url : null,
    title: navStatus && navStatus._tag !== "Idle" ? navStatus.title : null,
    loading: navStatus?._tag === "Loading",
  };
};

const serializeError = (error: unknown): NonNullable<PreviewAutomationResponse["error"]> => {
  if (error instanceof Error) {
    const detail =
      "detail" in error && (error as { detail?: unknown }).detail !== undefined
        ? (error as { detail?: unknown }).detail
        : undefined;
    return {
      _tag: error.name.startsWith("PreviewAutomation")
        ? error.name
        : "PreviewAutomationExecutionError",
      message: error.message,
      ...(detail === undefined ? {} : { detail }),
    };
  }
  return {
    _tag: "PreviewAutomationExecutionError",
    message: String(error),
  };
};

export function PreviewAutomationOwner(props: {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
}) {
  const { threadRef, visible } = props;
  const automationClientId = useId();
  const ownerStateRef = useRef({ threadRef, visible });
  const handlerRef = useRef<(request: PreviewAutomationRequest) => Promise<unknown>>(
    async () => undefined,
  );
  useEffect(() => {
    ownerStateRef.current = { threadRef, visible };
  }, [threadRef, visible]);

  const handleRequest = useCallback(
    async (request: PreviewAutomationRequest): Promise<unknown> => {
      if (request.threadId !== threadRef.threadId) {
        const error = new Error("Preview automation request targeted a stale thread owner.");
        error.name = "PreviewAutomationUnavailableError";
        throw error;
      }
      const api = ensureEnvironmentApi(threadRef.environmentId);
      // Prefer the renderer's active browser surface over request.tabId. The
      // broker's owner report can lag behind a user clicking another preview
      // tab, and the preview store snapshot can also lag if tab activation and
      // server session replay race. The right-panel active surface is the UI
      // source of truth for the tab the human is looking at.
      const tabId = readActivePreviewTabId(threadRef, request.tabId ?? null);
      const bridge = getPreviewBridge();
      switch (request.operation) {
        case "status":
          return currentStatus(threadRef, visible);
        case "open": {
          const input = request.input as PreviewAutomationOpenInput;
          let activeTabId =
            (input.reuseExistingTab ?? true) ? readActivePreviewTabId(threadRef) : null;
          if (!activeTabId) {
            const snapshot = await api.preview.open({
              threadId: threadRef.threadId,
              ...(input.url ? { url: input.url } : {}),
            });
            usePreviewStateStore.getState().applyServerSnapshot(threadRef, snapshot);
            activeTabId = snapshot.tabId;
          } else if (input.url && bridge) {
            await bridge.navigate(activeTabId, input.url);
          }
          if (input.show ?? true) {
            useRightPanelStore.getState().openBrowser(threadRef, activeTabId);
          }
          await waitForDesktopOverlay(threadRef, request.timeoutMs);
          return currentStatus(threadRef, input.show ?? true);
        }
        case "navigate": {
          if (!bridge || !tabId) throw new Error("Preview tab is not initialized.");
          const input = request.input as PreviewAutomationNavigateInput;
          const resolution = resolveBrowserNavigationTarget(
            threadRef.environmentId,
            input.target ?? { kind: "url", url: input.url! },
          );
          await bridge.navigate(tabId, resolution.resolvedUrl);
          await waitForNavigationReadiness(
            tabId,
            input.readiness ?? "load",
            input.timeoutMs ?? request.timeoutMs,
          );
          return currentStatus(threadRef, visible);
        }
        case "snapshot":
          if (!bridge || !tabId) throw new Error("Preview tab is not initialized.");
          return bridge.automation.snapshot(tabId);
        case "click":
          if (!bridge || !tabId) throw new Error("Preview tab is not initialized.");
          return bridge.automation.click(
            tabId,
            request.input as Parameters<DesktopPreviewBridge["automation"]["click"]>[1],
          );
        case "type":
          if (!bridge || !tabId) throw new Error("Preview tab is not initialized.");
          return bridge.automation.type(
            tabId,
            request.input as Parameters<DesktopPreviewBridge["automation"]["type"]>[1],
          );
        case "press":
          if (!bridge || !tabId) throw new Error("Preview tab is not initialized.");
          return bridge.automation.press(
            tabId,
            request.input as Parameters<DesktopPreviewBridge["automation"]["press"]>[1],
          );
        case "scroll":
          if (!bridge || !tabId) throw new Error("Preview tab is not initialized.");
          return bridge.automation.scroll(
            tabId,
            request.input as Parameters<DesktopPreviewBridge["automation"]["scroll"]>[1],
          );
        case "evaluate":
          if (!bridge || !tabId) throw new Error("Preview tab is not initialized.");
          return bridge.automation.evaluate(
            tabId,
            request.input as Parameters<DesktopPreviewBridge["automation"]["evaluate"]>[1],
          );
        case "waitFor":
          if (!bridge || !tabId) throw new Error("Preview tab is not initialized.");
          return bridge.automation.waitFor(
            tabId,
            request.input as Parameters<DesktopPreviewBridge["automation"]["waitFor"]>[1],
          );
        case "recordingStart": {
          if (!tabId) throw new Error("Preview tab is not initialized.");
          await startBrowserRecording(tabId);
          return {
            tabId,
            recording: true,
            startedAt: useBrowserRecordingStore.getState().startedAt,
          };
        }
        case "recordingStop": {
          if (!tabId) throw new Error("Preview tab is not initialized.");
          const artifact = await stopBrowserRecording(tabId);
          if (!artifact) throw new Error("No active recording exists for this preview tab.");
          return artifact;
        }
      }
    },
    [threadRef, visible],
  );
  useEffect(() => {
    handlerRef.current = handleRequest;
  }, [handleRequest]);

  useEffect(() => {
    const api = ensureEnvironmentApi(threadRef.environmentId);
    return api.preview.automation.connect(
      { clientId: automationClientId },
      (request) => {
        void handlerRef.current(request).then(
          (result) =>
            api.preview.automation.respond({
              requestId: request.requestId,
              ok: true,
              ...(result === undefined ? {} : { result }),
            }),
          (error) =>
            api.preview.automation.respond({
              requestId: request.requestId,
              ok: false,
              error: serializeError(error),
            }),
        );
      },
      {
        onResubscribe: () => {
          const ownerState = ownerStateRef.current;
          void api.preview.automation.reportOwner({
            clientId: automationClientId,
            environmentId: ownerState.threadRef.environmentId,
            threadId: ownerState.threadRef.threadId,
            tabId: readActivePreviewTabId(ownerState.threadRef),
            visible: ownerState.visible,
            supportsAutomation: Boolean(getPreviewBridge()?.automation),
            focusedAt: new Date().toISOString(),
          });
        },
      },
    );
  }, [automationClientId, threadRef.environmentId]);

  useEffect(() => {
    const api = ensureEnvironmentApi(threadRef.environmentId);
    const report = () => {
      void api.preview.automation.reportOwner({
        clientId: automationClientId,
        environmentId: threadRef.environmentId,
        threadId: threadRef.threadId,
        tabId: readActivePreviewTabId(threadRef),
        visible,
        supportsAutomation: Boolean(getPreviewBridge()?.automation),
        focusedAt: new Date().toISOString(),
      });
    };
    report();
    window.addEventListener("focus", report);
    const unsubscribePreview = usePreviewStateStore.subscribe((state, previous) => {
      const key = scopedThreadKey(threadRef);
      if (
        state.byThreadKey[key]?.activeTabId !== previous.byThreadKey[key]?.activeTabId ||
        state.byThreadKey[key]?.snapshot?.tabId !== previous.byThreadKey[key]?.snapshot?.tabId
      ) {
        report();
      }
    });
    const unsubscribeRightPanel = useRightPanelStore.subscribe((state, previous) => {
      const key = scopedThreadKey(threadRef);
      if (state.byThreadKey[key]?.activeSurfaceId !== previous.byThreadKey[key]?.activeSurfaceId) {
        report();
      }
    });
    return () => {
      window.removeEventListener("focus", report);
      unsubscribePreview();
      unsubscribeRightPanel();
      void api.preview.automation.clearOwner({ clientId: automationClientId });
    };
  }, [automationClientId, threadRef, visible]);

  return null;
}
