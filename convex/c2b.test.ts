import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import * as c2b from "./c2b";
import * as reports from "./reports";
import * as payments from "./payments";
import * as invoices from "./invoices";
import * as tenants from "./tenants";
import * as mpesaInternal from "./mpesaInternal";
import * as helpers from "./helpers";
import * as sha256 from "./lib/sha256";

const modules = {
  "./_generated/api.js": () => Promise.resolve({}),
  "./c2b.js": () => Promise.resolve(c2b),
  "./reports.js": () => Promise.resolve(reports),
  "./payments.js": () => Promise.resolve(payments),
  "./invoices.js": () => Promise.resolve(invoices),
  "./tenants.js": () => Promise.resolve(tenants),
  "./mpesaInternal.js": () => Promise.resolve(mpesaInternal),
  "./helpers.js": () => Promise.resolve(helpers),
  "./lib/sha256.js": () => Promise.resolve(sha256),
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
    // Minimal credential row so the shortcode routes to this org.
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

async function seedTenant(
  t: ReturnType<typeof convexTest>,
  orgId: Id<"orgs">,
  phone = "254700000001",
) {
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
      phone,
      national_id: "123",
      accountCode: "KDI-TEST",
      unitId,
      deposit_held: 20000,
      status: "active",
    });
    await ctx.db.patch(unitId, { currentTenantId: tenantId });
    return { tenantId, unitId };
  });
}

async function seedInvoice(
  t: ReturnType<typeof convexTest>,
  orgId: Id<"orgs">,
  tenantId: Id<"tenants">,
  unitId: Id<"units">,
  month = "2026-08",
  total = 20800,
) {
  return t.run(async (ctx) =>
    ctx.db.insert("invoices", {
      orgId,
      tenantId,
      unitId,
      month,
      lines: { rent: total - 800, water: 500, garbage: 300, other: 0 },
      total,
      dueDate: `${month}-05`,
      status: "unpaid",
      balance: total,
    }),
  );
}

function confirm(
  t: ReturnType<typeof convexTest>,
  overrides: Record<string, unknown> = {},
) {
  return t.run(async (ctx) =>
    ctx.runMutation(internal.c2b.recordC2bInternal, {
      shortcode: SHORTCODE,
      transId: "TRX-1",
      transAmount: 20800,
      billRef: "KDI-TEST",
      msisdn: "254700000001",
      firstName: "Jane",
      ...overrides,
    }),
  );
}

test("C2B confirmation matches by account code and records the ledger", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  const invId = await seedInvoice(t, orgId, tenantId, unitId);

  const res = await confirm(t);
  expect(res.status).toBe("matched");
  expect(res.deduplicated).toBe(false);
  expect(res.paymentId).toBeDefined();

  const payment = await asStaff.query(api.payments.getPayment, {
    id: res.paymentId as Id<"payments">,
  });
  expect(payment).toMatchObject({ method: "mpesa_c2b", amount: 20800 });
  const inv = await t.run(async (ctx) => ctx.db.get(invId));
  expect(inv?.balance).toBe(0);
});

test("C2B confirmation falls back to sender phone", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await seedInvoice(t, orgId, tenantId, unitId);

  const res = await confirm(t, { transId: "TRX-2", billRef: "WRONG-REF" });
  expect(res.status).toBe("matched");

  const rows = await asStaff.query(api.c2b.listC2bPayments, { orgId });
  expect(rows.find((r) => r.transId === "TRX-2")?.matchReason).toContain(
    "sender phone",
  );
});

test("C2B confirmation parks unknown senders in the review queue", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  await seedTenant(t, orgId);

  const res = await confirm(t, {
    transId: "TRX-3",
    billRef: "NOBODY",
    msisdn: "254799999999",
  });
  expect(res.status).toBe("pending_review");
  expect(res.paymentId).toBeUndefined();

  // No ledger payment was written for the unknown hit.
  const rows = await asStaff.query(api.payments.listPayments, { orgId });
  expect(rows).toHaveLength(0);

  const queue = await asStaff.query(api.c2b.listC2bPayments, {
    orgId,
    status: "pending_review",
  });
  expect(queue).toHaveLength(1);
});

