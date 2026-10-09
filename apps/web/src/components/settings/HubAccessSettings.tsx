import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { EnvironmentIconMenu } from "./EnvironmentIconPicker";
import {
  HubAccessSnapshot,
  HubEnvironmentCatalog,
  HubIssuedCredential,
  HubSessionState,
  HubAccessRole,
  type EnvironmentId,
  type HubAccessRole as Role,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { PlusIcon, EllipsisIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Alert, AlertDescription } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { RadioGroup, Radio } from "../ui/radio-group";
import { ScrollArea } from "../ui/scroll-area";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { HubFoldedSettingsSection } from "./HubFoldedSettingsSection";
import { PairingClientsList, PairingLinkListRow } from "./PairingAccessList";
import { PairingCredentialDialog } from "./PairingCredentialDialog";
import { EnvironmentRow } from "./EnvironmentRow";
import { ToggleGroup, Toggle } from "../ui/toggle-group";

const decodeSession = Schema.decodeUnknownSync(HubSessionState);
const decodeCatalog = Schema.decodeUnknownSync(HubEnvironmentCatalog);
const decodeAccess = Schema.decodeUnknownSync(HubAccessSnapshot);
const decodeIssued = Schema.decodeUnknownSync(HubIssuedCredential);
const decodeRole = Schema.decodeUnknownSync(HubAccessRole);
const roles = {
  "read-only": { label: "Read-only", description: "View projects, threads, files, and diffs." },
  standard: { label: "Standard", description: "Run agents, edit files, and use terminals." },
  admin: { label: "Admin", description: "Standard access, plus manage clients and environments." },
};
async function request(path: string, input?: unknown, signal?: AbortSignal) {
  const response = await fetch(`/hub/auth/${path}`, {
    ...(signal ? { signal } : {}),
    ...(input === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
  });
  if (!response.ok)
    throw new Error(
      response.status === 403
        ? "Hub administrator access is required."
        : "Could not update hub access.",
    );
  const value: unknown = await response.json();
  return value;
}

export function HubAccessSettings({
  renderEnvironment,
}: {
  renderEnvironment: (environmentId: EnvironmentId, menuItems: ReactNode) => ReactNode;
}) {
  const [session, setSession] = useState<HubSessionState | null>(null);
  const [access, setAccess] = useState<HubAccessSnapshot | null>(null);
  const [catalog, setCatalog] = useState<HubEnvironmentCatalog | null>(null);
  const [clientView, setClientView] = useState("clients");
  const [environmentView, setEnvironmentView] = useState("environments");
  const [dialog, setDialog] = useState<"pair" | "environment" | null>(null);
  const [role, setRole] = useState<Role>("standard");
  const [ttlMinutes, setTtlMinutes] = useState(10);
  const [label, setLabel] = useState("");
  // Credentials are only returned at creation and stay in this page's memory for sharing.
  const [credentials, setCredentials] = useState<ReadonlyMap<string, string>>(new Map());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<{
    kind: "session" | "pairing";
    id: string;
    label: string;
  } | null>(null);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const current = decodeSession(await request("session", undefined, signal));
    const response = await fetch("/hub/environments", signal ? { signal } : {});
    if (!response.ok) throw new Error("Could not load environments.");
    const environments = decodeCatalog(await response.json());
    const next =
      current.role === "admin" ? decodeAccess(await request("access", undefined, signal)) : null;
    if (signal?.aborted) return;
    setSession(current);
    setCatalog(environments);
    setAccess(next);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      void refresh(controller.signal).catch(() => {
        if (!controller.signal.aborted) setError("Could not load hub access.");
      });
    load();
    const timer = window.setInterval(() => {
      if (!document.hidden) load();
    }, 10_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);
  async function create() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const issued = decodeIssued(
        await request(
          dialog === "environment" ? "invitations" : "pairing",
          dialog === "environment"
            ? { label: label.trim() || undefined }
            : { role, label: label.trim() || undefined, ttlMinutes },
        ),
      );
      setCredentials((current) => new Map(current).set(issued.id, issued.credential));
      await refresh();
      if (dialog === "environment") setEnvironmentView("invitations");
      else setClientView("links");
      setDialog(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create invitation.");
    } finally {
      setPending(false);
    }
  }
  async function confirmRevoke() {
    if (!revoke || pending) return;
    setPending(true);
    setError(null);
    try {
      await request("revoke", { kind: revoke.kind, id: revoke.id });
      setCredentials((current) => {
        const next = new Map(current);
        next.delete(revoke.id);
        return next;
      });
      setRevoke(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke access.");
    } finally {
      setPending(false);
    }
  }
  const admin = session?.role === "admin";
  function open(kind: "pair" | "environment") {
    setDialog(kind);
    setLabel("");
    setRole("standard");
    setTtlMinutes(10);
    setError(null);
  }
  const pairingLinks = (access?.pairingLinks ?? [])
    .map((link) => ({
      ...link,
      scopes: link.permissions ?? link.scopes,
      createdAt: DateTime.formatIso(link.createdAt),
      expiresAt: DateTime.formatIso(link.expiresAt),
    }))
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  const clients = (access?.clients ?? [])
    .map((client) => ({
      ...client,
      scopes: client.permissions ?? client.scopes,
      issuedAt: DateTime.formatIso(client.issuedAt),
      expiresAt: DateTime.formatIso(client.expiresAt),
      lastConnectedAt: client.lastConnectedAt ? DateTime.formatIso(client.lastConnectedAt) : null,
    }))
    .toSorted(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        Number(b.connected) - Number(a.connected) ||
        b.issuedAt.localeCompare(a.issuedAt),
    );
  const accessLabels = new Map([
    ...(access?.clients ?? []).map(
      (client) => [client.sessionId, roles[client.role].label] as const,
    ),
    ...(access?.pairingLinks ?? []).map((link) => [link.id, roles[link.role].label] as const),
  ]);
  const invitations = access?.invitations ?? [];
  // An enrolled environment may never have connected during this hub process's lifetime.
  const environments = new Map(
    (catalog?.environments ?? []).map((environment) => [environment.environmentId, environment]),
  );
  for (const enrolledEnvironment of access?.environments ?? access?.daemons ?? []) {
    if (!environments.has(enrolledEnvironment.environmentId))
      environments.set(enrolledEnvironment.environmentId, {
        environmentId: enrolledEnvironment.environmentId,
        label: enrolledEnvironment.label,
        connected: false,
      });
  }
  return (
    <>
      <SettingsSection
        title="Environments"
        headerAction={
          admin ? (
            <Button size="xs" variant="outline" onClick={() => open("environment")}>
              <PlusIcon aria-hidden />
              Add environment
            </Button>
          ) : undefined
        }
      >
        {admin ? (
          <div className="px-3 py-3 sm:px-4">
            <ToggleGroup
              value={[environmentView]}
              onValueChange={(values) => {
                if (values[0]) setEnvironmentView(values[0]);
              }}
              aria-label="Environment access"
            >
              <Toggle value="environments">Environments ({environments.size})</Toggle>
              <Toggle value="invitations">Invitations ({invitations.length})</Toggle>
            </ToggleGroup>
          </div>
        ) : null}
        {environmentView === "invitations"
          ? invitations.map((invitation) => (
              <PairingLinkListRow
                key={invitation.id}
                pairingLink={{ ...invitation, scopes: [] }}
                {...(credentials.has(invitation.id)
                  ? {
                      command: `pulse environment --hub ${window.location.origin} --invitation ${credentials.get(invitation.id)}`,
                      initiallyExpanded: true,
                    }
                  : {})}
                credentialKind="code"
                defaultLabel="Environment invitation"
                accessLabel="Awaiting enrollment"
                credential={credentials.get(invitation.id)}
                endpointUrl={null}
                endpoints={[]}
                defaultEndpointKey={null}
                revokingPairingLinkId={pending && revoke?.kind === "pairing" ? revoke.id : null}
                canRevoke={!pending}
                onRevoke={() =>
                  setRevoke({
                    kind: "pairing",
                    id: invitation.id,
                    label: invitation.label ?? "environment invitation",
                  })
                }
              />
            ))
          : null}
        {environmentView === "environments" ? (
          <>
            {[...environments.values()].map((environment) => {
              const actions = admin ? (
                <>
                  {(access?.environments ?? access?.daemons ?? [])
                    .filter(
                      (enrolledEnvironment) =>
                        enrolledEnvironment.environmentId === environment.environmentId,
                    )
                    .map((enrolledEnvironment) => (
                      <MenuItem
                        key={enrolledEnvironment.sessionId}
                        variant="destructive"
                        disabled={pending}
                        onClick={() =>
                          setRevoke({
                            kind: "session",
                            id: enrolledEnvironment.sessionId,
                            label: enrolledEnvironment.label,
                          })
                        }
                      >
                        Revoke environment…
                      </MenuItem>
                    ))}
                </>
              ) : null;
              return (
                renderEnvironment(
                  environment.environmentId,
                  actions ? (
                    <>
                      <MenuSeparator />
                      {actions}
                    </>
                  ) : null,
                ) ?? (
                  <EnvironmentRow
                    key={environment.environmentId}
                    kind="server"
                    label={environment.label}
                    subtitle="Disconnected"
                  >
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            variant="ghost-muted"
                            size="icon-xs"
                            aria-label={`More actions for ${environment.label}`}
                          />
                        }
                      >
                        <EllipsisIcon />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <EnvironmentIconMenu
                          environmentId={environment.environmentId}
                          serverConfig={null}
                        />
                        {actions ? (
                          <>
                            <MenuSeparator />
                            {actions}
                          </>
                        ) : null}
                      </MenuPopup>
                    </Menu>
                  </EnvironmentRow>
                )
              );
            })}
            {catalog === null ? (
              <SettingsRow title="Loading environments…" />
            ) : environments.size === 0 ? (
              <SettingsRow title="No environments connected" />
            ) : null}
          </>
        ) : invitations.length === 0 ? (
          <SettingsRow title="No pending invitations" />
        ) : null}
      </SettingsSection>
      {admin ? (
        <HubFoldedSettingsSection
          id="authorized-clients"
          title="Authorized clients"
          defaultOpen
          summary={`${clients.length} ${clients.length === 1 ? "client" : "clients"}${pairingLinks.length ? ` · ${pairingLinks.length} ${pairingLinks.length === 1 ? "pairing link" : "pairing links"}` : ""}`}
          control={
            <Button size="xs" onClick={() => open("pair")}>
              <PlusIcon aria-hidden />
              Create link
            </Button>
          }
        >
          <div className="px-3 py-3 sm:px-4">
            <ToggleGroup
              value={[clientView]}
              onValueChange={(values) => {
                if (values[0]) setClientView(values[0]);
              }}
              aria-label="Client access"
            >
              <Toggle value="clients">Clients ({clients.length})</Toggle>
              <Toggle value="links">Pairing links ({pairingLinks.length})</Toggle>
            </ToggleGroup>
          </div>
          <ScrollArea scrollFade chainVerticalScroll className="max-h-[22.5rem]">
            <div className="divide-y divide-border/50">
              <PairingClientsList
                endpointUrl={null}
                endpoints={[]}
                defaultEndpointKey={null}
                isLoading={access === null}
                expandCreated
                pairingLinks={clientView === "links" ? pairingLinks : []}
                createdPairingCredentials={credentials}
                clientSessions={clientView === "clients" ? clients : []}
                accessLabels={accessLabels}
                revokingPairingLinkId={pending && revoke?.kind === "pairing" ? revoke.id : null}
                revokingClientSessionId={pending && revoke?.kind === "session" ? revoke.id : null}
                canRevoke={!pending}
                onRevokePairingLink={(id) =>
                  setRevoke({
                    kind: "pairing",
                    id,
                    label: pairingLinks.find((link) => link.id === id)?.label ?? "pairing link",
                  })
                }
                onRevokeClientSession={(id) =>
                  setRevoke({
                    kind: "session",
                    id,
                    label:
                      clients.find((client) => client.sessionId === id)?.client.label ?? "client",
                  })
                }
              />
            </div>
          </ScrollArea>
        </HubFoldedSettingsSection>
      ) : session ? (
        <SettingsSection title="Your access">
          <SettingsRow title={session.role ? roles[session.role].label : "Hub unavailable"} />
        </SettingsSection>
      ) : null}
      {error && !dialog && !revoke ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <PairingCredentialDialog
        open={dialog !== null}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
        }}
        title={dialog === "environment" ? "Create environment invitation" : "Create pairing link"}
        label={label}
        onLabelChange={setLabel}
        labelTitle={
          dialog === "environment" ? "Environment label (optional)" : "Client label (optional)"
        }
        labelPlaceholder={dialog === "environment" ? "e.g. Work laptop" : "e.g. Living room iPad"}
        pending={pending}
        submitLabel={dialog === "environment" ? "Create invitation" : "Create link"}
        onCreate={() => void create()}
      >
        {dialog === "pair" ? (
          <>
            <section className="space-y-3">
              <h3 className="text-xs font-medium text-foreground">Permissions</h3>
              <RadioGroup
                value={role}
                onValueChange={(value) => setRole(decodeRole(value))}
                disabled={pending}
              >
                <div className="divide-y divide-border/60 rounded-lg border border-input bg-muted/25">
                  {Object.entries(roles).map(([value, option]) => (
                    <label
                      key={value}
                      className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-muted/40"
                    >
                      <Radio value={value} />
                      <span className="min-w-0">
                        <span className="block text-xs font-medium text-foreground">
                          {option.label}
                        </span>
                        <span className="block text-xs leading-snug text-muted-foreground">
                          {option.description}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </RadioGroup>
              {role === "admin" ? (
                <p className="text-xs text-warning">
                  This client can create or revoke access for other devices.
                </p>
              ) : null}
            </section>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Link expires in
              </span>
              <Select
                value={String(ttlMinutes)}
                onValueChange={(value) => setTtlMinutes(Number(value))}
                disabled={pending}
              >
                <SelectTrigger>
                  <SelectValue>
                    {ttlMinutes === 10 ? "10 minutes" : ttlMinutes === 60 ? "1 hour" : "24 hours"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="10">10 minutes</SelectItem>
                  <SelectItem value="60">1 hour</SelectItem>
                  <SelectItem value="1440">24 hours</SelectItem>
                </SelectPopup>
              </Select>
            </label>
          </>
        ) : (
          <code className="block break-all text-xs text-muted-foreground">
            pulse environment --hub {window.location.origin} --invitation &lt;code&gt;
          </code>
        )}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </PairingCredentialDialog>
      <AlertDialog
        open={revoke !== null}
        onOpenChange={(next) => {
          if (!next && !pending) setRevoke(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revoke?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              {revoke?.kind === "pairing"
                ? "This invitation will no longer grant access."
                : "This device will be disconnected and need a new invitation to reconnect."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={pending} />}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={pending} onClick={() => void confirmRevoke()}>
              {pending ? "Revoking…" : "Revoke"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
