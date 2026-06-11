import { type ReactNode } from "react";
import * as Schema from "effect/Schema";

import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
import { Sidebar, SidebarProvider, SidebarRail } from "./ui/sidebar";
import { useLocation } from "@tanstack/react-router";
import { useLocalStorage } from "~/hooks/useLocalStorage";

const SETTINGS_SIDEBAR_OPEN_STORAGE_KEY = "settings_sidebar_open";
const SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY = "settings_sidebar_width";
const SETTINGS_SIDEBAR_MIN_WIDTH = 13 * 16;
const SETTINGS_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

export function SettingsSidebarLayout({ children }: { children: ReactNode }) {
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const [sidebarOpen, setSidebarOpen] = useLocalStorage(
    SETTINGS_SIDEBAR_OPEN_STORAGE_KEY,
    true,
    Schema.Boolean,
  );

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
          minWidth: SETTINGS_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ nextWidth, wrapper }) =>
            wrapper.clientWidth - nextWidth >= SETTINGS_MAIN_CONTENT_MIN_WIDTH,
          storageKey: SETTINGS_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <SettingsSidebarNav pathname={pathname} />
        <SidebarRail />
      </Sidebar>

      {children}
    </SidebarProvider>
  );
}