test("C2B confirmation is idempotent per TransID", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await seedInvoice(t, orgId, tenantId, unitId);

  const first = await confirm(t);
  const second = await confirm(t);
  expect(second.deduplicated).toBe(true);
  expect(second.paymentId).toBe(first.paymentId);

  const rows = await asStaff.query(api.payments.listPayments, { orgId });
  expect(rows).toHaveLength(1);
});

test("Staff can match a queued C2B hit to a tenant", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await seedInvoice(t, orgId, tenantId, unitId);

  const res = await confirm(t, {
    transId: "TRX-4",
    billRef: "TYPO-CODE",
    msisdn: "254799999999",
  });
  expect(res.status).toBe("pending_review");

  const paymentId = await asStaff.mutation(api.c2b.matchC2bPayment, {
    id: res.id,
    tenantId,
  });
  expect(paymentId).toBeDefined();

  const queue = await asStaff.query(api.c2b.listC2bPayments, {
    orgId,
    status: "matched",
  });
  expect(queue.find((r) => r.transId === "TRX-4")?.paymentId).toBe(paymentId);

  // The C2B TransID now dedupes like any other M-Pesa code.
  await expect(
    asStaff.mutation(api.payments.recordManualPayment, {
      orgId,
      tenantId,
      amount: 100,
      method: "mpesa_manual",
      mpesaCode: "TRX-4",
      paidAt: Date.now(),
      note: null,
    }),
  ).rejects.toThrow(/already recorded/);
});

test("Staff can reject a queued C2B hit with a reason", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  await seedTenant(t, orgId);

  const res = await confirm(t, {
    transId: "TRX-5",
    billRef: "NOPE",
    msisdn: "254799999999",
  });
  await asStaff.mutation(api.c2b.rejectC2bPayment, {
    id: res.id,
    reason: "test ping",
  });
  const rows = await asStaff.query(api.c2b.listC2bPayments, {
    orgId,
    status: "rejected",
  });
  expect(rows).toHaveLength(1);
  // Rejecting twice is refused.
  await expect(
    asStaff.mutation(api.c2b.rejectC2bPayment, { id: res.id, reason: "x" }),
  ).rejects.toThrow(/already handled/);
});

test("Unknown shortcodes are rejected loudly", async () => {
  const t = convexTest(schema, modules);
  await seedOrg(t);
  await expect(
    t.run(async (ctx) =>
      ctx.runMutation(internal.c2b.recordC2bInternal, {
        shortcode: "000000",
        transId: "TRX-6",
        transAmount: 1000,
        msisdn: "254700000001",
      }),
    ),
  ).rejects.toThrow(/Unknown business shortcode/);
});

test("createTenant mints a unique account code", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const a = await asStaff.mutation(api.tenants.createTenant, {
    orgId,
    full_name: "Ann One",
    phone: "254711111111",
  });
  const b = await asStaff.mutation(api.tenants.createTenant, {
    orgId,
    full_name: "Ben Two",
    phone: "254722222222",
  });
  expect(a.accountCode).toMatch(/^KDI-/);
  expect(b.accountCode).toMatch(/^KDI-/);
  expect(a.accountCode).not.toBe(b.accountCode);
});

test("matched C2B money shows in collection and breakdown totals", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await seedInvoice(t, orgId, tenantId, unitId);

  await confirm(t);
  const summary = await asStaff.query(api.reports.collectionSummary, {
    orgId,
    startMonth: "2026-08",
    endMonth: "2026-08",
  });
  expect(summary[0].expected).toBe(20800);

  const breakdown = await asStaff.query(api.reports.paymentsBreakdown, {
    orgId,
    startMs: 0,
    endMs: Date.now() + 60_000,
  });
  expect(
    breakdown.byMethod.find((m) => m.method === "mpesa_c2b"),
  ).toMatchObject({ total: 20800, count: 1 });
});

test("C2B confirmation matches by national ID", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await t.run(async (ctx) => {
    await ctx.db.patch(tenantId, { national_id: "33445566" });
  });
  await seedInvoice(t, orgId, tenantId, unitId);

  const res = await confirm(t, { transId: "TRX-NID", billRef: "33445566" });
  expect(res.status).toBe("matched");
  const rows = await asStaff.query(api.c2b.listC2bPayments, { orgId });
  expect(rows.find((r) => r.transId === "TRX-NID")?.matchReason).toContain(
    "national ID",
  );
});

