import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import * as reports from "./reports";
import * as payments from "./payments";
import * as invoices from "./invoices";
import * as tenants from "./tenants";
import * as mpesaInternal from "./mpesaInternal";

// Module map mirrors reports.test.ts: queries/mutations resolve through
// the explicitly provided modules below. lib/* helpers load as real
// modules (ledger + credit carry no function registry of their own).
const modules = {
  "./_generated/api.js": () => Promise.resolve({}),
  "./reports.js": () => Promise.resolve(reports),
  "./payments.js": () => Promise.resolve(payments),
  "./invoices.js": () => Promise.resolve(invoices),
  "./tenants.js": () => Promise.resolve(tenants),
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
    return id;
  });
  return { orgId, asStaff: t.withIdentity(STAFF) };
}

async function seedTenant(
  t: ReturnType<typeof convexTest>,
  orgId: Id<"orgs">,
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
      phone: "254700000001",
      national_id: "123",
      accountCode: "GC-A1",
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
  month: string,
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

async function readInvoice(
  t: ReturnType<typeof convexTest>,
  id: Id<"invoices">,
) {
  return t.run(async (ctx) => ctx.db.get(id));
}

async function readCredit(
  t: ReturnType<typeof convexTest>,
  tenantId: Id<"tenants">,
) {
  return t.run(async (ctx) =>
    ctx.db
      .query("tenantCredits")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .first(),
  );
}

test("manual payment allocates FIFO and carries leftover to credit", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await seedInvoice(t, orgId, tenantId, unitId, "2026-07");
  await seedInvoice(t, orgId, tenantId, unitId, "2026-08");

  const res = await asStaff.mutation(api.payments.recordManualPayment, {
    orgId,
    tenantId,
    amount: 20800 + 5000,
    method: "cash",
    mpesaCode: null,
    paidAt: Date.now(),
    note: null,
  });

  expect(res.allocations).toHaveLength(2);
  expect(res.allocations[0]).toMatchObject({ amount: 20800 });
  expect(res.allocations[1]).toMatchObject({ amount: 5000 });
  expect(res.leftoverCredit).toBe(0);
  expect(res.creditUsed).toBe(0);

  // Overpay the rest: August keeps 15800 open, excess becomes credit.
  const res2 = await asStaff.mutation(api.payments.recordManualPayment, {
    orgId,
    tenantId,
    amount: 20000,
    method: "cash",
    mpesaCode: null,
    paidAt: Date.now(),
    note: null,
  });
  expect(res2.leftoverCredit).toBe(20000 - 15800);
  const credit = await readCredit(t, tenantId);
  expect(credit?.balance).toBe(20000 - 15800);
  const ledger = await asStaff.query(api.tenants.getCreditLedger, { tenantId });
  expect(ledger.map((l) => l.kind)).toContain("created");
});

test("manual M-Pesa code dedupes across manual and STK rows", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await seedInvoice(t, orgId, tenantId, unitId, "2026-08");

  await asStaff.mutation(api.payments.recordManualPayment, {
    orgId,
    tenantId,
    amount: 1000,
    method: "mpesa_manual",
    mpesaCode: "ABC123",
    paidAt: Date.now(),
    note: null,
  });
  await expect(
    asStaff.mutation(api.payments.recordManualPayment, {
      orgId,
      tenantId,
      amount: 1000,
      method: "mpesa_manual",
      mpesaCode: "ABC123",
      paidAt: Date.now(),
      note: null,
    }),
  ).rejects.toThrow(/already recorded/);

  // Same receipt arriving via STK must also refuse.
  const checkoutId = "chk-dupe-1";
  await t.run(async (ctx) => {
    await ctx.db.insert("mpesaTransactions", {
      orgId,
      tenantId,
      checkoutRequestId: checkoutId,
      phone: "254700000001",
      amount: 1000,
      status: "pending",
    });
  });
  await expect(
    t.run(async (ctx) => {
      const { recordPaymentCore } = await import("./lib/ledger");
      await recordPaymentCore(ctx, {
        orgId,
        tenantId,
        amount: 1000,
        method: "mpesa_stk",
        mpesaCode: "ABC123",
        checkoutRequestId: checkoutId,
      });
    }),
  ).rejects.toThrow(/already recorded/);
});

