import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Outlet, useNavigate } from "@tanstack/react-router";
import {
  EllipsisIcon,
  ListIcon,
  PlusIcon,
  SearchIcon,
  ChevronLeftIcon,
  FolderOpenIcon,
  SettingsIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { ProjectFavicon } from "./ProjectFavicon";
import { Button } from "./ui/button";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { ScrollArea } from "./ui/scroll-area";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "./ui/sheet";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { isElectron } from "../env";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useIsMobile } from "../hooks/useMediaQuery";
import {
  buildProjectThreadRouteParams,
  buildProjectThreadsRouteParams,
} from "../projectTabs";
import { useProjectShellUiStateStore } from "../projectShellUiStateStore";
import {
  selectProjectByRef,
  selectSidebarThreadsForProjectRef,
  useStore,
} from "../store";
import { sortThreads } from "../lib/threadSort";
import { cn } from "../lib/utils";
import { useSettings } from "../hooks/useSettings";
import { useUiStateStore } from "../uiStateStore";
import { readLocalApi } from "../localApi";
import { readEnvironmentApi } from "../environmentApi";
import { newCommandId } from "../lib/utils";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { stackedThreadToast, toastManager } from "./ui/toast";
import type { Project, SidebarThreadSummary } from "../types";

const EMPTY_THREAD_KEYS: readonly string[] = [];

interface ProjectShellNavigationContextValue {
  openMobileNavigation: () => void;
}

const ProjectShellNavigationContext =
  createContext<ProjectShellNavigationContextValue | null>(null);

export function useProjectShellNavigation(): ProjectShellNavigationContextValue | null {
  return useContext(ProjectShellNavigationContext);
}

export interface ProjectShellContextValue {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  activeThreadId: ThreadId | null;
  activeView: "projects" | "threads" | "thread" | "terminal" | "draft";
}

function projectKey(ref: ScopedProjectRef): string {
  return scopedProjectKey(ref);
}

function threadKey(ref: ScopedThreadRef): string {
  return scopedThreadKey(ref);
}

function threadStatusDotClassName(thread: SidebarThreadSummary): string {
  if (thread.session?.status === "error") return "block bg-destructive";
  if (thread.hasPendingApprovals || thread.hasPendingUserInput)
    return "block bg-amber-500";
  if (thread.session?.status === "running")
    return "block bg-emerald-500 animate-pulse";
  if (thread.latestTurn?.state === "running")
    return "block bg-emerald-500 animate-pulse";
  return "hidden";
}

