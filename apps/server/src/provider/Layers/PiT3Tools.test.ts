import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationOperation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  type PreviewAutomationBrokerShape,
  type PreviewAutomationInvokeInput,
} from "../../mcp/PreviewAutomationBroker.ts";
import { makePiT3Tools, T3_PI_TOOL_NAMES } from "./PiT3Tools.ts";

const environmentId = EnvironmentId.make("env-pi-t3-tools-test");
const threadId = ThreadId.make("thread-pi-t3-tools-test");
const providerInstanceId = ProviderInstanceId.make("pi");
const providerSessionId = "provider-session-pi-t3-tools-test";

const baseInput = {
  environmentId,
  threadId,
  providerInstanceId,
  providerSessionId,
  makeSnapshotToolView: async (snapshot: unknown) => ({
    artifact: {
      artifactPath: "/tmp/t3/browser-artifacts/thread/preview-snapshot.json",
      artifactBytes: JSON.stringify(snapshot).length,
      relativePath: "browser-artifacts/thread/preview-snapshot.json",
    },
    truncated: true,
    value: {
      ...(snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : {}),
      accessibilityTree: { truncated: true },
      screenshot:
        snapshot &&
        typeof snapshot === "object" &&
        !Array.isArray(snapshot) &&
        "screenshot" in snapshot
          ? { mimeType: "image/png", width: 10, height: 5 }
          : undefined,
      fullSnapshotArtifact: {
        artifactPath: "/tmp/t3/browser-artifacts/thread/preview-snapshot.json",
      },
    },
  }),
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
};

function makeFakeBroker(
  handler: (input: {
    readonly operation: PreviewAutomationOperation;
    readonly input: unknown;
    readonly scope: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
  }) => unknown,
): PreviewAutomationBrokerShape {
  return {
    connect: () => Effect.die("unused"),
    reportOwner: () => Effect.die("unused"),
    clearOwner: () => Effect.die("unused"),
    respond: () => Effect.die("unused"),
    invoke: <A = unknown>(input: PreviewAutomationInvokeInput) =>
      Effect.succeed(
        handler({
          operation: input.operation,
          input: input.input,
          scope: { environmentId: input.scope.environmentId, threadId: input.scope.threadId },
        }),
      ) as Effect.Effect<A, never>,
  };
}

function textContent(content: { readonly type: string; readonly text?: string }): string {
  if (content.type !== "text" || typeof content.text !== "string") {
    throw new Error(`Expected text content, got ${content.type}`);
  }
  return content.text;
}

