import { describe, expect, it } from "@effect/vitest";
import { makeEnvironmentHttpApiUrlBuilder } from "./http.ts";

describe("hub HTTP API routing", () => {
  it("addresses contract endpoints through the destination daemon", () => {
    const urls = makeEnvironmentHttpApiUrlBuilder("https://hub.test/hub/environments/worker/");
    expect(urls.pullRequests.diff()).toBe(
      "https://hub.test/hub/environments/worker/api/pull-requests/diff",
    );
  });
});