function ProjectShellIconButton({
  active,
  label,
  onClick,
  children,
}: {
  active?: boolean;
  label: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className={cn(
              "size-8 shrink-0",
              active && "bg-accent text-accent-foreground",
            )}
            onClick={onClick}
            size="icon"
            variant="ghost"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

function ProjectSwitcher({
  currentProject,
  environmentId,
}: {
  currentProject: Project | null;
  environmentId: EnvironmentId;
}) {
  const navigate = useNavigate();
  const recentProjectKeys = useProjectShellUiStateStore(
    (state) => state.recentProjectKeys,
  );
  const removeRecentProject = useProjectShellUiStateStore(
    (state) => state.removeRecentProject,
  );
  const focusedThreadKeyByProjectKey = useProjectShellUiStateStore(
    (state) => state.focusedThreadKeyByProjectKey,
  );
  const openedThreadKeysByProjectKey = useProjectShellUiStateStore(
    (state) => state.openedThreadKeysByProjectKey,
  );
  const recentProjects = useStore(
    useShallow((state) => {
      const projectsByKey = new Map(
        Object.values(state.environmentStateById).flatMap((environmentState) =>
          Object.values(environmentState.projectById).map(
            (project) =>
              [
                scopedProjectKey(
                  scopeProjectRef(project.environmentId, project.id),
                ),
                project,
              ] as const,
          ),
        ),
      );
      return recentProjectKeys.flatMap((key) => {
        const project = projectsByKey.get(key);
        return project ? [project] : [];
      });
    }),
  );

  const filteredRecentProjects = useMemo(
    () =>
      currentProject
        ? recentProjects.filter(
            (project) =>
              project.environmentId !== currentProject.environmentId ||
              project.id !== currentProject.id,
          )
        : recentProjects,
    [currentProject, recentProjects],
  );

  const navigateToProject = useCallback(
    async (project: Project) => {
      const ref = scopeProjectRef(project.environmentId, project.id);
      const pKey = projectKey(ref);
      const focusedKey = focusedThreadKeyByProjectKey[pKey] ?? null;
      const openedKeys = openedThreadKeysByProjectKey[pKey] ?? [];
      if (focusedKey && openedKeys.includes(focusedKey)) {
        const thread = selectSidebarThreadsForProjectRef(
          useStore.getState(),
          ref,
        ).find(
          (candidate) =>
            threadKey(scopeThreadRef(candidate.environmentId, candidate.id)) ===
            focusedKey,
        );
        if (thread && thread.archivedAt === null) {
          await navigate({
            to: "/$environmentId/projects/$projectId/threads/$threadId",
            params: buildProjectThreadRouteParams({
              environmentId: project.environmentId,
              projectId: project.id,
              threadId: thread.id,
            }),
          });
          return;
        }
      }
      await navigate({
        to: "/$environmentId/projects/$projectId/threads",
        params: buildProjectThreadsRouteParams(ref),
      });
    },
    [focusedThreadKeyByProjectKey, navigate, openedThreadKeysByProjectKey],
  );

  if (!currentProject) return null;

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            className="flex h-8 min-w-0 max-w-64 shrink-0 cursor-pointer items-center gap-2 rounded-md px-3 text-left text-sm font-medium text-foreground hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <ProjectFavicon
          environmentId={currentProject.environmentId}
          cwd={currentProject.cwd}
        />
        <span className="truncate">{currentProject?.name ?? "Projects"}</span>
      </MenuTrigger>
      <MenuPopup align="start" className="w-72">
        <MenuGroup>
          <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
            Recent projects
          </div>
          {filteredRecentProjects.slice(0, 5).map((project) => (
            <MenuItem
              key={scopedProjectKey(
                scopeProjectRef(project.environmentId, project.id),
              )}
              className="group pr-1"
              onClick={() => void navigateToProject(project)}
            >
              <ProjectFavicon
                environmentId={project.environmentId}
                cwd={project.cwd}
              />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <button
                type="button"
                aria-label={`Remove ${project.name} from recent projects`}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  removeRecentProject(
                    scopeProjectRef(project.environmentId, project.id),
                  );
                }}
              >
                <XIcon className="size-3.5" />
              </button>
            </MenuItem>
          ))}
          {filteredRecentProjects.length === 0 ? (
            <div className="px-2 py-2 text-sm text-muted-foreground">
              No recent projects
            </div>
          ) : null}
        </MenuGroup>
        <MenuSeparator />
        <MenuItem
          onClick={() =>
            void navigate({
              to: "/$environmentId/projects",
              params: { environmentId },
            })
          }
        >
          All projects
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function ProjectThreadTab({
  active,
  onClose,
  onSelect,
  onContextMenu,
  thread,
  mobile = false,
}: {
  active: boolean;
  onClose: () => void;
  onSelect: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
  thread: SidebarThreadSummary;
  mobile?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        "group/tab no-drag-region flex min-w-0 items-center gap-2 rounded-md border border-transparent text-left text-sm transition-colors",
        mobile ? "h-9 w-full px-2 pr-1" : "h-8 max-w-56 shrink-0 px-2.5 pr-1",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
      )}
      onClick={active ? undefined : onSelect}
      onContextMenu={onContextMenu}
    >
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          threadStatusDotClassName(thread),
        )}
      />
      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
      <span
        role="button"
        tabIndex={0}
        aria-label={`Close ${thread.title}`}
        className={cn(
          "rounded-full inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground hover:bg-background/50 hover:text-foreground",
          active ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100",
        )}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <XIcon className="size-3.5" />
      </span>
    </button>
  );
}

