import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { EnvironmentId, ProjectId, type ScopedThreadRef } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import { ArchiveIcon, ClockIcon, MoreHorizontalIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { ProjectShell, ProjectShellPage } from "../components/ProjectShell";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

import { readEnvironmentApi } from "../environmentApi";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useThreadActions } from "../hooks/useThreadActions";
import { normalizeSearchText } from "../components/CommandPalette.logic";
import { sortThreads } from "../lib/threadSort";
import { buildProjectThreadRouteParams } from "../projectTabs";
import { useProjectShellUiStateStore } from "../projectShellUiStateStore";
import { selectProjectByRef, selectSidebarThreadsForProjectRef, useStore } from "../store";
import { useSettings } from "../hooks/useSettings";
import { readLocalApi } from "../localApi";
import { newCommandId } from "../lib/utils";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { useUiStateStore } from "../uiStateStore";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import type { SidebarThreadSummary } from "../types";

function threadStatusDotClassName(thread: SidebarThreadSummary): string | null {
  if (thread.session?.status === "error") return "bg-destructive";
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "bg-amber-500";
  if (thread.session?.status === "running" || thread.latestTurn?.state === "running") {
    return "bg-emerald-500 animate-pulse";
  }
  return null;
}

function ProjectThreadsIndexRouteView() {
  const params = Route.useParams();
  const environmentId = EnvironmentId.make(params.environmentId);
  const projectId = ProjectId.make(params.projectId);
  const projectRef = scopeProjectRef(environmentId, projectId);
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const { confirmAndDeleteThread } = useThreadActions();
  const sortOrder = useSettings((settings) => settings.threadSortOrder);
  const openThreadTab = useProjectShellUiStateStore((state) => state.openThreadTab);
  const markThreadUnread = useUiStateStore((state) => state.markThreadUnread);
  const project = useStore((state) => selectProjectByRef(state, projectRef));
  const threads = useStore(
    useShallow((state) => selectSidebarThreadsForProjectRef(state, projectRef)),
  );
  const [query, setQuery] = useState("");
  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
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
          description: error instanceof Error ? error.message : "An error occurred.",
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
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      ),
  });
  const normalizedQuery = normalizeSearchText(query);
  const visibleThreads = useMemo(() => {
    const filtered = threads.filter((thread) => {
      // Only show non-archived threads
      if (thread.archivedAt !== null) return false;
      if (normalizedQuery.length > 0) {
        const haystack = normalizeSearchText(
          `${thread.title} ${thread.branch ?? ""} ${thread.worktreePath ?? ""}`,
        );
        if (!haystack.includes(normalizedQuery)) return false;
      }
      return true;
    });
    return sortThreads(filtered, sortOrder);
  }, [normalizedQuery, sortOrder, threads]);

  const openThread = (thread: SidebarThreadSummary) => {
    const threadRef = scopeThreadRef(thread.environmentId, thread.id);
    openThreadTab(projectRef, threadRef);
    void navigate({
      to: "/$environmentId/projects/$projectId/threads/$threadId",
      params: buildProjectThreadRouteParams({
        environmentId: thread.environmentId,
        projectId: thread.projectId,
        threadId: thread.id,
      }),
    });
  };

  const commitRename = async (
    threadRef: ScopedThreadRef,
    nextTitle: string,
    originalTitle: string,
  ) => {
    const trimmed = nextTitle.trim();
    setRenamingThreadKey(null);
    if (trimmed.length === 0 || trimmed === originalTitle) {
      return;
    }
    const api = readEnvironmentApi(threadRef.environmentId);
    if (!api) return;
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: threadRef.threadId,
        title: trimmed,
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };

  const showThreadContextMenu = async (
    thread: SidebarThreadSummary,
    position: { x: number; y: number },
  ) => {
    const api = readLocalApi();
    if (!api) return;
    const threadRef = scopeThreadRef(thread.environmentId, thread.id);
    const threadKey = `${thread.environmentId}:${thread.id}`;
    const threadWorkspacePath = thread.worktreePath ?? project?.cwd ?? null;
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
      await api.shell.openThreadInNewWindow(threadRef);
      return;
    }
    if (clicked === "rename") {
      setRenamingThreadKey(threadKey);
      setRenamingTitle(thread.title);
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
      const api = readEnvironmentApi(threadRef.environmentId);
      if (!api) return;
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.archive",
          commandId: newCommandId(),
          threadId: threadRef.threadId,
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to archive thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return;
    }
    if (clicked === "delete") {
      await confirmAndDeleteThread(threadRef);
    }
  };

  return (
    <ProjectShell
      context={{
        environmentId,
        projectId,
        activeThreadId: null,
        activeView: "threads",
      }}
    >
      <ProjectShellPage>
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border/60 pb-4">
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground/70">
                Project threads
              </p>
              <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight">
                {project?.name ?? "Project"}
              </h1>
              {project?.cwd ? (
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground/80">
                  {project.cwd}
                </p>
              ) : null}
            </div>
            <Button onClick={() => void handleNewThread(projectRef)}>
              <PlusIcon className="size-4" />
              New thread
            </Button>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-foreground/45" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search threads…"
                className="[&_[data-slot=input]]:pl-9"
              />
            </div>
          </div>
          <div className="grid gap-2">
            {visibleThreads.map((thread) => {
              const threadRef = scopeThreadRef(thread.environmentId, thread.id);
              const threadKey = `${thread.environmentId}:${thread.id}`;
              const statusDotClassName = threadStatusDotClassName(thread);
              const isRenaming = renamingThreadKey === threadKey;
              return (
                <div
                  key={thread.id}
                  className="group/thread-row flex min-w-0 items-center gap-3 rounded-2xl border border-border/70 bg-card/35 p-3 text-left transition-all hover:-translate-y-px hover:border-border hover:bg-accent/35 hover:shadow-xs focus-within:ring-2 focus-within:ring-ring"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    void showThreadContextMenu(thread, {
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1 text-left focus-visible:outline-hidden"
                    onClick={() => openThread(thread)}
                    disabled={isRenaming}
                  >
                    {statusDotClassName ? (
                      <span className={`size-2 shrink-0 rounded-full ${statusDotClassName}`} />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      {isRenaming ? (
                        <Input
                          value={renamingTitle}
                          onChange={(event) => setRenamingTitle(event.target.value)}
                          autoFocus
                          className="h-7 text-sm"
                          onClick={(event) => event.stopPropagation()}
                          onBlur={() => void commitRename(threadRef, renamingTitle, thread.title)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void commitRename(threadRef, renamingTitle, thread.title);
                            }
                            if (event.key === "Escape") {
                              event.preventDefault();
                              setRenamingThreadKey(null);
                            }
                          }}
                        />
                      ) : (
                        <div className="truncate text-sm font-medium text-foreground">
                          {thread.title}
                        </div>
                      )}
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        {thread.branch ? (
                          <span className="rounded-full border border-border/70 bg-background/60 px-2 py-0.5 font-mono text-[11px]">
                            {thread.branch}
                          </span>
                        ) : null}
                        {thread.archivedAt ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/60 px-2 py-0.5 text-[11px]">
                            <ArchiveIcon className="size-3" /> Archived
                          </span>
                        ) : null}
                        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/80">
                          <ClockIcon className="size-3" />
                          {formatRelativeTimeLabel(
                            thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
                          )}
                        </span>
                      </div>
                    </div>
                  </button>
                  <Button
                    aria-label={`More actions for ${thread.title}`}
                    className="size-8 shrink-0 opacity-100 md:opacity-0 md:group-hover/thread-row:opacity-100 md:focus-visible:opacity-100"
                    size="icon"
                    variant="ghost"
                    onClick={(event) => {
                      event.stopPropagation();
                      void showThreadContextMenu(thread, {
                        x: event.clientX,
                        y: event.clientY,
                      });
                    }}
                  >
                    <MoreHorizontalIcon className="size-4" />
                  </Button>
                </div>
              );
            })}
            {visibleThreads.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
                No threads found.
              </div>
            ) : null}
          </div>
        </div>
      </ProjectShellPage>
    </ProjectShell>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/projects/$projectId/threads/")({
  component: ProjectThreadsIndexRouteView,
});
