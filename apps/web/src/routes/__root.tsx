import { type EnvironmentId, type ServerLifecycleWelcomePayload } from "@t3tools/contracts";
import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopedProjectKey,
  scopeProjectRef,
} from "@t3tools/client-runtime";
import {
  Outlet,
  createRootRouteWithContext,
  type ErrorComponentProps,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";

import { APP_DISPLAY_NAME } from "../branding";
import { navigateToProjectThread, navigateToProjectThreads } from "../projectRouteNavigation";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { SettingsSidebarLayout } from "../components/SettingsSidebarLayout";
import { CommandPalette } from "../components/CommandPalette";
import { SshPasswordPromptDialog } from "../components/desktop/SshPasswordPromptDialog";
import { ProviderUpdateLaunchNotification } from "../components/ProviderUpdateLaunchNotification";
import {
  SlowRpcAckToastCoordinator,
  WebSocketConnectionCoordinator,
  WebSocketConnectionSurface,
} from "../components/WebSocketConnectionSurface";
import { Button } from "../components/ui/button";
import {
  AnchoredToastProvider,
  stackedThreadToast,
  ToastProvider,
  toastManager,
} from "../components/ui/toast";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { readLocalApi } from "../localApi";
import { useSettings } from "../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKeyFromPath,
  selectProjectGroupingSettings,
} from "../logicalProject";
import {
  getServerConfigUpdatedNotification,
  ServerConfigUpdatedNotification,
  startServerStateSync,
  useServerConfig,
  useServerConfigUpdatedSubscription,
  useServerWelcomeSubscription,
} from "../rpc/serverState";
import { useProjectShellUiStateStore } from "../projectShellUiStateStore";
import { selectEnvironmentState, selectProjectByRef, selectThreadByRef, useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import { syncBrowserChromeTheme } from "../hooks/useTheme";
import {
  ensureEnvironmentConnectionBootstrapped,
  getPrimaryEnvironmentConnection,
  listSavedEnvironmentRecords,
  waitForSavedEnvironmentRegistryHydration,
  startEnvironmentConnectionService,
  useSavedEnvironmentRegistryStore,
} from "../environments/runtime";
import { configureClientTracing } from "../observability/clientTracing";
import {
  ensurePrimaryEnvironmentReady,
  getPrimaryKnownEnvironment,
  resolveInitialServerAuthGateState,
  updatePrimaryEnvironmentDescriptor,
} from "../environments/primary";
import { hasHostedPairingRequest, isHostedStaticApp } from "../hostedPairing";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  beforeLoad: async ({ location }) => {
    if (location.pathname === "/pair" && hasHostedPairingRequest(new URL(window.location.href))) {
      return {
        authGateState: {
          status: "hosted-pairing",
        } as const,
      };
    }

    if (isHostedStaticApp(new URL(window.location.href))) {
      await waitForSavedEnvironmentRegistryHydration();
      return {
        authGateState: {
          status: "hosted-static",
        } as const,
      };
    }

    const [, authGateState] = await Promise.all([
      ensurePrimaryEnvironmentReady(),
      resolveInitialServerAuthGateState(),
    ]);
    return {
      authGateState,
    };
  },
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteView() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { authGateState } = Route.useRouteContext();
  const primaryEnvironmentAuthenticated = authGateState.status === "authenticated";

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      syncBrowserChromeTheme();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [pathname]);

  if (pathname === "/pair") {
    return <Outlet />;
  }

  if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
    return <Outlet />;
  }

  const isOnSettings = pathname.startsWith("/settings");

  const appShell = (
    <CommandPalette>
      {isOnSettings ? (
        <SettingsSidebarLayout>
          <Outlet />
        </SettingsSidebarLayout>
      ) : (
        <AppSidebarLayout>
          <Outlet />
        </AppSidebarLayout>
      )}
    </CommandPalette>
  );

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        {primaryEnvironmentAuthenticated ? <AuthenticatedTracingBootstrap /> : null}
        {primaryEnvironmentAuthenticated ? <ServerStateBootstrap /> : null}
        <EnvironmentConnectionManagerBootstrap />
        <SshPasswordPromptDialog />
        <HostedStaticEnvironmentBootstrap />
        {primaryEnvironmentAuthenticated ? <EventRouter /> : null}
        {primaryEnvironmentAuthenticated ? <ProviderUpdateLaunchNotification /> : null}
        {primaryEnvironmentAuthenticated ? <WebSocketConnectionCoordinator /> : null}
        {primaryEnvironmentAuthenticated ? <SlowRpcAckToastCoordinator /> : null}
        {primaryEnvironmentAuthenticated ? (
          <WebSocketConnectionSurface>{appShell}</WebSocketConnectionSurface>
        ) : (
          appShell
        )}
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function HostedStaticEnvironmentBootstrap() {
  const savedEnvironmentCount = useSavedEnvironmentRegistryStore(
    (state) => Object.keys(state.byId).length,
  );

  useEffect(() => {
    if (getPrimaryKnownEnvironment()) {
      return;
    }

    const currentActiveEnvironmentId = useStore.getState().activeEnvironmentId;
    if (currentActiveEnvironmentId) {
      return;
    }

    const firstSavedEnvironment = listSavedEnvironmentRecords()[0];
    if (!firstSavedEnvironment) {
      return;
    }

    useStore.getState().setActiveEnvironmentId(firstSavedEnvironment.environmentId);
  }, [savedEnvironmentCount]);

  return null;
}