function ProjectShellChrome({
  context,
  mobileNavigationOpenRequest,
}: {
  context: ProjectShellContextValue;
  mobileNavigationOpenRequest: number;
}) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const sortOrder = useSettings((settings) => settings.threadSortOrder);
  const { handleNewThread } = useHandleNewThread();
  const projectRef = useMemo(
    () =>
      context.projectId
        ? scopeProjectRef(context.environmentId, context.projectId)
        : null,
    [context.environmentId, context.projectId],
  );
  const currentProject = useStore(
    (state) => selectProjectByRef(state, projectRef) ?? null,
  );
  const projectThreads = useStore(
    useShallow((state) =>
      projectRef ? selectSidebarThreadsForProjectRef(state, projectRef) : [],
    ),
  );
  const openedThreadKeys = useProjectShellUiStateStore((state) =>
    projectRef
      ? (state.openedThreadKeysByProjectKey[projectKey(projectRef)] ??
        EMPTY_THREAD_KEYS)
      : EMPTY_THREAD_KEYS,
  );
  const closeThreadTab = useProjectShellUiStateStore(
    (state) => state.closeThreadTab,
  );
  const markProjectAccessed = useProjectShellUiStateStore(
    (state) => state.markProjectAccessed,
  );
  const markThreadUnread = useUiStateStore((state) => state.markThreadUnread);
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{
    threadId: string;
  }>({
    onCopy: (ctx) =>
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: ctx.threadId,
      }),
    onError: (error) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread ID",
          description:
            error instanceof Error ? error.message : "An error occurred.",
        }),
      ),
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{
    path: string;
  }>({
    onCopy: (ctx) =>
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: ctx.path,
      }),
    onError: (error) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description:
            error instanceof Error ? error.message : "An error occurred.",
        }),
      ),
  });

  const showThreadContextMenu = useCallback(
    async (
      thread: SidebarThreadSummary,
      position: { x: number; y: number },
    ) => {
      const api = readLocalApi();
      if (!api) return;
      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      const threadKey = `${thread.environmentId}:${thread.id}`;
      const threadWorkspacePath =
        thread.worktreePath ?? currentProject?.cwd ?? null;
      const clicked = await api.contextMenu.show(
        [
          { id: "open-new-window", label: "Open in New Window" },
          { id: "rename", label: "Rename thread" },
          { id: "mark-unread", label: "Mark unread" },
          { id: "copy-path", label: "Copy Path" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          { id: "archive", label: "Archive" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "open-new-window") {
        await api.shell.openThreadInNewWindow({
          environmentId: threadRef.environmentId,
          projectId: thread.projectId,
          threadId: threadRef.threadId,
        });
        return;
      }
      if (clicked === "rename") {
        const newTitle = window.prompt("Rename thread", thread.title);
        if (
          !newTitle ||
          newTitle.trim() === "" ||
          newTitle.trim() === thread.title
        ) {
          return;
        }
        const envApi = readEnvironmentApi(threadRef.environmentId);
        if (!envApi) return;
        try {
          await envApi.orchestration.dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId: threadRef.threadId,
            title: newTitle.trim(),
          });
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to rename thread",
              description:
                error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      if (clicked === "mark-unread") {
        markThreadUnread(threadKey, thread.latestTurn?.completedAt);
        return;
      }
      if (clicked === "copy-path") {
        if (!threadWorkspacePath) {
          toastManager.add({ type: "error", title: "Path unavailable" });
          return;
        }
        copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
        return;
      }
      if (clicked === "copy-thread-id") {
        copyThreadIdToClipboard(thread.id, { threadId: thread.id });
        return;
      }
      if (clicked === "archive") {
        const envApi = readEnvironmentApi(threadRef.environmentId);
        if (!envApi) return;
        try {
          await envApi.orchestration.dispatchCommand({
            type: "thread.archive",
            commandId: newCommandId(),
            threadId: threadRef.threadId,
          });
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to archive thread",
              description:
                error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      if (clicked === "delete") {
        if (
          !window.confirm(
            `Delete thread "${thread.title}"? This permanently clears conversation history for this thread.`,
          )
        ) {
          return;
        }
        const envApi = readEnvironmentApi(threadRef.environmentId);
        if (!envApi) return;
        await envApi.orchestration.dispatchCommand({
          type: "thread.delete",
          commandId: newCommandId(),
          threadId: threadRef.threadId,
        });
      }
    },
    [
      copyPathToClipboard,
      copyThreadIdToClipboard,
      currentProject,
      markThreadUnread,
    ],
  );

  const handleTabContextMenu = useCallback(
    (event: React.MouseEvent, thread: SidebarThreadSummary) => {
      event.preventDefault();
      event.stopPropagation();
      void showThreadContextMenu(thread, {
        x: event.clientX,
        y: event.clientY,
      });
    },
    [showThreadContextMenu],
  );

  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);

  useEffect(() => {
    if (mobileNavigationOpenRequest > 0) {
      setMobileSheetOpen(true);
    }
  }, [mobileNavigationOpenRequest]);

  const openedTabs = useMemo(() => {
    const opened = new Set(openedThreadKeys);
    return sortThreads(
      projectThreads.filter(
        (thread) =>
          thread.archivedAt === null &&
          opened.has(
            threadKey(scopeThreadRef(thread.environmentId, thread.id)),
          ),
      ),
      sortOrder,
    );
  }, [openedThreadKeys, projectThreads, sortOrder]);

  useEffect(() => {
    if (projectRef) {
      markProjectAccessed(projectRef);
    }
  }, [markProjectAccessed, projectRef]);

  const navigateToThread = useCallback(
    async (thread: SidebarThreadSummary) => {
      await navigate({
        to: "/$environmentId/projects/$projectId/threads/$threadId",
        params: buildProjectThreadRouteParams({
          environmentId: thread.environmentId,
          projectId: thread.projectId,
          threadId: thread.id,
        }),
      });
      setMobileSheetOpen(false);
    },
    [navigate],
  );

  const navigateToThreads = useCallback(async () => {
    if (!projectRef) return;
    await navigate({
      to: "/$environmentId/projects/$projectId/threads",
      params: buildProjectThreadsRouteParams(projectRef),
    });
    setMobileSheetOpen(false);
  }, [navigate, projectRef]);

  const navigateToTerminal = useCallback(async () => {
    if (!projectRef) return;
    await navigate({
      to: "/$environmentId/projects/$projectId/terminal",
      params: buildProjectThreadsRouteParams(projectRef),
    });
    setMobileSheetOpen(false);
  }, [navigate, projectRef]);

  const createNewThread = useCallback(async () => {
    if (!projectRef) return;
    await handleNewThread(projectRef);
    setMobileSheetOpen(false);
  }, [handleNewThread, projectRef]);

  const closeTabAndNavigate = useCallback(
    async (thread: SidebarThreadSummary) => {
      if (!projectRef) return;
      const closingIndex = openedTabs.findIndex(
        (entry) =>
          entry.id === thread.id &&
          entry.environmentId === thread.environmentId,
      );
      const nextThread =
        openedTabs[closingIndex + 1] ?? openedTabs[closingIndex - 1] ?? null;
      closeThreadTab(
        projectRef,
        scopeThreadRef(thread.environmentId, thread.id),
      );
      if (context.activeThreadId === thread.id) {
        if (nextThread) {
          await navigateToThread(nextThread);
        } else {
          await navigateToThreads();
        }
      }
    },
    [
      closeThreadTab,
      context.activeThreadId,
      navigateToThread,
      navigateToThreads,
      openedTabs,
      projectRef,
    ],
  );

  const showProjectScopedActions = context.activeView !== "projects";
  const actionButtons = (
    <>
      {!isMobile ? (
        <ProjectShellIconButton
          label="Search"
          onClick={() => useCommandPaletteStore.getState().setOpen(true)}
        >
          <SearchIcon className="size-4" />
        </ProjectShellIconButton>
      ) : null}
      {showProjectScopedActions ? (
        <ProjectShellIconButton
          active={context.activeView === "threads"}
          label="Threads"
          onClick={() => void navigateToThreads()}
        >
          <ListIcon className="size-4" />
        </ProjectShellIconButton>
      ) : null}
      {showProjectScopedActions ? (
        <ProjectShellIconButton
          active={context.activeView === "terminal"}
          label="Terminal"
          onClick={() => void navigateToTerminal()}
        >
          <TerminalIcon className="size-4" />
        </ProjectShellIconButton>
      ) : null}
    </>
  );

  if (isMobile) {
    const showMobileChrome =
      context.activeView !== "thread" && context.activeView !== "draft";
    const mobileTitle =
      context.activeView === "projects"
        ? "Projects"
        : context.activeView === "terminal"
          ? "Terminal"
          : "Threads";
    const goBack = () => {
      setMobileSheetOpen(false);
      if (projectRef && context.activeView !== "projects") {
        void navigate({
          to: "/$environmentId/projects",
          params: { environmentId: context.environmentId },
        });
        return;
      }
      window.history.back();
    };

    return (
      <>
        {showMobileChrome ? (
          <header className="flex h-12 shrink-0 items-center gap-2 px-2 md:hidden">
            <Button
              aria-label="Back"
              className="size-8 shrink-0"
              onClick={goBack}
              size="icon"
              variant="ghost"
            >
              <ChevronLeftIcon className="size-4" />
            </Button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-foreground">
                {mobileTitle}
              </div>
              {currentProject ? (
                <div className="truncate text-xs text-muted-foreground">
                  {currentProject.name}
                </div>
              ) : null}
            </div>
            <Button
              aria-label="Open project navigation"
              className="size-8 shrink-0"
              onClick={() => setMobileSheetOpen(true)}
              size="icon"
              variant="ghost"
            >
              <ListIcon className="size-4" />
            </Button>
          </header>
        ) : null}
        <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
          <SheetPopup
            side="bottom"
            className="max-h-[82dvh] rounded-t-2xl"
            showCloseButton={false}
          >
            <SheetHeader className="px-4 py-3">
              <SheetTitle className="flex items-center gap-2 text-base">
                {currentProject ? (
                  <ProjectFavicon
                    environmentId={currentProject.environmentId}
                    cwd={currentProject.cwd}
                  />
                ) : null}
                <span className="min-w-0 flex-1 truncate">
                  {currentProject?.name ?? "Projects"}
                </span>
                {projectRef ? (
                  <Button
                    aria-label="View all projects"
                    className="size-8 shrink-0"
                    onClick={() => {
                      setMobileSheetOpen(false);
                      void navigate({
                        to: "/$environmentId/projects",
                        params: { environmentId: context.environmentId },
                      });
                    }}
                    size="icon"
                    variant="ghost"
                  >
                    <FolderOpenIcon className="size-4" />
                  </Button>
                ) : null}
              </SheetTitle>
              <SheetDescription className="sr-only">
                Project navigation
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
              <div className="rounded-lg border border-border p-1">
                {openedTabs.length > 0 ? (
                  openedTabs.map((thread) => (
                    <ProjectThreadTab
                      key={threadKey(
                        scopeThreadRef(thread.environmentId, thread.id),
                      )}
                      active={context.activeThreadId === thread.id}
                      thread={thread}
                      mobile
                      onSelect={() => void navigateToThread(thread)}
                      onClose={() => void closeTabAndNavigate(thread)}
                      onContextMenu={(event) =>
                        handleTabContextMenu(event, thread)
                      }
                    />
                  ))
                ) : (
                  <div className="px-2 py-8 text-center text-sm text-muted-foreground">
                    No open threads
                  </div>
                )}
              </div>
            </div>
            <div className="grid grid-cols-4 gap-2 border-t border-border p-3">
              <Button
                variant="outline"
                onClick={() => {
                  setMobileSheetOpen(false);
                  void navigate({
                    to: "/$environmentId/projects",
                    params: { environmentId: context.environmentId },
                  });
                }}
              >
                <ChevronLeftIcon className="size-4" />
              </Button>
              {projectRef ? (
                <>
                  <Button
                    variant="outline"
                    onClick={() => void createNewThread()}
                  >
                    <PlusIcon className="size-4" />
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void navigateToThreads()}
                  >
                    <ListIcon className="size-4" />
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void navigateToTerminal()}
                  >
                    <TerminalIcon className="size-4" />
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="outline"
                    onClick={() =>
                      useCommandPaletteStore.getState().openAddProject()
                    }
                  >
                    <PlusIcon className="size-4" />
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      useCommandPaletteStore.getState().setOpen(true)
                    }
                  >
                    <SearchIcon className="size-4" />
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setMobileSheetOpen(false);
                      void navigate({ to: "/settings" });
                    }}
                  >
                    <SettingsIcon className="size-4" />
                  </Button>
                </>
              )}
            </div>
          </SheetPopup>
        </Sheet>
      </>
    );
  }

  return (
    <header
      className={cn(
        "drag-region hidden h-[52px] shrink-0 items-center gap-2 px-3 text-foreground md:flex",
        isElectron &&
          "pl-[90px] electron-full-screen:pl-3 wco:h-[env(titlebar-area-height)] wco:pl-[calc(env(titlebar-area-x)+1em)] electron-full-screen:wco:pl-3",
      )}
    >
      <div className="flex flex-row items-center gap-1">
        <ProjectSwitcher
          currentProject={currentProject}
          environmentId={context.environmentId}
        />
        {showProjectScopedActions && (
          <div className="w-0.25 h-6 bg-secondary mx-1" />
        )}
        {actionButtons}
      </div>
      {openedTabs.length > 0 && showProjectScopedActions && (
        <div className="w-0.25 h-6 bg-secondary" />
      )}
      <div className="flex h-full min-w-0 flex-1 items-stretch overflow-hidden gap-2">
        <ScrollArea
          hideScrollbars
          scrollFade
          className="no-drag-region h-full w-fit min-w-0 shrink rounded-none"
        >
          <div className="flex h-full items-center gap-1">
            {openedTabs.map((thread) => (
              <ProjectThreadTab
                key={threadKey(scopeThreadRef(thread.environmentId, thread.id))}
                active={context.activeThreadId === thread.id}
                thread={thread}
                onSelect={() => void navigateToThread(thread)}
                onClose={() => void closeTabAndNavigate(thread)}
                onContextMenu={(event) => handleTabContextMenu(event, thread)}
              />
            ))}
          </div>
        </ScrollArea>
        {showProjectScopedActions && (
          <div className="self-center flex flex-row items-center gap-2">
            <div className="w-0.25 h-6 bg-secondary" />
            <ProjectShellIconButton
              label="New thread"
              onClick={() => void createNewThread()}
            >
              <PlusIcon className="size-4" />
            </ProjectShellIconButton>
          </div>
        )}
      </div>
      <div className="no-drag-region flex shrink-0 items-center gap-1">
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label="More"
                className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            <EllipsisIcon className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => void navigate({ to: "/settings" })}>
              Settings
            </MenuItem>
            <MenuItem
              onClick={() => void navigate({ to: "/settings/connections" })}
            >
              Connections
            </MenuItem>
            <MenuItem
              onClick={() => void navigate({ to: "/settings/diagnostics" })}
            >
              Diagnostics
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </header>
  );
}

