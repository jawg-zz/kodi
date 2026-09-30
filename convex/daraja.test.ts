import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  TOKEN_SKEW_MS,
  TOKEN_TTL_FALLBACK_MS,
  darajaBase,
  isTokenFresh,
} from "./lib/daraja";
import * as mpesaInternal from "./mpesaInternal";

// The AES-GCM key for credential blobs in tests. Plain assignment (not a
// global stub) so the vitest runtime keeps its own process object intact.
process.env.CREDENTIALS_KEY = "test-key-for-daraja-cache";

// lib/daraja is a plain helper module (no function registry), so it need
// not appear in the module map — only mpesaInternal does. The lib module
// still resolves via the real filesystem import above.
const modules = {
  "./_generated/api.js": () => Promise.resolve({}),
  "./mpesaInternal.js": () => Promise.resolve(mpesaInternal),
};

const STAFF = { subject: "staff-1" };

async function seedOrg(t: ReturnType<typeof convexTest>) {
  const orgId: Id<"orgs"> = await t.run(async (ctx) => {
    const id = await ctx.db.insert("orgs", {
      name: "Test Org",
      plan_code: "growth",
      subscription_status: "active",
      invoice_due_day: 5,
    });
    await ctx.db.insert("orgMembers", {
      orgId: id,
      userId: STAFF.subject,
      role: "owner",
    });
    await ctx.db.insert("mpesaCredentials", {
      orgId: id,
      environment: "sandbox",
      consumerKeyEnc: "x",
      consumerSecretEnc: "y",
      shortcode: "174379",
      passkeyEnc: "z",
    });
    return id;
  });
  return orgId;
}

test("sandbox and production map to the documented Daraja 3.0 hosts", () => {
  expect(darajaBase("sandbox")).toBe("https://sandbox.safaricom.co.ke");
  expect(darajaBase("production")).toBe("https://api.safaricom.co.ke");
});

test("isTokenFresh treats expiry as stale one skew-window early", () => {
  const now = Date.now();
  expect(isTokenFresh(now + TOKEN_SKEW_MS + 60_000, now)).toBe(true);
  expect(isTokenFresh(now + TOKEN_SKEW_MS - 1_000, now)).toBe(false);
  expect(isTokenFresh(now - 1_000, now)).toBe(false);
  expect(isTokenFresh(Number.NaN, now)).toBe(false);
});

test("token store/read round-trips through AES-GCM encryption", async () => {
  const t = convexTest(schema, modules);
  const orgId = await seedOrg(t);
  const empty = await t.run(async (ctx) =>
    ctx.runQuery(internal.mpesaInternal.getCachedDarajaToken, { orgId }),
  );
  expect(empty).toBeNull();

  await t.run(async (ctx) =>
    ctx.runMutation(internal.mpesaInternal.storeCachedDarajaToken, {
      orgId,
      token: "secret-token-value",
      expiresAt: 1_700_000_000_000,
    }),
  );
  const hit = await t.run(async (ctx) =>
    ctx.runQuery(internal.mpesaInternal.getCachedDarajaToken, { orgId }),
  );
  expect(hit).toEqual({ token: "secret-token-value", expiresAt: 1_700_000_000_000 });

  // The row holds a ciphertext blob, never the raw token.
  const raw = await t.run(async (ctx) =>
    ctx.db
      .query("mpesaCredentials")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .first(),
  );
  expect(raw?.darajaTokenEnc).toBeDefined();
  expect(raw?.darajaTokenEnc).not.toContain("secret-token-value");
});

test("read fails open (null) on blobs from a different CREDENTIALS_KEY", async () => {
  const t = convexTest(schema, modules);
  const orgId = await seedOrg(t);
  // Store under the test key, then rotate the key: the blob can no longer
  // decrypt, and the reader must return null (fail open → fresh mint)
  // instead of throwing.
  await t.run(async (ctx) =>
    ctx.runMutation(internal.mpesaInternal.storeCachedDarajaToken, {
      orgId,
      token: "secret-token-value",
      expiresAt: Date.now() + 3_600_000,
    }),
  );
  process.env.CREDENTIALS_KEY = "a-different-key-after-rotation!!";
  const hit = await t.run(async (ctx) =>
    ctx.runQuery(internal.mpesaInternal.getCachedDarajaToken, { orgId }),
  );
  expect(hit).toBeNull();
  process.env.CREDENTIALS_KEY = "test-key-for-daraja-cache";
});

test("fallback TTL covers a token reply that omits expires_in", () => {
  // One hour minus clock margin: headers only, no Daraja call involved —
  // just pins the constant the mint path uses when expires_in is absent.
  expect(TOKEN_TTL_FALLBACK_MS).toBe(3_500_000);
});