function RootRouteErrorView({ error, reset }: ErrorComponentProps) {
  const message = errorMessage(error);
  const details = errorDetails(error);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          Something went wrong.
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => reset()}>
            Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </div>

        <details className="group mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground">
            <span className="group-open:hidden">Show error details</span>
            <span className="hidden group-open:inline">Hide error details</span>
          </summary>
          <pre className="max-h-56 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs text-foreground/85">
            {details}
          </pre>
        </details>
      </section>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

function ServerStateBootstrap() {
  useEffect(() => {
    if (!getPrimaryKnownEnvironment()) {
      return;
    }

    return startServerStateSync(getPrimaryEnvironmentConnection().client.server);
  }, []);

  return null;
}

function AuthenticatedTracingBootstrap() {
  useEffect(() => {
    void configureClientTracing();
  }, []);

  return null;
}

function EnvironmentConnectionManagerBootstrap() {
  const queryClient = useQueryClient();

  useEffect(() => {
    return startEnvironmentConnectionService(queryClient);
  }, [queryClient]);

  return null;
}

/**
 * Try to restore the last focused thread from the persisted tab state
 * (`projectShellUiStateStore`). Returns `true` if navigation succeeded.
 */
type NavigateFn = (options: any) => Promise<void>;

function normalizeStartupPath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function isRestorableStartupPath(pathname: string, environmentId: EnvironmentId): boolean {
  const normalizedPathname = normalizeStartupPath(pathname);
  if (normalizedPathname === "/") return true;
  return normalizedPathname === `/${environmentId}/projects`;
}

async function restorePersistedTabState(
  navigate: NavigateFn,
  environmentId: EnvironmentId,
): Promise<boolean> {
  const { focusedThreadKeyByProjectKey, recentProjectKeys } =
    useProjectShellUiStateStore.getState();

  // Find the most recent project that has a focused thread.
  const projectKeysInOrder =
    recentProjectKeys.length > 0 ? recentProjectKeys : Object.keys(focusedThreadKeyByProjectKey);

  for (const pKey of projectKeysInOrder) {
    const focusedThreadKey = focusedThreadKeyByProjectKey[pKey];
    if (!focusedThreadKey) continue;

    const threadRef = parseScopedThreadKey(focusedThreadKey);
    if (!threadRef || threadRef.environmentId !== environmentId) continue;

    // Check that the thread still exists in the server-side state.
    const thread = selectThreadByRef(useStore.getState(), threadRef);
    if (!thread) continue;

    // Navigate to the focused thread.
    const navigated = await navigateToProjectThread(navigate, threadRef, {
      replace: true,
    });
    if (navigated) return true;

    // Thread was found but navigation failed — try the next one.
  }

  // If we couldn't navigate to a focused thread, try opening a project's
  // threads list for the first recent project that exists.
  for (const pKey of projectKeysInOrder) {
    const parsed = parseScopedProjectKey(pKey);
    if (!parsed || parsed.environmentId !== environmentId) continue;
    const project = selectProjectByRef(useStore.getState(), parsed);
    if (!project) continue;

    await navigateToProjectThreads(navigate, parsed, { replace: true });
    return true;
  }

  return false;
}