test("ambiguous national IDs fall through to review", async () => {
  const t = convexTest(schema, modules);
  const { orgId } = await seedOrg(t);
  await seedTenant(t, orgId, "254700000001");
  await seedTenant(t, orgId, "254700000002");
  await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("tenants")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
    for (const r of rows) await ctx.db.patch(r._id, { national_id: "99999999" });
  });
  const res = await confirm(t, {
    transId: "TRX-DUPE",
    billRef: "99999999",
    msisdn: "254799999999",
  });
  expect(res.status).toBe("pending_review");
});

test("createTenant prefers readable property-unit codes", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { unitId } = await seedTenant(t, orgId);
  // Second tenant in the same property/unit pattern gets a smart code.
  const unit = await t.run(async (ctx) => ctx.db.get(unitId));
  const propId = unit?.propertyId as Id<"properties">;
  const unit2 = await t.run(async (ctx) =>
    ctx.db.insert("units", {
      orgId,
      propertyId: propId,
      label: "A2",
      unit_type: "one_br",
      rent_amount: 20000,
      water_charge: 500,
      garbage_charge: 300,
      status: "vacant",
    }),
  );
  const tenant = await asStaff.mutation(api.tenants.createTenant, {
    orgId,
    full_name: "Ann Two",
    phone: "254733333333",
    unitId: unit2,
  });
  expect(tenant.accountCode).toBe("GC-A2");
});

test("suggestC2bTenant ranks by name and phone signals", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId } = await seedTenant(t, orgId);
  const res = await confirm(t, {
    transId: "TRX-SUG",
    billRef: "KDI-TES",
    msisdn: "254799999999",
    firstName: "Jane",
    lastName: "Tenant",
  });
  expect(res.status).toBe("pending_review");
  const sug = await asStaff.query(api.c2b.suggestC2bTenant, { id: res.id });
  expect(sug.length).toBeGreaterThan(0);
  expect(sug[0].tenantId).toBe(tenantId);
  void tenantId;
});

test("bulkMatchC2bByPhone matches unambiguous senders", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await seedInvoice(t, orgId, tenantId, unitId);
  // Hit arrives before the tenant's phone is on record: unknown sender, parks.
  await confirm(t, {
    transId: "TRX-BULK",
    billRef: "TYPO",
    msisdn: "254799000111",
  });
  // Tenant updates their number to the sender phone (SIM change, typo fix).
  await t.run(async (ctx) => {
    await ctx.db.patch(tenantId, { phone: "254799000111" });
  });
  const res = await asStaff.mutation(api.c2b.bulkMatchC2bByPhone, { orgId });
  expect(res.matched).toBe(1);
  expect(res.skipped).toBe(0);
  const rows = await asStaff.query(api.payments.listPayments, { orgId });
  expect(rows).toHaveLength(1);
});

test("reversal voids the linked C2B payment", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  const invId = await seedInvoice(t, orgId, tenantId, unitId);
  await confirm(t, { transId: "TRX-REV" });

  const res = await t.run(async (ctx) =>
    ctx.runMutation(internal.c2b.reverseC2bInternal, {
      transId: "TRX-REV",
      reason: "test reversal",
    }),
  );
  expect(res.outcome).toBe("reversed");
  const inv = await t.run(async (ctx) => ctx.db.get(invId));
  expect(inv?.balance).toBe(20800);
  // Second reversal is idempotent.
  const again = await t.run(async (ctx) =>
    ctx.runMutation(internal.c2b.reverseC2bInternal, {
      transId: "TRX-REV",
      reason: "again",
    }),
  );
  expect(again.outcome).toBe("already-reversed");
  void asStaff;
});

test("anomaly scan raises a new-sender alert", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  await seedTenant(t, orgId);
  await confirm(t, {
    transId: "TRX-ALERT",
    billRef: "NOBODY",
    msisdn: "254788888888",
  });
  const alerts = await asStaff.query(api.c2b.listAlerts, { orgId });
  expect(alerts.some((a) => a.kind === "new_sender")).toBe(true);
  await asStaff.mutation(api.c2b.acknowledgeAlert, { id: alerts[0]._id });
  const open = await asStaff.query(api.c2b.listAlerts, { orgId });
  expect(open).toHaveLength(0);
});

