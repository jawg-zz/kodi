import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import * as c2b from "./c2b";
import * as darajaJobs from "./darajaJobs";
import * as verifyInternal from "./verifyInternal";
import * as payoutsInternal from "./payoutsInternal";
import * as billManager from "./billManager";
import * as billManagerInternal from "./billManagerInternal";
import * as collectInternal from "./collectInternal";
import * as bongaInternal from "./bongaInternal";
import * as hakikishaInternal from "./hakikishaInternal";
import * as reconcileInternal from "./reconcileInternal";
import * as mpesaInternal from "./mpesaInternal";
import * as helpers from "./helpers";
import { parseBalancePayload } from "./verify";

process.env.CREDENTIALS_KEY = "test-key-for-extended-tracks";

const modules = {
  "./_generated/api.js": () => Promise.resolve({}),
  "./c2b.js": () => Promise.resolve(c2b),
  "./darajaJobs.js": () => Promise.resolve(darajaJobs),
  "./verifyInternal.js": () => Promise.resolve(verifyInternal),
  "./payoutsInternal.js": () => Promise.resolve(payoutsInternal),
  "./billManager.js": () => Promise.resolve(billManager),
  "./billManagerInternal.js": () => Promise.resolve(billManagerInternal),
  "./collectInternal.js": () => Promise.resolve(collectInternal),
  "./bongaInternal.js": () => Promise.resolve(bongaInternal),
  "./hakikishaInternal.js": () => Promise.resolve(hakikishaInternal),
  "./reconcileInternal.js": () => Promise.resolve(reconcileInternal),
  "./mpesaInternal.js": () => Promise.resolve(mpesaInternal),
  "./helpers.js": () => Promise.resolve(helpers),
};

const STAFF = { subject: "staff-1" };
const SHORTCODE = "174379";

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
      shortcode: SHORTCODE,
      passkeyEnc: "z",
    });
    return id;
  });
  return { orgId, asStaff: t.withIdentity(STAFF) };
}

async function seedTenant(t: ReturnType<typeof convexTest>, orgId: Id<"orgs">) {
  return t.run(async (ctx) => {
    const propertyId = await ctx.db.insert("properties", {
      orgId,
      name: "Green Court",
      property_type: "apartments",
      location: "Nairobi",
    });
    const unitId = await ctx.db.insert("units", {
      orgId,
      propertyId,
      label: "A1",
      unit_type: "one_br",
      rent_amount: 20000,
      water_charge: 500,
      garbage_charge: 300,
      status: "occupied",
    });
    const tenantId = await ctx.db.insert("tenants", {
      orgId,
      full_name: "Jane Tenant",
      phone: "254700000001",
      national_id: "12345678",
      accountCode: "GC-A1",
      unitId,
      deposit_held: 20000,
      status: "active",
    });
    await ctx.db.patch(unitId, { currentTenantId: tenantId });
    return { tenantId, unitId };
  });
}

// --- C2B validation ---

test("validation accepts structurally valid hits in accept_all mode", async () => {
  const t = convexTest(schema, modules);
  const { orgId } = await seedOrg(t);
  void orgId;
  const d = await t.run(async (ctx) =>
    ctx.runMutation(internal.c2b.validateC2bInternal, {
      shortcode: SHORTCODE,
      transId: "VAL-1",
      transAmount: 5000,
      billRef: "TYPO-REF",
    }),
  );
  expect(d.resultCode).toBe("0");
});

test("validation rejects unknown shortcode with C2B00011", async () => {
  const t = convexTest(schema, modules);
  await seedOrg(t);
  const d = await t.run(async (ctx) =>
    ctx.runMutation(internal.c2b.validateC2bInternal, {
      shortcode: "000000",
      transId: "VAL-2",
      transAmount: 5000,
    }),
  );
  expect(d.resultCode).toBe("C2B00011");
});

test("validation rejects bad amount with C2B00013", async () => {
  const t = convexTest(schema, modules);
  await seedOrg(t);
  const d = await t.run(async (ctx) =>
    ctx.runMutation(internal.c2b.validateC2bInternal, {
      shortcode: SHORTCODE,
      transId: "VAL-3",
      transAmount: 0,
    }),
  );
  expect(d.resultCode).toBe("C2B00013");
});

