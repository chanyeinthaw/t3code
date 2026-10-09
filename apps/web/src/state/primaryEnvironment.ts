import { Atom } from "effect/reactivity";

import { readHubPrimaryEnvironment } from "../hub";

import { environmentCatalog } from "../connection/catalog";

export const primaryEnvironmentIdAtom = Atom.make((get) => {
  const hubPrimary = readHubPrimaryEnvironment();
  for (const [environmentId, entry] of get(environmentCatalog.catalogValueAtom).entries) {
    if (
      entry.target._tag === "PrimaryConnectionTarget" ||
      (entry.target._tag === "HubConnectionTarget" && environmentId === hubPrimary?.environmentId)
    ) {
      return environmentId;
    }
  }
  return null;
}).pipe(Atom.withLabel("web-primary-environment-id"));
