import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import ThreadSidebar from "./Sidebar";
import { Sidebar, SidebarProvider, SidebarRail } from "./ui/sidebar";
import { useIsMobile } from "~/hooks/useMediaQuery";
import {
  clearShortcutModifierState,
  syncShortcutModifierStateFromKeyboardEvent,
} from "../shortcutModifierState";
import { useLocalStorage } from "../hooks/useLocalStorage";

const THREAD_SIDEBAR_OPEN_STORAGE_KEY = "chat_thread_sidebar_open";
const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;
export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useLocalStorage(
    THREAD_SIDEBAR_OPEN_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  const isMobile = useIsMobile();
  const [peekOpen, setPeekOpen] = useState(false);
  const peekLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shouldEnablePeek = !sidebarOpen && !isMobile;
  const isPeeking = shouldEnablePeek && peekOpen;

  const clearPeekLeaveTimer = useCallback(() => {
    if (peekLeaveTimerRef.current !== null) {
      clearTimeout(peekLeaveTimerRef.current);
      peekLeaveTimerRef.current = null;
    }
  }, []);

  const handleHotzoneMouseEnter = useCallback(() => {
    clearPeekLeaveTimer();
    setPeekOpen(true);
  }, [clearPeekLeaveTimer]);

  const handleSidebarMouseEnter = useCallback(() => {
    clearPeekLeaveTimer();
  }, [clearPeekLeaveTimer]);

  const handleSidebarMouseLeave = useCallback(() => {
    peekLeaveTimerRef.current = setTimeout(() => {
      setPeekOpen(false);
    }, 300);
  }, []);

  // Cleanup the leave timer on unmount.
  useEffect(() => {
    return () => {
      if (peekLeaveTimerRef.current !== null) {
        clearTimeout(peekLeaveTimerRef.current);
      }
    };
  }, []);

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

  return (
    <SidebarProvider
      className="h-dvh! min-h-0!"
      defaultOpen
      open={sidebarOpen}
      onOpenChange={setSidebarOpen}
    >
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-card text-foreground"
        resizable={{
          minWidth: THREAD_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ nextWidth, wrapper }) =>
            wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
          storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
        peeked={isPeeking}
        onMouseEnter={handleSidebarMouseEnter}
        onMouseLeave={handleSidebarMouseLeave}
      >
        <ThreadSidebar />
        <SidebarRail />
      </Sidebar>

      {/* Hotzone on the left edge to trigger a peek when the sidebar is closed on desktop. */}
      {shouldEnablePeek && !peekOpen && (
        <div
          className="fixed left-0 inset-y-0 z-20 w-[6px] cursor-pointer"
          onMouseEnter={handleHotzoneMouseEnter}
        />
      )}

      {children}
    </SidebarProvider>
  );
}