test("strict mode rejects unknown accounts with C2B00012, accepts known", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  await seedTenant(t, orgId);
  await asStaff.mutation(api.c2b.setValidationMode, { orgId, mode: "strict" });
  const bad = await t.run(async (ctx) =>
    ctx.runMutation(internal.c2b.validateC2bInternal, {
      shortcode: SHORTCODE,
      transId: "VAL-4",
      transAmount: 5000,
      billRef: "NOPE-99",
    }),
  );
  expect(bad.resultCode).toBe("C2B00012");
  const good = await t.run(async (ctx) =>
    ctx.runMutation(internal.c2b.validateC2bInternal, {
      shortcode: SHORTCODE,
      transId: "VAL-5",
      transAmount: 5000,
      billRef: "gc-a1",
    }),
  );
  expect(good.resultCode).toBe("0");
});

// --- darajaJobs lifecycle ---

test("job open → resolve done → unknown conversation returns null", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const jobId: Id<"darajaJobs"> = await t.run(async (ctx) =>
    ctx.runMutation(internal.darajaJobs.openJob, {
      orgId,
      kind: "txn_status",
      conversationId: "TXS-JOB-1",
      summary: "Status for RCPT1",
    }),
  );
  const miss = await t.run(async (ctx) =>
    ctx.runMutation(internal.darajaJobs.resolveJobByConversation, {
      originatorConversationId: "NOPE",
      resultCode: "0",
    }),
  );
  expect(miss).toBeNull();
  const done = await t.run(async (ctx) =>
    ctx.runMutation(internal.darajaJobs.resolveJobByConversation, {
      originatorConversationId: "TXS-JOB-1",
      conversationId: "DARAJA-C1",
      resultCode: "0",
      resultDesc: "Completed",
    }),
  );
  expect(done?.status).toBe("done");
  expect(done?.resultCode).toBe("0");
  const jobs = await asStaff.query(api.darajaJobs.listDarajaJobs, { orgId });
  expect(jobs.length).toBe(1);
  expect(jobs[0].conversationId).toBe("TXS-JOB-1");
  // Second resolve is idempotent (already done).
  const again = await t.run(async (ctx) =>
    ctx.runMutation(internal.darajaJobs.resolveJobByConversation, {
      originatorConversationId: "TXS-JOB-1",
      resultCode: "0",
    }),
  );
  expect(again?.status).toBe("done");
});

test("failed job result flips to failed with the code", async () => {
  const t = convexTest(schema, modules);
  const { orgId } = await seedOrg(t);
  await t.run(async (ctx) =>
    ctx.runMutation(internal.darajaJobs.openJob, {
      orgId,
      kind: "reversal",
      conversationId: "REV-JOB-9",
    }),
  );
  const failed = await t.run(async (ctx) =>
    ctx.runMutation(internal.darajaJobs.resolveJobByConversation, {
      originatorConversationId: "REV-JOB-9",
      resultCode: "2001",
      resultDesc: "Initiator credentials invalid",
    }),
  );
  expect(failed?.status).toBe("failed");
  expect(failed?.resultCode).toBe("2001");
});

// --- balance parse ---

test("parseBalancePayload extracts per-account balances", () => {
  const { balances } = parseBalancePayload(
    "Utility Account|KES|100|50|150000|ok|Working Account|KES|0|0|25000|ok",
  );
  expect(balances).toEqual([
    { account: "Utility Account", balance: 150000 },
    { account: "Working Account", balance: 25000 },
  ]);
});

test("parseBalancePayload tolerates empty payloads", () => {
  expect(parseBalancePayload("").balances).toEqual([]);
});

// --- Hakikisha lookup ---