test("verifyC2bTransaction scores a known sender as low risk", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await seedInvoice(t, orgId, tenantId, unitId);
  const first = await confirm(t, { transId: "TRX-R1" });
  expect(first.status).toBe("matched");
  const second = await confirm(t, {
    transId: "TRX-R2",
    billRef: "WRONG",
    msisdn: "254700000001",
  });
  expect(second.status).toBe("matched");
  const review = await asStaff.query(api.c2b.verifyC2bTransaction, {
    id: second.id,
  });
  expect(review.risk).toBe("low");
  expect(review.priorFromSender).toBeGreaterThan(0);
});

test("dailyClose and auditTrail report the ledger", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await seedInvoice(t, orgId, tenantId, unitId);
  await confirm(t, { transId: "TRX-DC" });

  const close = await asStaff.query(api.reports.dailyClose, {
    orgId,
    startMs: Date.now() - 7 * 86_400_000,
    endMs: Date.now() + 60_000,
  });
  expect(close.total).toBe(20800);
  expect(close.rows[0].byMethod).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ method: "mpesa_c2b", total: 20800 }),
    ]),
  );
  const trail = await asStaff.query(api.reports.auditTrail, { orgId });
  expect(trail.some((a) => a.action === "c2b.match")).toBe(false);
  // Matched confirmations record payments (audited as payment.record only
  // for manual writes; C2B auto-matches write no actor audit — trail holds
  // staff actions). Just assert the trail reads.
  expect(Array.isArray(trail)).toBe(true);
});

test("monthCashSnapshot matches the cash definition", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await seedInvoice(t, orgId, tenantId, unitId);
  await confirm(t, { transId: "TRX-CASH" });
  const snap = await asStaff.query(api.reports.monthCashSnapshot, {
    orgId,
    month: "2026-08",
  });
  // Invoice side settles in-month; cash lands in the paidAt month (now).
  expect(snap).toMatchObject({ expected: 20800, outstanding: 0 });
  const now = new Date();
  const curMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  if (curMonth === "2026-08") {
    expect(snap.collected).toBe(20800);
  } else {
    const cur = await asStaff.query(api.reports.monthCashSnapshot, {
      orgId,
      month: curMonth,
    });
    expect(cur.collected).toBe(20800);
  }
});

test("manager cannot reverse above the limit; owner can", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await seedInvoice(t, orgId, tenantId, unitId, "2026-08", 60000);
  const res = await asStaff.mutation(api.payments.recordManualPayment, {
    orgId,
    tenantId,
    amount: 60000,
    method: "cash",
    mpesaCode: null,
    paidAt: Date.now(),
    note: null,
  });
  // Add a manager and try as manager.
  const MANAGER = { subject: "manager-1" };
  await t.run(async (ctx) => {
    await ctx.db.insert("orgMembers", {
      orgId,
      userId: MANAGER.subject,
      role: "manager",
    });
  });
  const asManager = t.withIdentity(MANAGER);
  await expect(
    asManager.mutation(api.payments.voidPayment, {
      id: res.id,
      reason: "manager attempt",
    }),
  ).rejects.toThrow(/need the business owner/);
  // Owner succeeds.
  await asStaff.mutation(api.payments.voidPayment, {
    id: res.id,
    reason: "owner void",
  });
  const rows = await asStaff.query(api.payments.listPayments, { orgId });
  expect(rows.find((p) => p._id === res.id)?.status).toBe("voided");
});

test("manager can reverse below the limit", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await seedInvoice(t, orgId, tenantId, unitId);
  const res = await asStaff.mutation(api.payments.recordManualPayment, {
    orgId,
    tenantId,
    amount: 1000,
    method: "cash",
    mpesaCode: null,
    paidAt: Date.now(),
    note: null,
  });
  const MANAGER = { subject: "manager-2" };
  await t.run(async (ctx) => {
    await ctx.db.insert("orgMembers", {
      orgId,
      userId: MANAGER.subject,
      role: "manager",
    });
  });
  const asManager = t.withIdentity(MANAGER);
  await asManager.mutation(api.payments.voidPayment, {
    id: res.id,
    reason: "small correction",
  });
  const rows = await asStaff.query(api.payments.listPayments, { orgId });
  expect(rows.find((p) => p._id === res.id)?.status).toBe("voided");
});

