/**
 * Live API tests for /notification (N1–N5).
 *
 * POST /notification fires an in-app notification. Without `recipients`, the
 * message goes to the current user; with `recipients`, it fans out to
 * colleagues visible to the app. Requires the `share` OAuth scope
 * (`arNotification` server-side); calls without it return 403. No response
 * body.
 */

import { describe, it, expect } from "vitest";
import {
  hasTokens,
  liveClient,
  rawApi,
  readEnv,
  readEnvOptional,
  runTag,
} from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — /notification", () => {
  const client = liveClient();
  const PROJECT_URL = `https://quire.io/w/${readEnv("QUIRE_TEST_PROJECT_ID")}`;
  const colleagueEmail = readEnvOptional("QUIRE_TEST_COLLEAGUE_EMAIL");

  it("N1 sendNotification({message}) succeeds with just a message", async () => {
    // The wrapper returns void; we just confirm it doesn't throw.
    await client.sendNotification({
      message: `live-test notification ${runTag}`,
    });
  });

  it("N2 sendNotification({message, url}) accepts the optional url field", async () => {
    await client.sendNotification({
      message: `live-test notification w/ url ${runTag}`,
      url: PROJECT_URL,
    });
  });

  it("N3 sendNotification({message, recipients}) self-delivers via explicit recipient", async () => {
    // Self-OID is always a valid recipient — works without colleague visibility.
    const me = await client.getMe();
    await client.sendNotification({
      message: `live-test notification w/ recipients ${runTag}`,
      recipients: [me.oid],
    });
  });

  it.skipIf(!colleagueEmail)(
    "N4 sendNotification({recipients: [colleague_email]}) fans out to a colleague",
    async () => {
      // Requires the OAuth app to see `colleagueEmail` via GET /user/list —
      // i.e. either a same-org colleague who has also authorized this app, or
      // any colleague if the app holds the contacts scope. Skipped otherwise.
      await client.sendNotification({
        message: `live-test notification to colleague ${runTag}`,
        recipients: [colleagueEmail!],
      });
    },
  );

  it("N5 sendNotification with unknown recipient returns 404", async () => {
    // The server returns an identical 404 for every unknown/invisible
    // recipient so the endpoint can't be used to probe user existence.
    // Use rawApi because the wrapper would throw and obscure the status.
    const res = await rawApi("POST", "/notification", {
      message: `live-test notification unknown-recipient ${runTag}`,
      recipients: [`nobody-${runTag}@example.invalid`],
    });
    expect(res.status).toBe(404);
  });
});
