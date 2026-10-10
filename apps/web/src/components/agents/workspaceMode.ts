import { useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import { isSidebarUtilityPage } from "../sidebar/mainAppLocation";

export type WorkspaceMode = "code" | "agents";
const storageKey = "pulse.workspace-locations";
const defaults = { mode: "code", code: "/", agents: "/agents/pulse" } as const;

function readLocations() {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (typeof saved !== "object" || saved === null) return defaults;
    const values = saved as Record<string, unknown>;
    return {
      mode: values.mode === "agents" ? ("agents" as const) : ("code" as const),
      code:
        typeof values.code === "string" &&
        values.code.startsWith("/") &&
        !values.code.startsWith("//")
          ? values.code
          : defaults.code,
      agents:
        typeof values.agents === "string" && values.agents.startsWith("/agents/")
          ? values.agents
          : defaults.agents,
    };
  } catch {
    return defaults;
  }
}

export function isAgentsPath(pathname: string) {
  return pathname === "/agents" || pathname.startsWith("/agents/");
}

export function workspaceDestination(mode: WorkspaceMode) {
  return readLocations()[mode];
}

export function useWorkspaceMode(): WorkspaceMode {
  const pathname = useLocation({ select: (location) => location.pathname });
  return isAgentsPath(pathname)
    ? "agents"
    : isSidebarUtilityPage(pathname)
      ? readLocations().mode
      : "code";
}

/** The route owns the active mode; storage only remembers destinations between switches. */
export function WorkspaceLocationTracker() {
  const location = useLocation();
  useEffect(() => {
    if (
      isSidebarUtilityPage(location.pathname) ||
      location.pathname === "/agents" ||
      location.pathname === "/agents/"
    )
      return;
    const mode = isAgentsPath(location.pathname) ? "agents" : "code";
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({ ...readLocations(), mode, [mode]: location.href }),
      );
    } catch {
      // Navigation still works when browser storage is unavailable.
    }
  }, [location.pathname, location.href]);
  return null;
}