test("STK reconcile is idempotent across callback and poll", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await seedInvoice(t, orgId, tenantId, unitId, "2026-08");
  const checkoutId = "chk-race-1";
  await t.run(async (ctx) => {
    await ctx.db.insert("mpesaTransactions", {
      orgId,
      tenantId,
      checkoutRequestId: checkoutId,
      phone: "254700000001",
      amount: 20800,
      status: "pending",
    });
  });

  const first = await t.run(async (ctx) =>
    ctx.runMutation(internal.mpesaInternal.reconcileSuccessInternal, {
      orgId,
      tenantId,
      checkoutRequestId: checkoutId,
      amount: 20800,
      mpesaReceipt: "RCPX1",
    }),
  );
  expect(first?.deduplicated).toBe(false);

  // Second writer (poll racing the callback) dedupes to the same payment.
  const second = await t.run(async (ctx) =>
    ctx.runMutation(internal.mpesaInternal.reconcileSuccessInternal, {
      orgId,
      tenantId,
      checkoutRequestId: checkoutId,
      amount: 20800,
      mpesaReceipt: "RCPX1",
    }),
  );
  expect(second?.deduplicated).toBe(true);
  expect(second?.paymentId).toBe(first?.paymentId);

  const rows = await asStaff.query(api.payments.listPayments, { orgId });
  expect(rows.filter((p) => p.checkoutRequestId === checkoutId)).toHaveLength(1);

  const tx = await t.run(async (ctx) =>
    ctx.db
      .query("mpesaTransactions")
      .withIndex("by_checkout", (q) => q.eq("checkoutRequestId", checkoutId))
      .first(),
  );
  expect(tx?.status).toBe("success");
  expect(tx?.paymentId).toBe(first?.paymentId);
});

test("void restores invoices and claws back created credit", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  const invId = await seedInvoice(t, orgId, tenantId, unitId, "2026-08");

  const res = await asStaff.mutation(api.payments.recordManualPayment, {
    orgId,
    tenantId,
    amount: 25000,
    method: "cash",
    mpesaCode: null,
    paidAt: Date.now(),
    note: null,
  });
  expect(res.leftoverCredit).toBe(25000 - 20800);
  expect((await readInvoice(t, invId))?.balance).toBe(0);

  const voided = await asStaff.mutation(api.payments.voidPayment, {
    id: res.id,
    reason: "wrong tenant",
  });
  expect(voided.creditShortfall).toBe(0);
  expect((await readInvoice(t, invId))?.balance).toBe(20800);
  expect((await readCredit(t, tenantId))?.balance ?? 0).toBe(0);

  const rows = await asStaff.query(api.payments.listPayments, { orgId });
  expect(rows.find((p) => p._id === res.id)?.status).toBe("voided");

  // Doubly reversing is refused.
  await expect(
    asStaff.mutation(api.payments.refundPayment, { id: res.id, reason: "x" }),
  ).rejects.toThrow(/already reversed/);

  // Voided money drops out of collection totals.
  const summary = await asStaff.query(api.reports.collectionSummary, {
    orgId,
    startMonth: "2026-08",
    endMonth: "2026-08",
  });
  expect(summary[0].collected).toBe(0);
});

test("void with spent credit floors at zero and reports the shortfall", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await seedInvoice(t, orgId, tenantId, unitId, "2026-08");

  // Overpay 5000 into credit, then let September's generation consume it.
  const res = await asStaff.mutation(api.payments.recordManualPayment, {
    orgId,
    tenantId,
    amount: 20800 + 5000,
    method: "cash",
    mpesaCode: null,
    paidAt: Date.now(),
    note: null,
  });
  expect(res.leftoverCredit).toBe(5000);
  await seedInvoice(t, orgId, tenantId, unitId, "2026-09");
  await asStaff.mutation(api.invoices.generateInvoices, {
    orgId,
    month: "2026-09",
  });
  expect((await readCredit(t, tenantId))?.balance ?? 0).toBe(0);

  const voided = await asStaff.mutation(api.payments.voidPayment, {
    id: res.id,
    reason: "test entry",
  });
  expect(voided.creditShortfall).toBe(5000);
});

