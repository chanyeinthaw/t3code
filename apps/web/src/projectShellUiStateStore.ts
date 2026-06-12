import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { scopedProjectKey, scopedThreadKey } from "@t3tools/client-runtime";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";

export const PROJECT_SHELL_UI_STATE_STORAGE_KEY = "t3code:project-shell-ui-state:v1";
const MAX_RECENT_PROJECTS = 20;

export interface ProjectShellUiState {
  openedThreadKeysByProjectKey: Record<string, string[]>;
  focusedThreadKeyByProjectKey: Record<string, string | null>;
  recentProjectKeys: string[];
  openThreadTab: (projectRef: ScopedProjectRef, threadRef: ScopedThreadRef) => void;
  focusThreadTab: (projectRef: ScopedProjectRef, threadRef: ScopedThreadRef) => void;
  closeThreadTab: (projectRef: ScopedProjectRef, threadRef: ScopedThreadRef) => void;
  closeThreadTabs: (threadRefs: readonly ScopedThreadRef[]) => void;
  markProjectAccessed: (projectRef: ScopedProjectRef) => void;
  pruneProjectShellState: (input: {
    validProjectKeys: ReadonlySet<string>;
    validThreadKeysByProjectKey: ReadonlyMap<string, ReadonlySet<string>>;
  }) => void;
}

function addUnique(values: readonly string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}

function removeValue(values: readonly string[], value: string): string[] {
  return values.filter((entry) => entry !== value);
}

function markRecentProject(keys: readonly string[], key: string): string[] {
  return [key, ...keys.filter((entry) => entry !== key)].slice(0, MAX_RECENT_PROJECTS);
}

function projectKey(ref: ScopedProjectRef): string {
  return scopedProjectKey(ref);
}

function threadKey(ref: ScopedThreadRef): string {
  return scopedThreadKey(ref);
}

export const useProjectShellUiStateStore = create<ProjectShellUiState>()(
  persist(
    (set) => ({
      openedThreadKeysByProjectKey: {},
      focusedThreadKeyByProjectKey: {},
      recentProjectKeys: [],
      openThreadTab: (projectRef, threadRef) =>
        set((state) => {
          const pKey = projectKey(projectRef);
          const tKey = threadKey(threadRef);
          return {
            openedThreadKeysByProjectKey: {
              ...state.openedThreadKeysByProjectKey,
              [pKey]: addUnique(state.openedThreadKeysByProjectKey[pKey] ?? [], tKey),
            },
            focusedThreadKeyByProjectKey: {
              ...state.focusedThreadKeyByProjectKey,
              [pKey]: tKey,
            },
            recentProjectKeys: markRecentProject(state.recentProjectKeys, pKey),
          };
        }),
      focusThreadTab: (projectRef, threadRef) =>
        set((state) => {
          const pKey = projectKey(projectRef);
          const tKey = threadKey(threadRef);
          return {
            openedThreadKeysByProjectKey: {
              ...state.openedThreadKeysByProjectKey,
              [pKey]: addUnique(state.openedThreadKeysByProjectKey[pKey] ?? [], tKey),
            },
            focusedThreadKeyByProjectKey: {
              ...state.focusedThreadKeyByProjectKey,
              [pKey]: tKey,
            },
            recentProjectKeys: markRecentProject(state.recentProjectKeys, pKey),
          };
        }),
      closeThreadTab: (projectRef, threadRef) =>
        set((state) => {
          const pKey = projectKey(projectRef);
          const tKey = threadKey(threadRef);
          const nextTabs = removeValue(state.openedThreadKeysByProjectKey[pKey] ?? [], tKey);
          return {
            openedThreadKeysByProjectKey: {
              ...state.openedThreadKeysByProjectKey,
              [pKey]: nextTabs,
            },
            focusedThreadKeyByProjectKey: {
              ...state.focusedThreadKeyByProjectKey,
              [pKey]:
                state.focusedThreadKeyByProjectKey[pKey] === tKey
                  ? null
                  : (state.focusedThreadKeyByProjectKey[pKey] ?? null),
            },
          };
        }),
      closeThreadTabs: (threadRefs) =>
        set((state) => {
          if (threadRefs.length === 0) return state;
          const removedByEnvironment = new Map<string, Set<string>>();
          for (const ref of threadRefs) {
            const setForEnvironment =
              removedByEnvironment.get(ref.environmentId) ?? new Set<string>();
            setForEnvironment.add(threadKey(ref));
            removedByEnvironment.set(ref.environmentId, setForEnvironment);
          }
          const openedThreadKeysByProjectKey: Record<string, string[]> = {};
          const focusedThreadKeyByProjectKey: Record<string, string | null> = {};
          let changed = false;
          for (const [pKey, tabs] of Object.entries(state.openedThreadKeysByProjectKey)) {
            const nextTabs = tabs.filter((tKey) => {
              for (const removed of removedByEnvironment.values()) {
                if (removed.has(tKey)) return false;
              }
              return true;
            });
            openedThreadKeysByProjectKey[pKey] = nextTabs;
            const focused = state.focusedThreadKeyByProjectKey[pKey] ?? null;
            focusedThreadKeyByProjectKey[pKey] =
              focused && nextTabs.includes(focused) ? focused : null;
            if (nextTabs.length !== tabs.length || focusedThreadKeyByProjectKey[pKey] !== focused)
              changed = true;
          }
          if (!changed) return state;
          return {
            openedThreadKeysByProjectKey,
            focusedThreadKeyByProjectKey,
          };
        }),
      markProjectAccessed: (projectRef) =>
        set((state) => ({
          recentProjectKeys: markRecentProject(state.recentProjectKeys, projectKey(projectRef)),
        })),
      pruneProjectShellState: ({ validProjectKeys, validThreadKeysByProjectKey }) =>
        set((state) => {
          const openedThreadKeysByProjectKey: Record<string, string[]> = {};
          const focusedThreadKeyByProjectKey: Record<string, string | null> = {};
          let changed = false;
          for (const [pKey, tabs] of Object.entries(state.openedThreadKeysByProjectKey)) {
            if (!validProjectKeys.has(pKey)) {
              changed = true;
              continue;
            }
            const validThreadKeys = validThreadKeysByProjectKey.get(pKey) ?? new Set<string>();
            const nextTabs = tabs.filter((tKey) => validThreadKeys.has(tKey));
            openedThreadKeysByProjectKey[pKey] = nextTabs;
            const focused = state.focusedThreadKeyByProjectKey[pKey] ?? null;
            focusedThreadKeyByProjectKey[pKey] =
              focused && nextTabs.includes(focused) ? focused : null;
            if (nextTabs.length !== tabs.length || focusedThreadKeyByProjectKey[pKey] !== focused)
              changed = true;
          }
          const recentProjectKeys = state.recentProjectKeys.filter((pKey) =>
            validProjectKeys.has(pKey),
          );
          if (recentProjectKeys.length !== state.recentProjectKeys.length) changed = true;
          if (!changed) return state;
          return {
            openedThreadKeysByProjectKey,
            focusedThreadKeyByProjectKey,
            recentProjectKeys,
          };
        }),
    }),
    {
      name: PROJECT_SHELL_UI_STATE_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        openedThreadKeysByProjectKey: state.openedThreadKeysByProjectKey,
        focusedThreadKeyByProjectKey: state.focusedThreadKeyByProjectKey,
        recentProjectKeys: state.recentProjectKeys,
      }),
    },
  ),
);
