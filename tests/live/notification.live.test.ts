/**
 * Live API tests for /notification (N1, N2).
 *
 * POST /notification fires an in-app notification to the *current* user
 * (the one whose access token is making the call) — not to arbitrary
 * recipients. Requires the `share` OAuth scope (`arNotification`
 * server-side); calls without it return 403. No response body.
 */

import { describe, it, expect } from "vitest";
import { hasTokens, liveClient, runTag } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — /notification", () => {
  const client = liveClient();

  it("N1 sendNotification({message}) succeeds with just a message", async () => {
    // The wrapper returns void; we just confirm it doesn't throw.
    await client.sendNotification({
      message: `live-test notification ${runTag}`,
    });
  });

  it("N2 sendNotification({message, url}) accepts the optional url field", async () => {
    await client.sendNotification({
      message: `live-test notification w/ url ${runTag}`,
      url: "https://quire.io/w/Quire_API_Test_Project",
    });
  });
});