test("targeted payment hits the named invoice first, then FIFO", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  const july = await seedInvoice(t, orgId, tenantId, unitId, "2026-07");
  const aug = await seedInvoice(t, orgId, tenantId, unitId, "2026-08");

  const res = await asStaff.mutation(api.payments.recordManualPayment, {
    orgId,
    tenantId,
    amount: 10000,
    method: "cash",
    mpesaCode: null,
    paidAt: Date.now(),
    note: null,
    targets: [aug],
  });
  expect(res.allocations).toHaveLength(1);
  expect(res.allocations[0].invoiceId).toBe(aug);
  expect((await readInvoice(t, aug))?.balance).toBe(10800);
  expect((await readInvoice(t, july))?.balance).toBe(20800);
});

test("useCredit spends held credit before the cash amount", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await seedInvoice(t, orgId, tenantId, unitId, "2026-08");

  const over = await asStaff.mutation(api.payments.recordManualPayment, {
    orgId,
    tenantId,
    amount: 20800 + 3000,
    method: "cash",
    mpesaCode: null,
    paidAt: Date.now(),
    note: null,
  });
  expect(over.leftoverCredit).toBe(3000);

  await seedInvoice(t, orgId, tenantId, unitId, "2026-09");
  const res = await asStaff.mutation(api.payments.recordManualPayment, {
    orgId,
    tenantId,
    amount: 5000,
    method: "cash",
    mpesaCode: null,
    paidAt: Date.now(),
    note: null,
    useCredit: true,
  });
  // 3000 credit settles part of September; 5000 cash covers more of it.
  expect(res.creditUsed).toBe(3000);
  const sept = await t.run(async (ctx) =>
    ctx.db
      .query("invoices")
      .withIndex("by_tenant_month", (q) =>
        q.eq("tenantId", tenantId).eq("month", "2026-09"),
      )
      .first(),
  );
  expect(sept?.balance).toBe(20800 - 3000 - 5000);
});

test("previewAllocation dry-runs the split without touching rows", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  const invId = await seedInvoice(t, orgId, tenantId, unitId, "2026-08");

  const preview = await asStaff.query(api.invoices.previewAllocation, {
    tenantId,
    amount: 25000,
  });
  expect(preview.allocations).toHaveLength(1);
  expect(preview.allocations[0]).toMatchObject({ month: "2026-08", applied: 20800 });
  expect(preview.leftover).toBe(4200);
  expect((await readInvoice(t, invId))?.balance).toBe(20800);
});

test("deleteTenant refuses when money history exists", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await seedInvoice(t, orgId, tenantId, unitId, "2026-08");

  await expect(asStaff.mutation(api.tenants.deleteTenant, { id: tenantId })).rejects.toThrow(
    /invoices or payments/,
  );
});

test("paymentsBreakdown carries status and allocation detail", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedTenant(t, orgId);
  await seedInvoice(t, orgId, tenantId, unitId, "2026-08");

  const res = await asStaff.mutation(api.payments.recordManualPayment, {
    orgId,
    tenantId,
    amount: 10000,
    method: "cash",
    mpesaCode: null,
    paidAt: Date.now(),
    note: null,
  });
  await asStaff.mutation(api.payments.voidPayment, {
    id: res.id,
    reason: "test",
  });

  const breakdown = await asStaff.query(api.reports.paymentsBreakdown, {
    orgId,
    startMs: 0,
    endMs: Date.now() + 60_000,
  });
  // Voided money is out of totals but still listed for the audit trail.
  expect(breakdown.total).toBe(0);
  expect(breakdown.count).toBe(0);
  expect(breakdown.rows).toHaveLength(1);
  expect(breakdown.rows[0]).toMatchObject({ status: "voided" });
  expect(breakdown.rows[0].allocationSummary).toContain("2026-08");
});


test("classifyStkCode: terminal codes map, transitional/unknown stay pending", async () => {
  const { classifyStkCode } = await import("./lib/stkOutcome");
  expect(classifyStkCode("0")).toBe("success");
  expect(classifyStkCode(0)).toBe("success");
  expect(classifyStkCode("1031")).toBe("cancelled");
  expect(classifyStkCode("1032")).toBe("cancelled");
  expect(classifyStkCode("1037")).toBe("timeout");
  // Transitional query states and unknowns must NOT fail the row.
  expect(classifyStkCode("")).toBe("pending");
  expect(classifyStkCode(undefined)).toBe("pending");
  expect(classifyStkCode("9999")).toBe("pending");
  expect(classifyStkCode("1")).toBe("pending");
});