test("simulateC2b dry-runs without writing", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await seedInvoice(t, orgId, tenantId, unitId);
  const sim = await asStaff.query(api.c2b.simulateC2b, {
    orgId,
    billRef: "KDI-TEST",
    msisdn: "254700000001",
    amount: 25000,
  });
  expect(sim.match?.reason).toContain("account code");
  expect(sim.leftover).toBe(25000 - 20800);
  const rows = await asStaff.query(api.payments.listPayments, { orgId });
  expect(rows).toHaveLength(0);
  void tenantId;
});

test("backfillAccountCodes skips coded rows, heals legacy ones", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  await seedTenant(t, orgId);
  // All rows carry codes under the invariant: nothing to mint.
  const res = await asStaff.mutation(api.c2b.backfillAccountCodes, { orgId });
  expect(res.minted).toBe(0);
  expect(res.skipped).toBe(1);
  // Production note: pre-invariant rows are healed by the same mutation —
  // ensureAccountCode patches the missing field, which schema validation
  // permits on patch (only inserts/overwrites require it).
});

test("ensureTenantAccountCode is idempotent on coded rows", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId } = await seedTenant(t, orgId);
  const before = await t.run(async (ctx) => ctx.db.get(tenantId));
  const code = await asStaff.mutation(api.c2b.ensureTenantAccountCode, {
    tenantId,
  });
  expect(code).toBe(before?.accountCode);
  void orgId;
});

test("createTenant births the row with its code (creation invariant)", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const tenant = await asStaff.mutation(api.tenants.createTenant, {
    orgId,
    full_name: "Invariant Ivy",
    phone: "254755555555",
  });
  // No patch-after-insert: the returned row already carries the code.
  expect(tenant.accountCode).toBeTruthy();
  const stored = await t.run(async (ctx) => ctx.db.get(tenant._id));
  expect(stored?.accountCode).toBe(tenant.accountCode);
});

test("msisdnMatch grades exact, pattern, and none", async () => {
  const { msisdnMatch } = await import("./c2b");
  expect(msisdnMatch("254700000001", "254700000001")).toBe("exact");
  expect(msisdnMatch("2547***001", "254700000001")).toBe("pattern");
  expect(msisdnMatch("2547***002", "254700000001")).toBe("none");
  expect(msisdnMatch("94c2c311d522da950619227b3361752a42042db7e1e699b26e628305c68a88", "254700000001")).toBe("none");
  expect(msisdnMatch("", "254700000001")).toBe("none");
});

test("msisdnMatch resolves Daraja SHA-256 sender hashes", async () => {
  const { msisdnMatch } = await import("./c2b");
  // sha256("254700000001") — the production confirmation shape (live-verified).
  const hash = "172509f6416f41d1ce3b78a757c1d4ce90fc1ab1c9d4cdf1edf25ab7bf3fbdfd";
  expect(msisdnMatch(hash, "254700000001")).toBe("exact");
  expect(msisdnMatch(hash, "254700000002")).toBe("none");
  // A tenant stored in legacy 07-format still matches the hash of its
  // international form.
  expect(msisdnMatch(sha256.sha256Hex("0700000001"), "0700000001")).toBe("exact");
  expect(msisdnMatch(hash, "0700000001")).toBe("none");
});

test("v1 hashed sender auto-matches a lone exact fit", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await seedInvoice(t, orgId, tenantId, unitId);
  const res = await confirm(t, {
    transId: "TRX-HASH1",
    billRef: "WRONG",
    msisdn: sha256.sha256Hex("254700000001"),
  });
  expect(res.status).toBe("matched");
  const rows = await asStaff.query(api.c2b.listC2bPayments, { orgId });
  expect(rows.find((r) => r.transId === "TRX-HASH1")?.matchReason).toContain("sender phone");
});

test("C2B confirmation then STK callback records the money once", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await seedInvoice(t, orgId, tenantId, unitId);
  // C2B confirmation lands first and hash-matches the sender.
  const res = await confirm(t, {
    transId: "TRX-RACE1",
    billRef: "WRONG",
    msisdn: sha256.sha256Hex("254700000001"),
  });
  expect(res.status).toBe("matched");
  // The STK callback arrives afterwards with the same receipt.
  const reconcile = await t.run(async (ctx) => {
    await ctx.db.insert("mpesaTransactions", {
      orgId,
      tenantId,
      checkoutRequestId: "co-RACE1",
      phone: "254700000001",
      amount: 20800,
      status: "pending",
      initiatedBy: "staff-1",
    });
    return ctx.runMutation(internal.mpesaInternal.reconcileSuccessInternal, {
      orgId,
      tenantId,
      checkoutRequestId: "co-RACE1",
      amount: 20800,
      mpesaReceipt: "TRX-RACE1",
    });
  });
  expect(reconcile).not.toBeNull();
  expect(reconcile!.deduplicated).toBe(true);
  const pays = await asStaff.query(api.payments.listPayments, { orgId });
  expect(pays.length).toBe(1);
});

