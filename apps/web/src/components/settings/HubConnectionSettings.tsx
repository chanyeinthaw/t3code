import { parsePairingUrlFields } from "./hubPairingUrls";
import { HubConnectionState, HubSessionState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const decodeSession = Schema.decodeUnknownSync(HubSessionState);
const decodeConnection = Schema.decodeUnknownSync(HubConnectionState);

export function HubConnectionSettings() {
  const [pairingCode, setPairingCode] = useState("");
  const [environmentInvitation, setEnvironmentInvitation] = useState("");
  const [canSwitch, setCanSwitch] = useState(false);
  const [hubRole, setHubRole] = useState<string | null>(null);
  const [hasEnvironment, setHasEnvironment] = useState(false);
  const [hubUrl, setHubUrl] = useState("");
  const [currentHub, setCurrentHub] = useState<string | null | undefined>(undefined);
  const [localHubAvailable, setLocalHubAvailable] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/hub/connection", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not read hub connection.");
        const connection = decodeConnection(await response.json());
        const ownerResponse = await fetch("/hub/local-auth/session", { signal: controller.signal });
        if (ownerResponse.ok)
          setCanSwitch(decodeSession(await ownerResponse.json()).role === "admin");
        const sessionResponse = await fetch("/hub/auth/session", { signal: controller.signal });
        if (sessionResponse.ok)
          setHubRole(decodeSession(await sessionResponse.json()).role ?? null);
        setCurrentHub(connection.hubUrl);
        setLocalHubAvailable(connection.localHubAvailable);
        setHasEnvironment(
          connection.localEnvironmentAvailable ?? connection.localDaemonAvailable ?? false,
        );
        setHubUrl(connection.hubUrl ?? "");
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Could not read hub connection.");
      });
    return () => controller.abort();
  }, []);

  async function switchHub(url: string | null) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/hub/connection", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hubUrl: url,
          ...(url
            ? { pairingCode, environmentInvitation, daemonInvitation: environmentInvitation }
            : {}),
        }),
      });
      if (!response.ok) throw new Error("Could not connect to that hub.");
      window.location.assign("/settings/hub-connections");
    } catch {
      setError("Could not connect to that hub.");
      setPending(false);
    }
  }

  return (
    <SettingsSection title="Hub">
      <SettingsRow
        title={
          currentHub === undefined
            ? "Hub connection"
            : currentHub === null
              ? "Local hub"
              : "Remote hub"
        }
        description={
          currentHub === undefined ? (error ?? "Loading…") : (currentHub ?? window.location.origin)
        }
        status={
          hubRole
            ? hubRole === "read-only"
              ? "Read-only"
              : hubRole === "admin"
                ? "Admin"
                : "Standard"
            : undefined
        }
        control={
          canSwitch ? (
            <div className="flex flex-wrap items-center gap-2">
              {currentHub != null && localHubAvailable ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void switchHub(null)}
                >
                  {pending && !dialogOpen ? "Switching…" : "Use local hub"}
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="outline"
                disabled={pending || currentHub === undefined}
                onClick={() => {
                  setHubUrl(currentHub ?? "");
                  setPairingCode("");
                  setEnvironmentInvitation("");
                  setError(null);
                  setDialogOpen(true);
                }}
              >
                Change hub
              </Button>
            </div>
          ) : undefined
        }
      >
        {error && currentHub !== undefined && !dialogOpen ? (
          <p role="alert" className="pb-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </SettingsRow>
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!pending) setDialogOpen(open);
        }}
      >
        <DialogPopup
          className="max-w-md"
          aria-describedby={undefined}
          render={
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (hubUrl.trim() && !pending) void switchHub(hubUrl.trim());
              }}
            />
          }
        >
          <DialogHeader>
            <DialogTitle>Change hub</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-2">
              <label htmlFor="connection-hub-url" className="text-xs font-medium">
                Hub URL or pairing link
              </label>
              <Input
                id="connection-hub-url"
                type="url"
                value={hubUrl}
                autoFocus
                required
                placeholder="https://hub.example.com"
                disabled={pending}
                aria-invalid={error !== null}
                aria-describedby={error ? "connection-hub-error" : undefined}
                onChange={(event) => {
                  const pairing = parsePairingUrlFields(event.target.value);
                  setHubUrl(pairing?.host ?? event.target.value);
                  if (pairing) setPairingCode(pairing.pairingCode);
                  setError(null);
                }}
              />
              <label htmlFor="connection-pairing-code" className="text-xs font-medium">
                Pairing code
              </label>
              <Input
                id="connection-pairing-code"
                value={pairingCode}
                required
                disabled={pending}
                autoComplete="off"
                onChange={(e) => setPairingCode(e.target.value)}
                placeholder="Code from the destination hub"
              />
              {hasEnvironment ? (
                <>
                  <label
                    htmlFor="connection-environment-invitation"
                    className="text-xs font-medium"
                  >
                    Environment invitation
                  </label>
                  <Input
                    id="connection-environment-invitation"
                    value={environmentInvitation}
                    disabled={pending}
                    autoComplete="off"
                    onChange={(e) => setEnvironmentInvitation(e.target.value)}
                    placeholder="Invitation for this machine’s environment"
                  />
                </>
              ) : null}
              {error ? (
                <p id="connection-hub-error" role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter variant="bare">
            <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>
              Cancel
            </DialogClose>
            <Button
              type="submit"
              disabled={
                pending || !hubUrl.trim() || !pairingCode.trim() || hubUrl.trim() === currentHub
              }
            >
              {pending ? "Connecting…" : "Connect"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}
