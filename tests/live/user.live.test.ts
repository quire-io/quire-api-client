/**
 * Live API tests for /user (U1-U3).
 */

import { describe, it, expect } from "vitest";
import { hasTokens, liveClient } from "./helpers.js";

describe.skipIf(!hasTokens)("Live API — /user", () => {
  const client = liveClient();

  it("U1 getMe returns the current user with all identity fields", async () => {
    const me = await client.getMe();
    expect(me.oid).toBeTruthy();
    expect(me.id).toBeTruthy();
    expect(me.name).toBeTruthy();
    expect(me.email).toBeTruthy();
  });

  it("U2 getUserById(me.id) matches getMe", async () => {
    const me = await client.getMe();
    const got = await client.getUserById(me.id);
    expect(got.oid).toBe(me.oid);
  });

  it("U3 getUser(me.oid) matches getMe", async () => {
    const me = await client.getMe();
    const got = await client.getUser(me.oid);
    expect(got.oid).toBe(me.oid);
  });
});
