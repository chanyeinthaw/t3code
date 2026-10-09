import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PairingRouteSurface } from "../components/auth/PairingRouteSurface";

export const Route = createFileRoute("/pair")({ component: PairRoute });
function PairRoute() {
  const navigate = useNavigate();
  return (
    <PairingRouteSurface
      auth={{
        policy: "remote-reachable",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie", "bearer-access-token"],
        sessionCookieName: "hub",
      }}
      onAuthenticated={() => void navigate({ to: "/", replace: true })}
    />
  );
}