test("hakikisha lookup returns the tenant name for a known code", async () => {
  const t = convexTest(schema, modules);
  const { orgId } = await seedOrg(t);
  await seedTenant(t, orgId);
  const name = await t.run(async (ctx) =>
    ctx.runQuery(internal.hakikishaInternal.lookupAccountName, {
      shortcode: SHORTCODE,
      account: "GC-A1",
    }),
  );
  expect(name).toBe("Jane Tenant");
  const miss = await t.run(async (ctx) =>
    ctx.runQuery(internal.hakikishaInternal.lookupAccountName, {
      shortcode: SHORTCODE,
      account: "ZZ-9",
    }),
  );
  expect(miss).toBeNull();
});

// --- QR cache ---

test("QR store/read round-trips per invoice", async () => {
  const t = convexTest(schema, modules);
  const { orgId } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  const invId: Id<"invoices"> = await t.run(async (ctx) =>
    ctx.db.insert("invoices", {
      orgId,
      tenantId,
      unitId,
      month: "2026-09",
      lines: { rent: 20000, water: 500, garbage: 300, other: 0 },
      total: 20800,
      dueDate: "2026-09-05",
      status: "unpaid",
      balance: 20800,
    }),
  );
  await t.run(async (ctx) =>
    ctx.runMutation(internal.collectInternal.storeQr, {
      orgId,
      invoiceId: invId,
      qrBase64: "aGVsbG8=",
      amount: 20800,
      refNo: "GC-A1",
    }),
  );
  const hit = await t.run(async (ctx) =>
    ctx.runQuery(internal.collectInternal.getCachedQr, { invoiceId: invId }),
  );
  expect(hit).toEqual({ qrBase64: "aGVsbG8=", amount: 20800, refNo: "GC-A1" });
  const inv = await t.run(async (ctx) =>
    ctx.runQuery(internal.collectInternal.getInvoiceForQr, { invoiceId: invId }),
  );
  expect(inv).toMatchObject({ balance: 20800, accountCode: "GC-A1" });
});
// --- Bill Manager ingest ---

test("bill manager ingest matches by account, dedupes transactionId", async () => {
  const t = convexTest(schema, modules);
  const { orgId } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await t.run(async (ctx) =>
    ctx.db.insert("invoices", {
      orgId,
      tenantId,
      unitId,
      month: "2026-09",
      lines: { rent: 20000, water: 500, garbage: 300, other: 0 },
      total: 20800,
      dueDate: "2026-09-05",
      status: "unpaid",
      balance: 20800,
    }),
  );
  const first = await t.run(async (ctx) =>
    ctx.runMutation(internal.billManagerInternal.ingestPayment, {
      shortcode: SHORTCODE,
      transactionId: "BM-1",
      paidAmount: 20800,
      msisdn: "254700000001",
      accountReference: "GC-A1",
    }),
  );
  expect(first.status).toBe("matched");
  expect(first.deduplicated).toBe(false);
  const inv = await t.run(async (ctx) =>
    ctx.db
      .query("invoices")
      .withIndex("by_tenant_month", (q) => q.eq("tenantId", tenantId))
      .first(),
  );
  expect(inv?.balance).toBe(0);
  const second = await t.run(async (ctx) =>
    ctx.runMutation(internal.billManagerInternal.ingestPayment, {
      shortcode: SHORTCODE,
      transactionId: "BM-1",
      paidAmount: 20800,
      msisdn: "254700000001",
      accountReference: "GC-A1",
    }),
  );
  expect(second.deduplicated).toBe(true);
});

test("bill manager ingest parks unknown refs in review", async () => {
  const t = convexTest(schema, modules);
  const { orgId } = await seedOrg(t);
  await seedTenant(t, orgId);
  const res = await t.run(async (ctx) =>
    ctx.runMutation(internal.billManagerInternal.ingestPayment, {
      shortcode: SHORTCODE,
      transactionId: "BM-2",
      paidAmount: 1000,
      msisdn: "254799999999",
      accountReference: "ZZ-9",
    }),
  );
  expect(res.status).toBe("pending_review");
});