describe("makePiT3Tools", () => {
  it("registers exactly the two T3 Pi tools", () => {
    const tools = makePiT3Tools(baseInput);
    expect(tools.map((tool) => tool.name)).toEqual([...T3_PI_TOOL_NAMES]);
  });

  it("t3_capability lists the preview capability for browser-related queries", async () => {
    const tools = makePiT3Tools(baseInput);
    const capabilityTool = tools.find((tool) => tool.name === "t3_capability")!;
    const result = await capabilityTool.execute(
      "call-1",
      { query: "browser" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(textContent(result.content[0]!));
    expect(parsed.capabilities).toHaveLength(1);
    expect(parsed.capabilities[0].id).toBe("preview");
    expect(
      parsed.capabilities[0].operations.some(
        (op: { operation: string }) => op.operation === "preview.status",
      ),
    ).toBe(true);
  });

  it("t3_capability returns no capabilities for an unrelated capability id", async () => {
    const tools = makePiT3Tools(baseInput);
    const capabilityTool = tools.find((tool) => tool.name === "t3_capability")!;
    const result = await capabilityTool.execute(
      "call-2",
      { capability: "git" },
      undefined,
      undefined,
      {} as never,
    );

    const parsed = JSON.parse(textContent(result.content[0]!));
    expect(parsed.capabilities).toEqual([]);
  });

  it("t3_execute rejects operations outside the allowlist", async () => {
    const tools = makePiT3Tools(baseInput);
    const executeTool = tools.find((tool) => tool.name === "t3_execute")!;
    const result = await executeTool.execute(
      "call-3",
      { operation: "system.exec" },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result.content[0]!)).toContain("Unknown T3 operation 'system.exec'");
    expect(result.details).toMatchObject({ operation: "system.exec", error: "unknown_operation" });
  });

  it("t3_execute dispatches preview.status to the broker with the correct scope", async () => {
    let captured:
      | {
          operation: PreviewAutomationOperation;
          input: unknown;
          scope: { environmentId: EnvironmentId; threadId: ThreadId };
        }
      | undefined;
    const broker = makeFakeBroker((input) => {
      captured = input;
      return { available: true, tabId: PreviewTabId.make("tab-test"), visible: true };
    });

    const tools = makePiT3Tools({ ...baseInput, broker });
    const executeTool = tools.find((tool) => tool.name === "t3_execute")!;
    const result = await executeTool.execute(
      "call-4",
      { operation: "preview.status" },
      undefined,
      undefined,
      {} as never,
    );

    expect(captured?.operation).toBe("status");
    expect(captured?.input).toEqual({});
    expect(captured?.scope.environmentId).toBe(environmentId);
    expect(captured?.scope.threadId).toBe(threadId);
    expect(result.details).toMatchObject({ operation: "preview.status", input: {} });
    expect(JSON.parse(textContent(result.content[0]!))).toMatchObject({
      available: true,
      visible: true,
    });
  });

  it("t3_execute normalizes preview.open defaults", async () => {
    let captured: { input: unknown } | undefined;
    const broker = makeFakeBroker((input) => {
      captured = input;
      return { available: true };
    });

    const tools = makePiT3Tools({ ...baseInput, broker });
    const executeTool = tools.find((tool) => tool.name === "t3_execute")!;
    await executeTool.execute(
      "call-5",
      { operation: "preview.open", input: { url: "http://example.test" } },
      undefined,
      undefined,
      {} as never,
    );

    expect(captured?.input).toMatchObject({
      url: "http://example.test",
      show: true,
      reuseExistingTab: true,
    });
  });

  it("t3_execute forwards timeoutMs when present", async () => {
    let captured: { input: unknown } | undefined;
    const broker = makeFakeBroker((input) => {
      captured = input;
      return null;
    });

    const tools = makePiT3Tools({ ...baseInput, broker });
    const executeTool = tools.find((tool) => tool.name === "t3_execute")!;
    await executeTool.execute(
      "call-6",
      { operation: "preview.click", input: { selector: "button", timeoutMs: 1234 } },
      undefined,
      undefined,
      {} as never,
    );

    expect(captured?.input).toMatchObject({ selector: "button", timeoutMs: 1234 });
  });

  it("t3_execute returns truncated snapshot metadata, always includes the image, and writes the full artifact", async () => {
    const broker = makeFakeBroker(() => ({
      url: "http://example.test/",
      title: "Example",
      loading: false,
      visibleText: "Example",
      interactiveElements: [],
      accessibilityTree: { huge: "tree" },
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      screenshot: {
        mimeType: "image/png" as const,
        data: Buffer.from("png").toString("base64"),
        width: 10,
        height: 5,
      },
    }));

    const tools = makePiT3Tools({ ...baseInput, broker });
    const executeTool = tools.find((tool) => tool.name === "t3_execute")!;
    const result = await executeTool.execute(
      "call-7",
      { operation: "preview.snapshot" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.content).toHaveLength(2);
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[1]!.type).toBe("image");
    const imageContent = result.content[1] as { readonly type: "image"; readonly data: string };
    expect(imageContent.data).toBe(Buffer.from("png").toString("base64"));
    const text = textContent(result.content[0]!);
    expect(text).toContain("Inline snapshot output is truncated");
    const metadata = JSON.parse(text.split("\n\n")[0]!);
    expect(metadata.url).toBe("http://example.test/");
    expect(metadata.screenshot).toMatchObject({ mimeType: "image/png", width: 10, height: 5 });
    expect(metadata.screenshot.data).toBeUndefined();
    expect(metadata.accessibilityTree.truncated).toBe(true);
    expect(metadata.fullSnapshotArtifact.artifactPath).toContain("browser-artifacts");
    expect(result.details).toMatchObject({ result: metadata });
  });

  it("t3_execute reports when the broker is unavailable", async () => {
    const tools = makePiT3Tools(baseInput);
    const executeTool = tools.find((tool) => tool.name === "t3_execute")!;
    const result = await executeTool.execute(
      "call-8",
      { operation: "preview.status" },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result.content[0]!)).toContain("T3 preview automation is unavailable");
    expect(result.details).toMatchObject({
      operation: "preview.status",
      error: "preview_broker_unavailable",
    });
  });

  it("t3_execute returns a structured error when the broker invocation fails", async () => {
    const broker: PreviewAutomationBrokerShape = {
      connect: () => Effect.die("unused"),
      reportOwner: () => Effect.die("unused"),
      clearOwner: () => Effect.die("unused"),
      respond: () => Effect.die("unused"),
      invoke: () => Effect.fail(new Error("broker exploded") as never),
    };

    const tools = makePiT3Tools({ ...baseInput, broker });
    const executeTool = tools.find((tool) => tool.name === "t3_execute")!;
    const result = await executeTool.execute(
      "call-9",
      { operation: "preview.status" },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result.content[0]!)).toContain(
      "T3 execute failed for 'preview.status': broker exploded",
    );
    expect(result.details).toMatchObject({ operation: "preview.status", error: "broker exploded" });
  });
});
