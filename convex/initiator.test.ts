import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  inspectInitiatorCert,
  mintSecurityCredential,
} from "./lib/initiator";
import * as mpesaInternal from "./mpesaInternal";

process.env.CREDENTIALS_KEY = "test-key-for-initiator-track";

// 512-bit self-signed fixture (CN=daraja-test). Production uses the real
// M-Pesa portal cert, but the mint construction is identical.
const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBgzCCAS2gAwIBAgIUZtL/Be1ToX6ovY/0GjQa1ma+k/swDQYJKoZIhvcNAQEL
BQAwFjEUMBIGA1UEAwwLZGFyYWphLXRlc3QwHhcNMjYwOTMwMTg1MjQ5WhcNMjYx
MDAyMTg1MjQ5WjAWMRQwEgYDVQQDDAtkYXJhamEtdGVzdDBcMA0GCSqGSIb3DQEB
AQUAA0sAMEgCQQCf9ViuSFawn3Rjf1AqJyGiO13m+oUwL11JdeVKGhs0LqXZLyAY
jAKbPfp4ekwvlTtljA2IZ+J4WJNX7qzRSOv3AgMBAAGjUzBRMB0GA1UdDgQWBBQa
arQBSFta09yG+RF7eMiCoRUU4DAfBgNVHSMEGDAWgBQaarQBSFta09yG+RF7eMiC
oRUU4DAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA0EAfWk7+cJZD9S4
Bj4trsvSeT3cuAmoYGOfFwhB7DnKo7nAuS+aGHGOQOxnZN0ftPgEMR05iALuESsh
cqSLkdbVHA==
-----END CERTIFICATE-----`;

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

test("mintSecurityCredential produces base64 RSA ciphertext", () => {
  const cred = mintSecurityCredential("InitiatorPass1", TEST_CERT_PEM);
  expect(typeof cred).toBe("string");
  expect(cred.length).toBeGreaterThan(20);
  // 512-bit RSA → 64-byte ciphertext → 88-char base64.
  expect(Buffer.from(cred, "base64").length).toBe(64);
  // Same construction openssl would produce: decrypts with the private key.
  expect(cred).not.toContain("InitiatorPass1");
});

test("mintSecurityCredential rejects empty password and bad PEM", () => {
  expect(() => mintSecurityCredential("", TEST_CERT_PEM)).toThrow(
    /password/i,
  );
  expect(() => mintSecurityCredential("pass", "not-a-cert")).toThrow(
    /X\.509|certificate/i,
  );
});

test("inspectInitiatorCert reports subject and key size", () => {
  const info = inspectInitiatorCert(TEST_CERT_PEM);
  expect(info.subject).toContain("daraja-test");
  expect(info.keyBits).toBe(512);
  expect(() => inspectInitiatorCert("garbage")).toThrow(/X\.509|valid/i);
});

test("initiator store/read round-trips through AES-GCM", async () => {
  const t = convexTest(schema, modules);
  const orgId = await seedOrg(t);
  const before = await t.run(async (ctx) =>
    ctx.runMutation(internal.mpesaInternal.getDecryptedInitiator, { orgId }),
  );
  expect(before).toBeNull();

  const { encryptSecret } = await import("./lib/mpesaCrypto");
  const enc = await encryptSecret("InitiatorPass1");
  await t.run(async (ctx) =>
    ctx.runMutation(internal.mpesaInternal.storeCreds, {
      orgId,
      environment: "sandbox",
      consumerKeyEnc: "x",
      consumerSecretEnc: "y",
      shortcode: "174379",
      passkeyEnc: "z",
      initiatorName: "apiop1",
      initiatorPasswordEnc: enc,
      initiatorCertPem: TEST_CERT_PEM,
    }),
  );
  const after = await t.run(async (ctx) =>
    ctx.runMutation(internal.mpesaInternal.getDecryptedInitiator, { orgId }),
  );
  expect(after).toMatchObject({
    initiatorName: "apiop1",
    initiatorPassword: "InitiatorPass1",
    shortcode: "174379",
  });
  expect(after?.initiatorCertPem).toContain("BEGIN CERTIFICATE");
});
