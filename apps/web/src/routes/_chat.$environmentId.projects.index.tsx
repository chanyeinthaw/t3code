import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime";
import {
  ActivityIcon,
  ArchiveIcon,
  FolderPlusIcon,
  GitBranchIcon,
  MoreHorizontalIcon,
  SearchIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { ProjectFavicon } from "../components/ProjectFavicon";
import { ProjectShell, ProjectShellPage } from "../components/ProjectShell";
import {
  ProjectBrowserEmptyState,
  ProjectBrowserHeader,
  ProjectBrowserPage,
} from "../components/project-browser/ProjectBrowserPage";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { toastManager } from "../components/ui/toast";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { readEnvironmentApi } from "../environmentApi";
import { newCommandId } from "../lib/utils";
import { buildProjectThreadsRouteParams } from "../projectTabs";
import { selectEnvironmentState, selectProjectsForEnvironment, useStore } from "../store";
import type { Project } from "../types";
import { normalizeSearchText } from "../components/CommandPalette.logic";

function EnvironmentProjectsIndexRouteView() {
  const { environmentId: rawEnvironmentId } = Route.useParams();
  const environmentId = EnvironmentId.make(rawEnvironmentId);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const projects = useStore(
    useShallow((state) => selectProjectsForEnvironment(state, environmentId)),
  );
  const environmentState = useStore((state) => selectEnvironmentState(state, environmentId));
  const normalizedQuery = normalizeSearchText(query);
  const filteredProjects = useMemo(() => {
    if (!normalizedQuery) return projects;
    return projects.filter((project) =>
      normalizeSearchText(`${project.name} ${project.cwd}`).includes(normalizedQuery),
    );
  }, [normalizedQuery, projects]);

  const projectCountLabel = `${projects.length} project${projects.length === 1 ? "" : "s"}`;

  const removeProject = async (project: Project) => {
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    const threadIds = environmentState.threadIdsByProjectId[project.id] ?? [];
    const threadCount = threadIds.length;
    const confirmationMessage =
      threadCount > 0
        ? `Remove "${project.name}"? Its ${threadCount} thread${threadCount === 1 ? "" : "s"} will also be deleted.`
        : `Remove project "${project.name}"?`;
    if (!window.confirm(confirmationMessage)) {
      return;
    }
    try {
      await api.orchestration.dispatchCommand({
        type: "project.delete",
        commandId: newCommandId(),
        projectId: project.id,
        force: threadCount > 0,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to remove project",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  };

  return (
    <ProjectShell
      context={{
        environmentId,
        projectId: null,
        activeThreadId: null,
        activeView: "projects",
      }}
    >
      <ProjectShellPage>
        <ProjectBrowserPage
          header={
            <ProjectBrowserHeader
              title="Projects"
              subtitle={`${projectCountLabel} in this workspace`}
              actions={
                <Button onClick={() => useCommandPaletteStore.getState().openAddProject()}>
                  <FolderPlusIcon className="size-4" />
                  Add project
                </Button>
              }
              search={
                <div className="relative">
                  <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-foreground/45" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search projects…"
                    className="h-8 text-sm [&_[data-slot=input]]:pl-8"
                  />
                </div>
              }
            />
          }
        >
          <div className="flex flex-col">
            {filteredProjects.length === 0 ? (
              <ProjectBrowserEmptyState
                title={query ? "No matching projects" : "No projects yet"}
                description={
                  query ? "Try a different search." : "Add a local folder or clone a repository."
                }
                action={
                  !query ? (
                    <Button onClick={() => useCommandPaletteStore.getState().openAddProject()}>
                      <FolderPlusIcon className="size-4" />
                      Add project
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              filteredProjects.map((project) => {
                const threadIds = environmentState.threadIdsByProjectId[project.id] ?? [];
                const projectThreads = threadIds.flatMap((threadId) => {
                  const thread = environmentState.sidebarThreadSummaryById[threadId];
                  return thread ? [thread] : [];
                });
                const activeThreadCount = projectThreads.filter(
                  (thread) => thread.archivedAt === null,
                ).length;
                const archivedThreadCount = projectThreads.length - activeThreadCount;
                const runningThreadCount = projectThreads.filter(
                  (thread) =>
                    thread.session?.status === "running" || thread.latestTurn?.state === "running",
                ).length;
                const pendingThreadCount = projectThreads.filter(
                  (thread) => thread.hasPendingApprovals || thread.hasPendingUserInput,
                ).length;
                const ref = scopeProjectRef(project.environmentId, project.id);
                return (
                  <div
                    key={project.id}
                    className="group/project-row flex min-w-0 items-center gap-4 border-b border-border/40 px-4 py-3 transition-colors hover:bg-accent/40 focus-within:bg-accent/40 sm:px-6"
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-4 text-left focus-visible:outline-hidden"
                      onClick={() =>
                        void navigate({
                          to: "/$environmentId/projects/$projectId/threads",
                          params: buildProjectThreadsRouteParams(ref),
                        })
                      }
                    >
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg">
                        <ProjectFavicon environmentId={project.environmentId} cwd={project.cwd} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <div className="truncate text-sm font-medium text-foreground">
                            {project.name}
                          </div>
                          {project.repositoryIdentity ? (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                              <GitBranchIcon className="size-3" /> repo
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/80">
                          {project.cwd}
                        </div>
                      </div>
                      <div className="hidden shrink-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground sm:flex">
                        {activeThreadCount > 0 ? (
                          <span className="rounded-full border border-border/70 bg-background/60 px-2 py-0.5">
                            {activeThreadCount} active
                          </span>
                        ) : null}
                        {runningThreadCount > 0 ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-emerald-700 dark:text-emerald-300">
                            <ActivityIcon className="size-3" /> {runningThreadCount} running
                          </span>
                        ) : null}
                        {pendingThreadCount > 0 ? (
                          <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-300">
                            {pendingThreadCount} pending
                          </span>
                        ) : null}
                        {archivedThreadCount > 0 ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/60 px-2 py-0.5">
                            <ArchiveIcon className="size-3" /> {archivedThreadCount} archived
                          </span>
                        ) : null}
                      </div>
                    </button>
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            aria-label={`More actions for ${project.name}`}
                            className="size-8 shrink-0"
                            size="icon"
                            variant="ghost"
                          />
                        }
                      >
                        <MoreHorizontalIcon className="size-4" />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuItem variant="destructive" onClick={() => void removeProject(project)}>
                          Remove project
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  </div>
                );
              })
            )}
          </div>
        </ProjectBrowserPage>
      </ProjectShellPage>
    </ProjectShell>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/projects/")({
  component: EnvironmentProjectsIndexRouteView,
});