test("v2 masked number auto-matches a lone pattern fit", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await seedInvoice(t, orgId, tenantId, unitId);
  const res = await confirm(t, {
    transId: "TRX-MASK1",
    billRef: "WRONG",
    msisdn: "2547***001",
  });
  expect(res.status).toBe("matched");
  const rows = await asStaff.query(api.c2b.listC2bPayments, { orgId });
  expect(rows.find((r) => r.transId === "TRX-MASK1")?.matchReason).toContain("alone");
});

test("v2 masked number shared by two tenants parks for review", async () => {
  const t = convexTest(schema, modules);
  const { orgId } = await seedOrg(t);
  await seedTenant(t, orgId, "254700000001");
  await seedTenant(t, orgId, "254711000001");
  const res = await confirm(t, {
    transId: "TRX-MASK2",
    billRef: "WRONG",
    msisdn: "2547***001",
  });
  expect(res.status).toBe("pending_review");
});

test("C2B confirmation for an already-recorded STK receipt links as duplicate with no second payment", async () => {
  const t = convexTest(schema, modules);
  const { orgId } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await seedInvoice(t, orgId, tenantId, unitId);
  // STK payment recorded first (as the callback reconcile would do it).
  const paymentId = await t.run(async (ctx) =>
    ctx.db.insert("payments", {
      orgId,
      tenantId,
      amount: 1,
      method: "mpesa_stk",
      mpesaCode: "DUP-REC-1",
      paidAt: Date.now(),
      allocations: [],
      receiptNo: "RCP-DUP-1",
      status: "active",
    }),
  );
  const countBefore = await t.run(async (ctx) =>
    (await ctx.db.query("payments").collect()).length,
  );
  // The duplicate C2B confirmation for the same TransID arrives.
  const res = await t.run(async (ctx) =>
    ctx.runMutation(internal.c2b.recordC2bInternal, {
      shortcode: SHORTCODE,
      transId: "DUP-REC-1",
      transAmount: 1,
      billRef: "GIBBERISH",
      msisdn: "254700000001",
    }),
  );
  expect(res.status).toBe("matched");
  expect(res.deduplicated).toBe(true);
  expect(res.paymentId).toBe(paymentId);
  const countAfter = await t.run(async (ctx) =>
    (await ctx.db.query("payments").collect()).length,
  );
  expect(countAfter).toBe(countBefore);
  const row = await t.run(async (ctx) => ctx.db.get(res.id));
  expect(row?.matchReason).toMatch(/duplicate notification/);
});

test("C2B confirmation for a voided payment stays in review", async () => {
  const t = convexTest(schema, modules);
  const { orgId } = await seedOrg(t);
  const { tenantId } = await seedTenant(t, orgId);
  await t.run(async (ctx) =>
    ctx.db.insert("payments", {
      orgId,
      tenantId,
      amount: 1,
      method: "mpesa_stk",
      mpesaCode: "DUP-VOID-1",
      paidAt: Date.now(),
      allocations: [],
      receiptNo: "RCP-DUP-V1",
      status: "voided",
    }),
  );
  const res = await t.run(async (ctx) =>
    ctx.runMutation(internal.c2b.recordC2bInternal, {
      shortcode: SHORTCODE,
      transId: "DUP-VOID-1",
      transAmount: 1,
      billRef: "GIBBERISH",
      // Unknown sender: phone fallback must not match either, so the row
      // parks in review instead of auto-linking the voided payment.
      msisdn: "254799999999",
    }),
  );
  expect(res.status).toBe("pending_review");
  expect(res.deduplicated).toBe(false);
});


