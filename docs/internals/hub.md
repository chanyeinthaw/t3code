# Hub architecture

The hub connects clients to execution environments. Each environment establishes an
outbound connection to one hub. Clients discover that hub's environments and
keep concurrent sessions with them. Execution machines need no public listener;
only the hub needs to be reachable from other machines.

The hub lives in `apps/server` and is distinct from the T3 Connect relay.
Tailscale or a relay can expose its listener without changing environment
routing.

## Ownership and routing

The hub owns connectivity and an in-memory environment catalog. Environments own
projects, provider sessions, threads, files, terminals, and checkpoints. Moving
an environment to another hub preserves its environment identity and local state.

The hub also persists agent configurations and their environment and thread
references. The selected environment owns each agent's conversation and working
directory. Switching hubs preserves environment state but does not migrate the
hub's agent registry. See [OneChat.ts](../../apps/server/src/oneChat/OneChat.ts)
for registry ownership.

Each request identifies its destination through
`/hub/environments/<environmentId>/...`. The hub multiplexes HTTP and WebSocket
traffic through that environment's outbound tunnel. Clients retain this route for
RPC and asset requests; they must not learn direct environment fallback URLs. A
browser-wide machine selection would make concurrent environment sessions
ambiguous.

The catalog retains disconnected entries until the hub restarts or switches to
another hub. It is not a durable machine registry. Revoking an environment blocks its
credential and disconnects its tunnel, but leaves the catalog entry offline.
See [HubServer.ts](../../apps/server/src/hub/HubServer.ts)
for transport ownership and [EnvironmentTunnel.ts](../../apps/server/src/hub/EnvironmentTunnel.ts)
for the environment connection.

## Client origin

The client connects automatically through its own origin. Serving the app over
Tailscale or a network address must not cause its browser to dial localhost.
Electron starts the client, hub, and local environment by default and loads the
client from its installation's HTTP listener. Hub selection and first-run
onboarding are bypassed, but an unpaired browser still needs a hub credential.

A client listener can host a hub or forward hub traffic to a remote hub. The
listener stays available in either mode, keeping the browser's URL stable.
Client-only mode uses the same forwarding path without starting a hub or environment.
See [HubHost.ts](../../apps/server/src/hub/HubHost.ts) for runtime ownership and
[the user guide](../user/remote-access.md#connect-through-a-hub) for CLI modes.

## Public URL behind a proxy

A tunnel can expose the client and hub under a domain while the listener binds
to a local address. `--public-url` declares that external origin for hosting
commands. It controls startup and CLI pairing links without changing the bind
address or the client's connection target. The browser still uses the origin
it opened. Environments have no public client endpoint and use `--hub` for their
outbound connection.

A proxy can rewrite the HTTP Host header while retaining the browser's Origin.
For HTTP mutations and WebSocket upgrades, the hub accepts the configured
public origin or an Origin whose host matches the HTTP Host header. Requests
without Origin still require authentication where the endpoint is protected.
An HTTPS public URL also makes pairing cookies Secure when the proxy forwards
HTTP locally. This keeps access
checks independent of proxy header conventions. See
[authHttp.ts](../../apps/server/src/hub/authHttp.ts) for origin validation.

Service installation persists the hosting command and its public URL across
restarts and updates. DNS, TLS, and WebSocket forwarding belong to the tunnel or
reverse proxy. See [the service guide](../user/background-service.md) for setup.

## Switching hubs

Settings > Hub changes the hub for the serving installation, not just
for one browser. The installation stops local enrollment, disconnects its local
catalog, and reconnects its environment to the selected hub. Its client listener
then forwards hub traffic to that hub through the existing origin. Active
client sockets close so clients rediscover environments on the new hub.

Selecting the local hub reverses this. Client-only listeners cannot select a
local hub. If attachment or persistence fails, the runtime attempts to restore
the previous connection. A successful switch persists the choice in the
installation's Pulse state directory. Clients can still open connection
settings when the selected hub is unavailable.

Switching requires the serving installation's own admin session. A destination
pairing code authorizes its client connection; a separate environment invitation is
required when that environment has no saved credential for the destination. Neither
credential changes the destination installation's configuration. Switching is
not a transaction across hubs. A failed attempt can still consume a pairing
code or environment invitation on the destination.

## Authentication

Clients pair with the hub once. The hub owns pairing grants, client sessions,
revocation, and environment enrollment. Hub authentication reuses `EnvironmentAuth`,
`SessionStore`, and `PairingGrantStore` with hub-owned storage. `pulse hub pair` replaces the old
top-level pairing command for this client path. Each environment retains its RPC
scope checks.
Client sessions and machine credentials have separate audiences. A machine
credential is bound to an environment ID and cannot authorize client requests.

Client roles map to scopes across the hub's environments, not per-environment
access lists. Standard clients can operate agents and terminals. Read-only
clients have read scopes. Hub admins can issue pairing links and environment
invitations and revoke access. The serving installation's startup credential
grants admin access to its own hub.

The hub forwards a verified client principal through the enrolled tunnel. The
environment bridge authenticates loopback requests with a per-launch secret, binding
the principal to the method, path, and expiry. Loopback access alone grants no
execution permissions. Closing a revoked client's hub connections also closes
its downstream streams; already-running agent turns continue.

Hub auth uses a separate state directory and identity. Its Effect storage layer
must be fresh: sharing the environment's persistence layer memoization would make
both runtimes use the same database despite their different configurations.
See [HubAuth.ts](../../apps/server/src/hub/HubAuth.ts).

The client gateway validates browser origins and forwards only destination
hub credentials. Its own local hub session stays on the installation and
continues to authorize hub switching when the destination is unavailable.
Switching never changes the destination hub's configuration.

## Client settings ownership

The Hub page is separate from the original Connections page so upstream syncs
do not have to merge changes to that page. The original route remains available
at `/settings/connections`; the sidebar exposes `/settings/hub-connections`.
Hub-specific components reuse or adapt the existing connection UI.

Disabling an environment changes only this client's connections. It does not
stop the environment or revoke access for other clients. Environment revocation belongs
to the hub and affects every client. See
[HubConnectionsSettings.tsx](../../apps/web/src/components/settings/HubConnectionsSettings.tsx)
for the client boundary.

## Orchestration boundary

Client access to multiple environments does not give a provider session the same
reach. Provider MCP calls use the calling environment's services and projections.
Delegated tasks rely on parent threads and runs in that environment's database.
Forwarding a delegated-task command to another environment would leave its parent
records unresolved. See
[OrchestratorMcpService.ts](../../apps/server/src/mcp/OrchestratorMcpService.ts).

The tunnel currently routes client requests from the hub to an environment. It
has no environment-originated orchestration request or remote task-completion
delivery. Environment enrollment authorizes tunnel connectivity, not permission
to execute agent operations on other environments. Cross-environment orchestration
therefore requires explicit delegated authority and durable links between the
source's parent task and the destination's execution state.

## Current limits

Web and desktop share hub authentication and connection settings. Mobile hub
discovery still needs integration. MCP OAuth remains environment-owned and is
not exposed through hub client sessions. The Copy MCP URL control does not
imply that hub client authentication supports MCP.
