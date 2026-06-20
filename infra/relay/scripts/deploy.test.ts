import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  hasDeployChanges,
  publicConfigFromOutput,
  reconcileRootEnvPublicConfig,
  reconcileRootEnvRelayUrl,
  serializeGithubOutput,
  serializeRelayClientTracingEnvironment,
} from "./deploy.ts";

describe("hasDeployChanges", () => {
  it("detects resource, binding, and deletion changes", () => {
    expect(hasDeployChanges({ resources: {}, deletions: {} } as never)).toBe(false);
    expect(
      hasDeployChanges({
        resources: {
          api: { action: "create", bindings: [] },
        },
        deletions: {},
      } as never),
    ).toBe(true);
    expect(
      hasDeployChanges({
        resources: {
          api: { action: "noop", bindings: [{ action: "update" }] },
        },
        deletions: {},
      } as never),
    ).toBe(true);
    expect(
      hasDeployChanges({
        resources: {},
        deletions: {
          api: { action: "delete", bindings: [] },
        },
      } as never),
    ).toBe(true);
  });
});

describe("reconcileRootEnvRelayUrl", () => {
  it("adds the relay URL to an empty root env file", () => {
    expect(reconcileRootEnvRelayUrl("", "https://relay.example.test")).toBe(
      "PULSE_RELAY_URL=https://relay.example.test\n",
    );
  });

  it("preserves unrelated root env entries while replacing a previous relay URL", () => {
    expect(
      reconcileRootEnvRelayUrl(
        "PULSE_CLERK_PUBLISHABLE_KEY=pk_test_example\nPULSE_RELAY_URL=https://old.example.test\n",
        "https://relay.example.test",
      ),
    ).toBe(
      "PULSE_CLERK_PUBLISHABLE_KEY=pk_test_example\nPULSE_RELAY_URL=https://relay.example.test\n",
    );
  });
});

describe("reconcileRootEnvPublicConfig", () => {
  const config = {
    relayUrl: "https://relay.example.test",
    mobileTracingUrl: "https://api.axiom.co/v1/traces",
    mobileTracingDataset: "pulse-mobile-traces-dev",
    mobileTracingToken: "xaat-public-ingest",
    clientTracingUrl: "https://api.axiom.co/v1/traces",
    clientTracingDataset: "pulse-relay-client-traces-dev",
    clientTracingToken: "xaat-relay-client-ingest",
  } as const;

  it("adds the complete local client config", () => {
    expect(reconcileRootEnvPublicConfig("", config)).toBe(
      [
        "PULSE_RELAY_URL=https://relay.example.test",
        "PULSE_MOBILE_OTLP_TRACES_URL=https://api.axiom.co/v1/traces",
        "PULSE_MOBILE_OTLP_TRACES_DATASET=pulse-mobile-traces-dev",
        "PULSE_MOBILE_OTLP_TRACES_TOKEN=xaat-public-ingest",
        "PULSE_RELAY_CLIENT_OTLP_TRACES_URL=https://api.axiom.co/v1/traces",
        "PULSE_RELAY_CLIENT_OTLP_TRACES_DATASET=pulse-relay-client-traces-dev",
        "PULSE_RELAY_CLIENT_OTLP_TRACES_TOKEN=xaat-relay-client-ingest",
        "",
      ].join("\n"),
    );
  });

  it("replaces stale values while preserving unrelated entries", () => {
    expect(
      reconcileRootEnvPublicConfig(
        [
          "PULSE_CLERK_PUBLISHABLE_KEY=pk_test_example",
          "PULSE_RELAY_URL=https://old.example.test",
          "PULSE_MOBILE_OTLP_TRACES_URL=https://old.example.test/v1/traces",
          "PULSE_MOBILE_OTLP_TRACES_DATASET=old-dataset",
          "PULSE_MOBILE_OTLP_TRACES_TOKEN=old-token",
          "PULSE_RELAY_CLIENT_OTLP_TRACES_URL=https://old.example.test/v1/traces",
          "PULSE_RELAY_CLIENT_OTLP_TRACES_DATASET=old-client-dataset",
          "PULSE_RELAY_CLIENT_OTLP_TRACES_TOKEN=old-client-token",
          "",
        ].join("\n"),
        config,
      ),
    ).toBe(
      [
        "PULSE_CLERK_PUBLISHABLE_KEY=pk_test_example",
        "PULSE_RELAY_URL=https://relay.example.test",
        "PULSE_MOBILE_OTLP_TRACES_URL=https://api.axiom.co/v1/traces",
        "PULSE_MOBILE_OTLP_TRACES_DATASET=pulse-mobile-traces-dev",
        "PULSE_MOBILE_OTLP_TRACES_TOKEN=xaat-public-ingest",
        "PULSE_RELAY_CLIENT_OTLP_TRACES_URL=https://api.axiom.co/v1/traces",
        "PULSE_RELAY_CLIENT_OTLP_TRACES_DATASET=pulse-relay-client-traces-dev",
        "PULSE_RELAY_CLIENT_OTLP_TRACES_TOKEN=xaat-relay-client-ingest",
        "",
      ].join("\n"),
    );
  });
});