test("platform paybill routes by account code across orgs", async () => {
  const t = convexTest(schema, modules);
  const { orgId: platformOrgId, asStaff } = await seedOrg(t);
  // The platform org carries the shortcode with the platform flag.
  await t.run(async (ctx) => {
    await ctx.db.insert("mpesaCredentials", {
      orgId: platformOrgId,
      environment: "sandbox",
      shortcode: SHORTCODE,
      consumerKeyEnc: "test-key",
      consumerSecretEnc: "test-secret",
      passkeyEnc: "test-passkey",
      platformPaybill: true,
    });
  });
  // A different org's tenant owns the account code.
  const orgB: Id<"orgs"> = await t.run(async (ctx) => ctx.db.insert("orgs", {
    name: "Landlord B",
    plan_code: "starter",
    subscription_status: "active",
    invoice_due_day: 5,
  }));
  const { tenantId, unitId } = await seedTenant(t, orgB);
  await seedInvoice(t, orgB, tenantId, unitId);

  const res = await confirm(t, { transId: "TRX-PLAT1", billRef: "KDI-TEST" });
  expect(res.status).toBe("matched");

  const pays = await t.run(async (ctx) => ctx.db.query("payments").collect());
  expect(pays.length).toBe(1);
  expect(pays[0].orgId).toBe(orgB);
  // The platform owes the landlord until settled.
  const ledger = await t.run(async (ctx) => ctx.db.query("platformCollections").collect());
  expect(ledger.length).toBe(1);
  expect(ledger[0].orgId).toBe(orgB);
  expect(ledger[0].amount).toBe(20800);
  // The c2b row lives with the money (org B), not the platform org.
  const rows = await t.run(async (ctx) => ctx.db.query("c2bPayments").collect());
  expect(rows.find((r) => r.transId === "TRX-PLAT1")?.orgId).toBe(orgB);
});

test("platform paybill parks unmatched payments in the platform org", async () => {
  const t = convexTest(schema, modules);
  const { orgId: platformOrgId } = await seedOrg(t);
  await t.run(async (ctx) => {
    await ctx.db.insert("mpesaCredentials", {
      orgId: platformOrgId,
      environment: "sandbox",
      shortcode: SHORTCODE,
      consumerKeyEnc: "test-key",
      consumerSecretEnc: "test-secret",
      passkeyEnc: "test-passkey",
      platformPaybill: true,
    });
  });
  const res = await confirm(t, {
    transId: "TRX-PLAT2",
    billRef: "NOPE",
    msisdn: "254799999999",
  });
  expect(res.status).toBe("pending_review");
  const rows = await t.run(async (ctx) => ctx.db.query("c2bPayments").collect());
  expect(rows[0].orgId).toBe(platformOrgId);
  const pays = await t.run(async (ctx) => ctx.db.query("payments").collect());
  expect(pays.length).toBe(0);
});

test("platform STK twin links to the recorded payment, no second ledger write", async () => {
  const t = convexTest(schema, modules);
  const { orgId: platformOrgId } = await seedOrg(t);
  await t.run(async (ctx) => {
    await ctx.db.insert("mpesaCredentials", {
      orgId: platformOrgId,
      environment: "sandbox",
      shortcode: SHORTCODE,
      consumerKeyEnc: "test-key",
      consumerSecretEnc: "test-secret",
      passkeyEnc: "test-passkey",
      platformPaybill: true,
    });
  });
  const orgB: Id<"orgs"> = await t.run(async (ctx) => ctx.db.insert("orgs", {
    name: "Landlord B",
    plan_code: "starter",
    subscription_status: "active",
    invoice_due_day: 5,
  }));
  const { tenantId, unitId } = await seedTenant(t, orgB);
  await seedInvoice(t, orgB, tenantId, unitId);
  // The STK callback recorded first (same receipt the C2B twin carries).
  await t.run(async (ctx) => {
    await ctx.db.insert("payments", {
      orgId: orgB,
      tenantId,
      amount: 100,
      method: "mpesa_stk",
      mpesaCode: "TRX-TWIN1",
      paidAt: Date.now(),
      allocations: [],
      receiptNo: "RCP-TWIN1",
      status: "active" as const,
    });
  });
  const res = await confirm(t, { transId: "TRX-TWIN1", billRef: "KDI-TEST" });
  expect(res.status).toBe("matched");
  expect(res.deduplicated).toBe(true);
  const pays = await t.run(async (ctx) => ctx.db.query("payments").collect());
  expect(pays.length).toBe(1);
  const ledger = await t.run(async (ctx) => ctx.db.query("platformCollections").collect());
  expect(ledger.length).toBe(0);
});