function EventRouter() {
  const setActiveEnvironmentId = useStore((store) => store.setActiveEnvironmentId);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const projectGroupingSettings = useSettings(selectProjectGroupingSettings);
  const readPathname = useEffectEvent(() => pathname);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);
  const restoredInitialTabStateRef = useRef(false);
  const seenServerConfigUpdateIdRef = useRef(getServerConfigUpdatedNotification()?.id ?? 0);
  const lastKeybindingsSuccessToastAtRef = useRef(0);
  const disposedRef = useRef(false);
  const serverConfig = useServerConfig();
  const serverConfigEnvironmentId = serverConfig?.environment.environmentId ?? null;
  const serverConfigEnvironmentBootstrapped = useStore((state) =>
    serverConfigEnvironmentId
      ? selectEnvironmentState(state, serverConfigEnvironmentId).bootstrapComplete
      : false,
  );

  const handleWelcome = useEffectEvent((payload: ServerLifecycleWelcomePayload | null) => {
    if (!payload) return;

    updatePrimaryEnvironmentDescriptor(payload.environment);
    setActiveEnvironmentId(payload.environment.environmentId);
    void (async () => {
      await ensureEnvironmentConnectionBootstrapped(payload.environment.environmentId);
      if (disposedRef.current) {
        return;
      }

      if (!isRestorableStartupPath(readPathname(), payload.environment.environmentId)) {
        restoredInitialTabStateRef.current = true;
        return;
      }

      restoredInitialTabStateRef.current = true;

      // First priority: navigate to the server-provided bootstrap thread.
      if (payload.bootstrapProjectId && payload.bootstrapThreadId) {
        if (handledBootstrapThreadIdRef.current === payload.bootstrapThreadId) {
          return;
        }
        const bootstrapEnvironmentState =
          useStore.getState().environmentStateById[payload.environment.environmentId];
        const bootstrapProject =
          bootstrapEnvironmentState?.projectById[payload.bootstrapProjectId] ?? null;
        const bootstrapProjectKey =
          (bootstrapProject
            ? deriveLogicalProjectKeyFromSettings(bootstrapProject, projectGroupingSettings)
            : null) ??
          (serverConfig?.cwd
            ? derivePhysicalProjectKeyFromPath(payload.environment.environmentId, serverConfig.cwd)
            : null) ??
          scopedProjectKey(
            scopeProjectRef(payload.environment.environmentId, payload.bootstrapProjectId),
          );
        useUiStateStore.getState().setProjectExpanded(bootstrapProjectKey, true);

        const navigated = await navigateToProjectThread(
          navigate,
          {
            environmentId: payload.environment.environmentId,
            threadId: payload.bootstrapThreadId,
          },
          { replace: true },
        );
        if (navigated) {
          handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
          return;
        }
      }

      // Second priority: restore the last focused thread from the persisted
      // tab state (survives app restart in Electron / browser).
      const restored = await restorePersistedTabState(navigate, payload.environment.environmentId);
      if (restored) {
        return;
      }

      // Fallback: navigate to the projects list.
      await navigate({
        to: "/$environmentId/projects",
        params: { environmentId: payload.environment.environmentId },
        replace: true,
      });
    })().catch(() => undefined);
  });

  const handleServerConfigUpdated = useEffectEvent(
    (notification: ServerConfigUpdatedNotification | null) => {
      if (!notification) return;

      const { id, payload, source } = notification;
      if (id <= seenServerConfigUpdateIdRef.current) {
        return;
      }
      seenServerConfigUpdateIdRef.current = id;
      if (source !== "keybindingsUpdated") {
        return;
      }

      const issue = payload.issues.find((entry) => entry.kind.startsWith("keybindings."));
      if (!issue) {
        const now = Date.now();
        if (now - lastKeybindingsSuccessToastAtRef.current < 2_000) {
          return;
        }
        lastKeybindingsSuccessToastAtRef.current = now;
        toastManager.add({
          type: "success",
          title: "Keybindings updated",
          description: "Keybindings configuration reloaded successfully.",
        });
        return;
      }

      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Invalid keybindings configuration",
          description: issue.message,
          actionVariant: "outline",
          actionProps: {
            children: "Open keybindings.json",
            onClick: () => {
              const api = readLocalApi();
              if (!api) {
                return;
              }

              void Promise.resolve(serverConfig ?? api.server.getConfig())
                .then((config) => {
                  const editor = resolveAndPersistPreferredEditor(config.availableEditors);
                  if (!editor) {
                    throw new Error("No available editors found.");
                  }
                  return api.shell.openInEditor(config.keybindingsConfigPath, editor);
                })
                .catch((error) => {
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: "Unable to open keybindings file",
                      description:
                        error instanceof Error ? error.message : "Unknown error opening file.",
                    }),
                  );
                });
            },
          },
        }),
      );
    },
  );

  useEffect(() => {
    if (!serverConfig) {
      return;
    }

    updatePrimaryEnvironmentDescriptor(serverConfig.environment);
    setActiveEnvironmentId(serverConfig.environment.environmentId);
  }, [serverConfig, setActiveEnvironmentId]);

  useEffect(() => {
    if (!serverConfig || !serverConfigEnvironmentBootstrapped) {
      return;
    }
    const environmentId = serverConfig.environment.environmentId;
    if (restoredInitialTabStateRef.current || !isRestorableStartupPath(pathname, environmentId)) {
      return;
    }

    restoredInitialTabStateRef.current = true;
    void (async () => {
      await ensureEnvironmentConnectionBootstrapped(environmentId);
      if (disposedRef.current || !isRestorableStartupPath(readPathname(), environmentId)) {
        return;
      }

      const restored = await restorePersistedTabState(navigate, environmentId);
      if (
        restored ||
        disposedRef.current ||
        !isRestorableStartupPath(readPathname(), environmentId)
      ) {
        return;
      }

      await navigate({
        to: "/$environmentId/projects",
        params: { environmentId },
        replace: true,
      });
    })().catch(() => undefined);
  }, [navigate, pathname, readPathname, serverConfig, serverConfigEnvironmentBootstrapped]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

  useServerWelcomeSubscription(handleWelcome);
  useServerConfigUpdatedSubscription(handleServerConfigUpdated);

  return null;
}