describe("serializeGithubOutput", () => {
  it("serializes relay deploy metadata for GitHub Actions outputs", () => {
    expect(
      serializeGithubOutput({
        changed: false,
        result: "noop",
        relay_url: "https://relay.example.test",
      }),
    ).toBe("changed=false\nresult=noop\nrelay_url=https://relay.example.test\n");
  });
});

describe("serializeRelayClientTracingEnvironment", () => {
  it("serializes tracing config for downstream GITHUB_ENV loading", () => {
    expect(
      serializeRelayClientTracingEnvironment({
        relayUrl: "https://relay.example.test",
        mobileTracingUrl: "https://api.axiom.co/v1/traces",
        mobileTracingDataset: "mobile",
        mobileTracingToken: "mobile-token",
        clientTracingUrl: "https://api.axiom.co/v1/traces",
        clientTracingDataset: "relay",
        clientTracingToken: "client-token",
      }),
    ).toBe(
      [
        "PULSE_RELAY_CLIENT_OTLP_TRACES_URL=https://api.axiom.co/v1/traces",
        "PULSE_RELAY_CLIENT_OTLP_TRACES_DATASET=relay",
        "PULSE_RELAY_CLIENT_OTLP_TRACES_TOKEN=client-token",
        "",
      ].join("\n"),
    );
  });
});

describe("release workflow relay config propagation", () => {
  it.effect("does not depend on relay tracing config while relay release steps are disabled", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workflowPath = yield* path.fromFileUrl(
        new URL("../../../.github/workflows/release.yml", import.meta.url),
      );
      const workflow = yield* fileSystem.readFileString(workflowPath);

      expect(workflow).not.toContain("relay_public_config");
      expect(workflow).not.toContain("client_tracing_token:");
      expect(workflow).not.toContain("needs.relay_public_config.outputs.client_tracing_token");
      expect(workflow).not.toContain("relay-client-tracing-config");
      expect(workflow).not.toContain('cat "$config_path" >> "$GITHUB_ENV"');
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("publicConfigFromOutput", () => {
  it("reads the complete public tracing config from persisted Alchemy output", () => {
    expect(
      publicConfigFromOutput({
        url: "https://relay.example.test",
        mobileTracingUrl: "https://api.axiom.co/v1/traces",
        mobileTracingDataset: "mobile",
        mobileTracingToken: "mobile-token",
        clientTracingUrl: "https://api.axiom.co/v1/traces",
        clientTracingDataset: "relay",
        clientTracingToken: "client-token",
      }),
    ).toEqual({
      relayUrl: "https://relay.example.test",
      mobileTracingUrl: "https://api.axiom.co/v1/traces",
      mobileTracingDataset: "mobile",
      mobileTracingToken: "mobile-token",
      clientTracingUrl: "https://api.axiom.co/v1/traces",
      clientTracingDataset: "relay",
      clientTracingToken: "client-token",
    });
  });

  it("rejects incomplete stack output", () => {
    expect(publicConfigFromOutput({ url: "https://relay.example.test" })).toBeNull();
  });
});
