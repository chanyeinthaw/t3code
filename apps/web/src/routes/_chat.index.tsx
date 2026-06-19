import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { LinkIcon, PlusIcon } from "lucide-react";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";

import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { useSavedEnvironmentRegistryStore } from "../environments/runtime";
import { APP_DISPLAY_NAME } from "~/branding";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedEnvironments = useSavedEnvironmentRegistryStore(
    useShallow((state) => Object.values(state.byId)),
  );

  useEffect(() => {
    const environmentId = primaryEnvironmentId ?? savedEnvironments[0]?.environmentId;
    if (!environmentId) {
      return;
    }
    if (!primaryEnvironmentId && savedEnvironments.length !== 1) {
      return;
    }
    void navigate({
      to: "/$environmentId/projects",
      params: { environmentId },
      replace: true,
    });
  }, [navigate, primaryEnvironmentId, savedEnvironments]);

  if (authGateState.status === "authenticated" && !primaryEnvironmentId) {
    return null;
  }

  if (authGateState.status === "hosted-static" && savedEnvironments.length === 0) {
    return <HostedStaticOnboardingState />;
  }

  if (savedEnvironments.length === 0) {
    return <HostedStaticOnboardingState />;
  }

  if (savedEnvironments.length === 1) {
    return null;
  }

  return <EnvironmentPicker environments={savedEnvironments} />;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});

function EnvironmentPicker({
  environments,
}: {
  environments: Array<{ environmentId: string; label?: string | null; url?: string | null }>;
}) {
  const navigate = useNavigate();
  return (
    <main className="flex h-dvh min-h-0 flex-col overflow-auto bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-10 sm:px-6 lg:px-8">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {APP_DISPLAY_NAME}
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">Choose environment</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Select the environment whose projects you want to browse.
          </p>
        </div>
        <div className="grid gap-2">
          {environments.map((environment) => (
            <button
              key={environment.environmentId}
              type="button"
              className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card/45 p-4 text-left transition-colors hover:bg-accent/55 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() =>
                void navigate({
                  to: "/$environmentId/projects",
                  params: { environmentId: environment.environmentId },
                })
              }
            >
              <span className="size-3 shrink-0 rounded-full bg-emerald-500" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                  {environment.label || environment.environmentId}
                </div>
                {environment.url ? (
                  <div className="truncate text-xs text-muted-foreground">{environment.url}</div>
                ) : null}
              </div>
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}

function HostedStaticOnboardingState() {
  return (
    <main className="flex h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <Empty className="flex-1">
        <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
          <EmptyHeader className="max-w-none">
            <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
              <LinkIcon className="size-5" />
            </div>
            <EmptyTitle className="text-foreground text-xl">
              Connect an environment to get started
            </EmptyTitle>
            <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
              Open a pairing link from your Pulse desktop app or add a reachable backend manually.
              Your saved environments stay in this browser.
            </EmptyDescription>
            <div className="mt-6 flex justify-center">
              <Button render={<a href="/settings/connections" />} size="sm">
                <PlusIcon className="size-4" />
                Add environment
              </Button>
            </div>
          </EmptyHeader>
        </div>
      </Empty>
    </main>
  );
}