function ProjectShellStatePruner() {
  const environmentStateById = useStore((state) => state.environmentStateById);
  const pruneProjectShellState = useProjectShellUiStateStore(
    (state) => state.pruneProjectShellState,
  );

  useEffect(() => {
    const bootstrappedEnvironmentEntries = Object.entries(
      environmentStateById,
    ).filter(([, environmentState]) => environmentState.bootstrapComplete);

    // Do not prune persisted tabs while a newly mounted renderer is still waiting
    // for the shell snapshot. In Electron dev/prod, closing the window and
    // reopening it briefly renders the project shell with empty environment
    // state; pruning at that point deletes the just-restored persisted tabs.
    if (bootstrappedEnvironmentEntries.length === 0) {
      return;
    }

    const prunableEnvironmentIds = new Set(
      bootstrappedEnvironmentEntries.map(([environmentId]) =>
        EnvironmentId.make(environmentId),
      ),
    );
    const validProjectKeys = new Set<string>();
    const validThreadKeysByProjectKey = new Map<string, Set<string>>();

    for (const [, environmentState] of bootstrappedEnvironmentEntries) {
      for (const project of Object.values(environmentState.projectById)) {
        const pKey = scopedProjectKey(
          scopeProjectRef(project.environmentId, project.id),
        );
        validProjectKeys.add(pKey);
        validThreadKeysByProjectKey.set(pKey, new Set());
      }

      for (const thread of Object.values(
        environmentState.sidebarThreadSummaryById,
      )) {
        if (thread.archivedAt !== null) {
          continue;
        }
        const pKey = scopedProjectKey(
          scopeProjectRef(thread.environmentId, thread.projectId),
        );
        if (!validProjectKeys.has(pKey)) {
          continue;
        }
        const validThreadKeys =
          validThreadKeysByProjectKey.get(pKey) ?? new Set<string>();
        validThreadKeys.add(
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        );
        validThreadKeysByProjectKey.set(pKey, validThreadKeys);
      }
    }

    pruneProjectShellState({
      validProjectKeys,
      validThreadKeysByProjectKey,
      prunableEnvironmentIds,
    });
  }, [environmentStateById, pruneProjectShellState]);

  return null;
}

export function ProjectShell({
  children,
  context,
}: {
  children?: ReactNode;
  context: ProjectShellContextValue;
}) {
  const [mobileNavigationOpenRequest, setMobileNavigationOpenRequest] =
    useState(0);
  const navigationContext = useMemo(
    () => ({
      openMobileNavigation: () =>
        setMobileNavigationOpenRequest((request) => request + 1),
    }),
    [],
  );

  return (
    <ProjectShellNavigationContext value={navigationContext}>
      <div className="electron-vibrant-background flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-muted/35 text-foreground">
        <ProjectShellStatePruner />
        <ProjectShellChrome
          context={context}
          mobileNavigationOpenRequest={mobileNavigationOpenRequest}
        />
        <div className="min-h-0 flex-1 md:p-1 md:pt-0">
          <div className="flex h-full min-h-0 overflow-hidden md:rounded-2xl md:rounded-t-sm md:border border-border bg-background md:shadow-xs">
            {children ?? <Outlet />}
          </div>
        </div>
      </div>
    </ProjectShellNavigationContext>
  );
}

export function ProjectShellPage({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-background">{children}</div>
  );
}
