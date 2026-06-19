"use client";

import type { ScopedThreadRef } from "@pulse/contracts";

import { isPreviewSupportedInRuntime } from "~/previewStateStore";

import { PreviewPanelShell, type PreviewPanelMode } from "./PreviewPanelShell";
import { PreviewView } from "./PreviewView";

interface Props {
  mode: PreviewPanelMode;
  threadRef: ScopedThreadRef;
  tabId?: string | null | undefined;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
}

export function PreviewPanel({ mode, threadRef, tabId, configuredUrls, visible }: Props) {
  if (!isPreviewSupportedInRuntime()) {
    return (
      <PreviewPanelShell mode={mode}>
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            Preview is only available in the Pulse desktop app.
          </p>
        </div>
      </PreviewPanelShell>
    );
  }

  return (
    <PreviewPanelShell mode={mode}>
      <PreviewView
        threadRef={threadRef}
        tabId={tabId}
        configuredUrls={configuredUrls}
        visible={visible}
      />
    </PreviewPanelShell>
  );
}