test("bonga creds fail closed when unset, round-trip when set", async () => {
  const t = convexTest(schema, modules);
  const { orgId } = await seedOrg(t);
  const { encryptSecret } = await import("./lib/mpesaCrypto");
  const empty = await t.run(async (ctx) =>
    ctx.runQuery(internal.bongaInternal.getBongaCreds, { orgId }),
  );
  expect(empty).toBeNull();
  await t.run(async (ctx) =>
    ctx.runMutation(internal.bongaInternal.storeBongaCreds, {
      orgId,
      usernameEnc: await encryptSecret("bongaop"),
      passwordEnc: await encryptSecret("bongapass"),
    }),
  );
  const hit = await t.run(async (ctx) =>
    ctx.runQuery(internal.bongaInternal.getBongaCreds, { orgId }),
  );
  expect(hit).toEqual({ username: "bongaop", password: "bongapass" });
});

// --- reconcile cursors ---

test("pull/balance due-org selectors respect registration + 24h cursor", async () => {
  const t = convexTest(schema, modules);
  const { orgId } = await seedOrg(t);
  const none = await t.run(async (ctx) =>
    ctx.runMutation(internal.reconcileInternal.pullDueOrgs, {}),
  );
  expect(none).toEqual([]);
  await t.run(async (ctx) =>
    ctx.runMutation(internal.verifyInternal.setPullRegistered, { orgId }),
  );
  await t.run(async (ctx) =>
    ctx.db.patch(
      (
        await ctx.db
          .query("mpesaCredentials")
          .withIndex("by_org", (q) => q.eq("orgId", orgId))
          .first()
      )?._id as Id<"mpesaCredentials">,
      { initiatorName: "apiop1" },
    ),
  );
  const due = await t.run(async (ctx) =>
    ctx.runMutation(internal.reconcileInternal.pullDueOrgs, {}),
  );
  expect(due).toEqual([orgId]);
  await t.run(async (ctx) =>
    ctx.runMutation(internal.verifyInternal.markPullCursor, { orgId }),
  );
  const after = await t.run(async (ctx) =>
    ctx.runMutation(internal.reconcileInternal.pullDueOrgs, {}),
  );
  expect(after).toEqual([]);
});

// --- reversal auto-void ---

test("autoVoidOnReversalComplete voids the linked payment once", async () => {
  const t = convexTest(schema, modules);
  const { orgId } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  const invId: Id<"invoices"> = await t.run(async (ctx) =>
    ctx.db.insert("invoices", {
      orgId,
      tenantId,
      unitId,
      month: "2026-09",
      lines: { rent: 20000, water: 500, garbage: 300, other: 0 },
      total: 20800,
      dueDate: "2026-09-05",
      status: "unpaid",
      balance: 20800,
    }),
  );
  void invId;
  const paymentId: Id<"payments"> = await t.run(async (ctx) =>
    ctx.db.insert("payments", {
      orgId,
      tenantId,
      amount: 20800,
      method: "mpesa_c2b",
      mpesaCode: "REV-T1",
      paidAt: Date.now(),
      allocations: [],
      receiptNo: "R-1",
      status: "active",
    }),
  );
  const jobId: Id<"darajaJobs"> = await t.run(async (ctx) =>
    ctx.runMutation(internal.darajaJobs.openJob, {
      orgId,
      kind: "reversal",
      conversationId: "REV-JOB-1",
      paymentId,
    }),
  );
  await t.run(async (ctx) =>
    ctx.runMutation(internal.c2b.autoVoidOnReversalComplete, { jobId }),
  );
  const p = await t.run(async (ctx) => ctx.db.get(paymentId));
  expect(p?.status).toBe("refunded");
  // Second call is a no-op (already reversed).
  await t.run(async (ctx) =>
    ctx.runMutation(internal.c2b.autoVoidOnReversalComplete, { jobId }),
  );
  const p2 = await t.run(async (ctx) => ctx.db.get(paymentId));
  expect(p2?.status).toBe("refunded");
});

