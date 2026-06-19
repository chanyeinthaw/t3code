import {
  PiSettings,
  ProviderDriverKind,
  type ProviderInstanceEnvironment,
  type ServerProvider,
} from "@pulse/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makePiAdapter, type PiAdapterEnv } from "../Layers/PiAdapter.ts";
import { checkPiProviderStatus, makePendingPiProvider } from "../Layers/PiProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { ServerEnvironment } from "../../environment/Services/ServerEnvironment.ts";

const DRIVER_KIND = ProviderDriverKind.make("pi");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const decodePiSettings = Schema.decodeSync(PiSettings);

export type PiDriverEnv = PiAdapterEnv | ProviderEventLoggers | ServerEnvironment;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

function withTemporaryEnvironment<T>(environment: NodeJS.ProcessEnv, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function createPiRegistries(input: {
  readonly settings: PiSettings;
  readonly environment: ProviderInstanceEnvironment;
}) {
  const processEnv = mergeProviderInstanceEnvironment(input.environment);
  return withTemporaryEnvironment(processEnv, () => {
    const authStorage = AuthStorage.create(
      input.settings.agentDir ? `${input.settings.agentDir}/auth.json` : undefined,
    );
    const modelRegistry = ModelRegistry.create(
      authStorage,
      input.settings.agentDir ? `${input.settings.agentDir}/models.json` : undefined,
    );
    return { authStorage, modelRegistry, processEnv };
  });
}

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Pi",
    supportsMultipleInstances: true,
  },
  configSchema: PiSettings,
  defaultConfig: (): PiSettings => decodePiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const eventLoggers = yield* ProviderEventLoggers;
      const serverEnvironment = yield* ServerEnvironment;
      const environmentId = yield* serverEnvironment.getEnvironmentId;
      const effectiveConfig = { ...config, enabled } satisfies PiSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const { authStorage, modelRegistry, processEnv } = yield* Effect.try({
        try: () => createPiRegistries({ settings: effectiveConfig, environment }),
        catch: (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: "@earendil-works/pi-coding-agent",
      });
      const adapter = yield* makePiAdapter(effectiveConfig, {
        instanceId,
        authStorage,
        modelRegistry,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        environmentId,
      });
      const textGeneration = yield* makePiTextGeneration({
        settings: effectiveConfig,
        authStorage,
        modelRegistry,
      });
      const checkProvider = checkPiProviderStatus({
        settings: effectiveConfig,
        modelRegistry,
      }).pipe(Effect.map(stampIdentity));
      const snapshot = yield* makeManagedServerProvider<PiSettings>({
        maintenanceCapabilities,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          makePendingPiProvider(settings).pipe(Effect.map(stampIdentity)),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Pi snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
