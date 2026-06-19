import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import { SidebarProvider } from "./ui/sidebar";
import { toastManager } from "./ui/toast";
import {
  clearShortcutModifierState,
  syncShortcutModifierStateFromKeyboardEvent,
} from "../shortcutModifierState";

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      syncShortcutModifierStateFromKeyboardEvent(event);
    };
    const onWindowKeyUp = (event: KeyboardEvent) => {
      syncShortcutModifierStateFromKeyboardEvent(event);
    };
    const onWindowBlur = () => {
      clearShortcutModifierState();
    };

    window.addEventListener("keydown", onWindowKeyDown, true);
    window.addEventListener("keyup", onWindowKeyUp, true);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
      window.removeEventListener("keyup", onWindowKeyUp, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        void navigate({ to: "/settings" });
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") return;

    let quitToastId: ReturnType<typeof toastManager.add> | null = null;
    const unsubscribe = onMenuAction((action) => {
      if (action === "quit-in-progress") {
        if (quitToastId !== null) return;
        quitToastId = toastManager.add({
          type: "info",
          title: "Quitting Pulse…",
          description: "Cleaning up before shutdown.",
          timeout: 0,
        });
      }
    });

    return () => {
      unsubscribe?.();
      if (quitToastId !== null) {
        toastManager.close(quitToastId);
      }
    };
  }, []);

  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen={false} open={false}>
      {children}
    </SidebarProvider>
  );
}