test("postCandidates translates 'no apiproduct match' into a portal fix", async () => {
  const { postCandidates } = await import("./lib/initiatorJobs");
  const bundle = {
    orgId: "org1",
    environment: "sandbox",
    base: "https://sandbox.safaricom.co.ke",
    token: "tok",
    shortcode: "174379",
    initiatorName: "",
    credential: "",
    siteBase: "",
  } as never;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        ResponseCode: "",
        ResponseDescription:
          "Invalid Access Token - Invalid API call as no apiproduct match found",
      }),
      { status: 401 },
    )) as typeof fetch;
  try {
    await expect(
      postCandidates(bundle, ["sfcverify/v1/query/info"], {}, "B2B Hakikisha"),
    ).rejects.toThrow(/isn't subscribed to this API product/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("postCandidates accepts bare JSON success without ResponseCode", async () => {
  const { postCandidates } = await import("./lib/initiatorJobs");
  const bundle = {
    orgId: "org1",
    environment: "sandbox",
    base: "https://sandbox.safaricom.co.ke",
    token: "tok",
    shortcode: "174379",
    initiatorName: "",
    credential: "",
    siteBase: "",
  } as never;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ app_key: "ABC123" }), { status: 200 })) as typeof fetch;
  try {
    const res = await postCandidates(bundle, ["v1/billmanager-invoice/optin"], {}, "Bill Manager");
    expect(res.responseCode).toBe("0");
    expect(res.body).toContain("ABC123");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("postCandidates detects apiproduct mismatch in non-JSON bodies", async () => {
  const { postCandidates } = await import("./lib/initiatorJobs");
  const bundle = {
    orgId: "org1",
    environment: "sandbox",
    base: "https://sandbox.safaricom.co.ke",
    token: "tok",
    shortcode: "174379",
    initiatorName: "",
    credential: "",
    siteBase: "",
  } as never;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("Invalid API call as no apiproduct match found", { status: 401 })) as typeof fetch;
  try {
    await expect(
      postCandidates(bundle, ["sfcverify/v1/query/info"], {}, "B2B Hakikisha"),
    ).rejects.toThrow(/isn't subscribed to this API product/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("postCandidates maps gateway errorCode/errorMessage envelope", async () => {
  const { postCandidates } = await import("./lib/initiatorJobs");
  const bundle = {
    orgId: "org1",
    environment: "sandbox",
    base: "https://sandbox.safaricom.co.ke",
    token: "tok",
    shortcode: "174379",
    initiatorName: "",
    credential: "",
    siteBase: "",
  } as never;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        requestId: "abc-123",
        errorCode: "401",
        errorMessage: "Unauthorized - Invalid Access Token",
      }),
      { status: 401 },
    )) as typeof fetch;
  try {
    await expect(
      postCandidates(bundle, ["v1/billmanager-invoice/optin"], {}, "Bill Manager"),
    ).rejects.toThrow(/said no \(401\): Unauthorized/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("billManagerPeriod formats YYYY-MM as Month YYYY", async () => {
  const { billManagerPeriod } = await import("./billManager");
  expect(billManagerPeriod("2026-09")).toBe("September 2026");
  expect(billManagerPeriod("2026-01")).toBe("January 2026");
  expect(billManagerPeriod("bogus")).toBe("bogus");
});

test("billManager ingest returns ack fields on fresh match", async () => {
  const t = convexTest(schema, modules);
  const { orgId } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await t.run(async (ctx) =>
    ctx.db.insert("invoices", {
      orgId,
      tenantId,
      unitId,
      month: "2026-09",
      lines: { rent: 20000, water: 500, garbage: 300, other: 0 },
      total: 20800,
      dueDate: "2026-09-05",
      status: "unpaid",
      balance: 20800,
    }),
  );
  const res = await t.run(async (ctx) =>
    ctx.runMutation(internal.billManagerInternal.ingestPayment, {
      shortcode: SHORTCODE,
      transactionId: "BM-ACK-1",
      paidAmount: 20800,
      msisdn: "254700000001",
      accountReference: "GC-A1",
      dateCreated: "2026-09-15",
    }),
  );
  expect(res.status).toBe("matched");
  expect(res.ack).toMatchObject({
    paidAmount: 20800,
    accountReference: "GC-A1",
    transactionId: "BM-ACK-1",
    phoneNumber: "254700000001",
    fullName: "Jane Tenant",
    paymentDate: "2026-09-15",
  });
  expect(res.ack?.invoiceName).toBe("Rent 2026-09");
});
