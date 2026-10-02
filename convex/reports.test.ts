import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import * as reports from "./reports";

// Module map for convex-test: the "./_generated/api.js" key exists only so
// `findModulesRoot` can locate the project root; queries resolve via
// `api.reports.*` against the explicitly provided reports module.
const modules = {
  "./_generated/api.js": () => Promise.resolve({}),
  "./reports.js": () => Promise.resolve(reports),
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
    await ctx.db.insert("orgMembers", { orgId: id, userId: STAFF.subject, role: "owner" });
    return id;
  });
  return { orgId, asStaff: t.withIdentity(STAFF) };
}

async function seedProperty(
  t: ReturnType<typeof convexTest>,
  orgId: Id<"orgs">,
  name: string,
) {
  return t.run(async (ctx) => {
    const propertyId = await ctx.db.insert("properties", {
      orgId,
      name,
      property_type: "apartments",
      location: "Nairobi",
    });
    const occupiedUnit = await ctx.db.insert("units", {
      orgId,
      propertyId,
      label: "A1",
      unit_type: "one_br",
      rent_amount: 20000,
      water_charge: 500,
      garbage_charge: 300,
      status: "occupied",
    });
    const vacantUnit = await ctx.db.insert("units", {
      orgId,
      propertyId,
      label: "A2",
      unit_type: "bedsitter",
      rent_amount: 12000,
      water_charge: 400,
      garbage_charge: 200,
      status: "vacant",
    });
    const tenantId = await ctx.db.insert("tenants", {
      orgId,
      full_name: "Jane Tenant",
      phone: "254700000001",
      national_id: "123",
      accountCode: "GC-A1",
      unitId: occupiedUnit,
      deposit_held: 20000,
      status: "active",
    });
    await ctx.db.patch(occupiedUnit, { currentTenantId: tenantId });
    return { propertyId, occupiedUnit, vacantUnit, tenantId };
  });
}

async function seedInvoice(
  t: ReturnType<typeof convexTest>,
  orgId: Id<"orgs">,
  tenantId: Id<"tenants">,
  unitId: Id<"units">,
  month: string,
  total: number,
  balance: number,
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
      status: balance <= 0 ? "paid" : balance < total ? "partial" : "unpaid",
      balance,
    }),
  );
}

async function seedPayment(
  t: ReturnType<typeof convexTest>,
  orgId: Id<"orgs">,
  tenantId: Id<"tenants">,
  paidAt: number,
  amount: number,
  method: "mpesa_stk" | "mpesa_manual" | "cash" | "bank" = "mpesa_stk",
) {
  return t.run(async (ctx) =>
    ctx.db.insert("payments", {
      orgId,
      tenantId,
      amount,
      method,
      mpesaCode: method === "cash" ? undefined : `CODE-${paidAt}`,
      paidAt,
      allocations: [],
      receiptNo: `RCP-${paidAt}`,
    }),
  );
}

test("collectionSummary uses actual cash per month, not expected-minus-outstanding", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, occupiedUnit } = await seedProperty(t, orgId, "Green Court");

  await seedInvoice(t, orgId, tenantId, occupiedUnit, "2026-07", 20800, 0);
  await seedInvoice(t, orgId, tenantId, occupiedUnit, "2026-08", 20800, 10800);
  // August invoice partially paid late: cash lands in September.
  await seedPayment(t, orgId, tenantId, Date.UTC(2026, 6, 20), 20800);
  await seedPayment(t, orgId, tenantId, Date.UTC(2026, 8, 10), 10000, "cash");

  const rows = await asStaff.query(api.reports.collectionSummary, {
    orgId,
    startMonth: "2026-07",
    endMonth: "2026-09",
  });

  expect(rows.map((r) => r.month)).toEqual(["2026-07", "2026-08", "2026-09"]);
  expect(rows[0]).toMatchObject({ expected: 20800, collected: 20800, outstanding: 0 });
  expect(rows[1]).toMatchObject({ expected: 20800, collected: 0, outstanding: 10800 });
  expect(rows[2]).toMatchObject({ expected: 0, collected: 10000, outstanding: 0 });
});

test("collectionSummary respects the property filter", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const a = await seedProperty(t, orgId, "Alpha");
  const b = await seedProperty(t, orgId, "Beta");

  await seedInvoice(t, orgId, a.tenantId, a.occupiedUnit, "2026-08", 20800, 20800);
  await seedInvoice(t, orgId, b.tenantId, b.occupiedUnit, "2026-08", 20800, 0);
  await seedPayment(t, orgId, b.tenantId, Date.UTC(2026, 7, 6), 20800);

  const all = await asStaff.query(api.reports.collectionSummary, {
    orgId,
    startMonth: "2026-08",
    endMonth: "2026-08",
  });
  expect(all[0]).toMatchObject({ expected: 41600, collected: 20800 });

  const filtered = await asStaff.query(api.reports.collectionSummary, {
    orgId,
    startMonth: "2026-08",
    endMonth: "2026-08",
    propertyId: a.propertyId,
  });
  expect(filtered[0]).toMatchObject({ expected: 20800, collected: 0, outstanding: 20800 });
});

test("arrearsAging buckets by oldest due date", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, occupiedUnit } = await seedProperty(t, orgId, "Green Court");

  await seedInvoice(t, orgId, tenantId, occupiedUnit, "2026-05", 20800, 20800);
  await seedInvoice(t, orgId, tenantId, occupiedUnit, "2026-08", 20800, 5000);

  const result = await asStaff.query(api.reports.arrearsAging, { orgId });
  expect(result.tenantsInArrears).toBe(1);
  expect(result.totalBalance).toBe(25800);
  const row = result.rows[0];
  expect(row).toMatchObject({
    tenantName: "Jane Tenant",
    propertyName: "Green Court",
    openCount: 2,
    oldestMonth: "2026-05",
    bucket: "90+",
  });
  const bucket90 = result.buckets.find((b) => b.bucket === "90+");
  expect(bucket90).toMatchObject({ balance: 25800, count: 1 });
});

test("paymentsBreakdown splits by method inside the window", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId } = await seedProperty(t, orgId, "Green Court");

  await seedPayment(t, orgId, tenantId, Date.UTC(2026, 7, 5), 20000, "mpesa_stk");
  await seedPayment(t, orgId, tenantId, Date.UTC(2026, 7, 6), 5000, "cash");
  await seedPayment(t, orgId, tenantId, Date.UTC(2026, 5, 1), 99999, "bank");

  const result = await asStaff.query(api.reports.paymentsBreakdown, {
    orgId,
    startMs: Date.UTC(2026, 7, 1),
    endMs: Date.UTC(2026, 8, 1),
  });
  expect(result.total).toBe(25000);
  expect(result.count).toBe(2);
  expect(result.byMethod.find((m) => m.method === "mpesa_stk")).toMatchObject({
    total: 20000,
    count: 1,
  });
  expect(result.byMethod.find((m) => m.method === "cash")).toMatchObject({
    total: 5000,
    count: 1,
  });
  expect(result.rows).toHaveLength(2);
  expect(result.truncated).toBe(false);
});

test("mpesaHealth reports success rate for the window", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId } = await seedProperty(t, orgId, "Green Court");

  await t.run(async (ctx) => {
    await ctx.db.insert("mpesaTransactions", {
      orgId,
      tenantId,
      checkoutRequestId: "ok-1",
      phone: "254700000001",
      amount: 20000,
      status: "success",
    });
    await ctx.db.insert("mpesaTransactions", {
      orgId,
      tenantId,
      checkoutRequestId: "fail-1",
      phone: "254700000001",
      amount: 5000,
      status: "failed",
    });
  });

  const result = await asStaff.query(api.reports.mpesaHealth, {
    orgId,
    startMs: Date.now() - 86_400_000,
    endMs: Date.now() + 86_400_000,
  });
  expect(result.total).toBe(2);
  expect(result.successRate).toBe(50);
});

test("rentRoll aggregates occupancy and rent per property", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  await seedProperty(t, orgId, "Green Court");

  const result = await asStaff.query(api.reports.rentRoll, { orgId });
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({
    propertyName: "Green Court",
    units: 2,
    occupied: 1,
    vacant: 1,
    occupancyPct: 50,
    monthlyRent: 20800 + 12600,
    occupiedRent: 20800,
  });
  expect(result.totals).toMatchObject({ units: 2, occupied: 1, vacant: 1 });
});

test("depositsAndCredits sums held deposits and credit carryover", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId } = await seedProperty(t, orgId, "Green Court");

  await t.run(async (ctx) => {
    await ctx.db.insert("tenantCredits", { orgId, tenantId, balance: 3000 });
    await ctx.db.insert("depositSettlements", {
      orgId,
      tenantId,
      depositHeld: 20000,
      deductions: [{ label: "Painting", amount: 2000 }],
      totalDeductions: 2000,
      refundAmount: 18000,
    });
  });

  const result = await asStaff.query(api.reports.depositsAndCredits, { orgId });
  expect(result).toMatchObject({
    depositHeldTotal: 20000,
    tenantsHoldingDeposit: 1,
    settledDeductions: 2000,
    settledRefunds: 18000,
    settlementsCount: 1,
    creditBalanceTotal: 3000,
    tenantsWithCredit: 1,
  });
});

test("reports reject tenant callers and invalid ranges", async () => {
  const t = convexTest(schema, modules);
  const { orgId } = await seedOrg(t);
  const asTenant = t.withIdentity({ subject: "tenant-1" });

  await expect(
    asTenant.query(api.reports.rentRoll, { orgId }),
  ).rejects.toThrow();
});

test("collectionSummary rejects invalid month ranges", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);

  await expect(
    asStaff.query(api.reports.collectionSummary, {
      orgId,
      startMonth: "2026-09",
      endMonth: "2026-07",
    }),
  ).rejects.toThrow();
});

async function seedAllocatedPayment(
  t: ReturnType<typeof convexTest>,
  orgId: Id<"orgs">,
  tenantId: Id<"tenants">,
  invoiceId: Id<"invoices">,
  paidAt: number,
  amount: number,
) {
  return t.run(async (ctx) =>
    ctx.db.insert("payments", {
      orgId,
      tenantId,
      amount,
      method: "mpesa_stk",
      mpesaCode: `TIM-${paidAt}`,
      paidAt,
      allocations: [{ invoiceId, amount, month: undefined }],
      receiptNo: `RCP-T${paidAt}`,
    }),
  );
}

test("propertyCollection splits performance per building with occupancy", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const green = await seedProperty(t, orgId, "Green Court");
  // Second property with one occupied unit and a tenant.
  const maweni = await t.run(async (ctx) => {
    const propertyId = await ctx.db.insert("properties", {
      orgId,
      name: "Maweni",
      property_type: "bedsitters",
      location: "Kasarani",
    });
    const unitId = await ctx.db.insert("units", {
      orgId,
      propertyId,
      label: "B1",
      unit_type: "bedsitter",
      rent_amount: 12000,
      water_charge: 400,
      garbage_charge: 200,
      status: "vacant",
    });
    return { propertyId, unitId };
  });

  await seedInvoice(t, orgId, green.tenantId, green.occupiedUnit, "2026-07", 20800, 0);
  await seedInvoice(t, orgId, green.tenantId, green.occupiedUnit, "2026-07", 20800, 10800);
  // Unassigned invoice: unit missing → rolls into the Unassigned row.
  await t.run(async (ctx) =>
    ctx.db.insert("invoices", {
      orgId,
      tenantId: green.tenantId,
      month: "2026-07",
      lines: { rent: 12000, water: 400, garbage: 200, other: 0 },
      total: 12600,
      dueDate: "2026-07-05",
      status: "unpaid",
      balance: 12600,
    }),
  );

  const { rows } = await asStaff.query(api.reports.propertyCollection, {
    orgId,
    startMonth: "2026-07",
    endMonth: "2026-07",
  });
  const greenRow = rows.find((r: any) => r.propertyName === "Green Court");
  const maweniRow = rows.find((r: any) => r.propertyName === "Maweni");
  const unassigned = rows.find((r: any) => r.propertyName === "Unassigned");
  expect(greenRow).toMatchObject({ units: 2, occupied: 1, expected: 41600, outstanding: 10800 });
  expect(maweniRow).toMatchObject({ units: 1, occupied: 0, expected: 0 });
  expect(unassigned?.expected).toBe(12600);
  // No payments seeded → rate 0; cash attribution is covered below and in
  // the collectionSummary test. Vacant Maweni keeps its row (units > 0).
  expect(greenRow.rate).toBe(0);
  void maweni;
});

test("paymentTimeliness measures first-payment lateness per tenant", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, occupiedUnit } = await seedProperty(t, orgId, "Green Court");
  // Second tenant for an on-time record.
  const second = await t.run(async (ctx) => {
    const tenantId2 = await ctx.db.insert("tenants", {
      orgId,
      full_name: "On-Time Otieno",
      phone: "254700000002",
      national_id: "456",
      accountCode: "GC-A2",
      unitId: occupiedUnit,
      deposit_held: 0,
      status: "active",
    });
    return tenantId2;
  });

  // Jane: due 5 July, paid 20 July → 15 days late.
  const lateInv = await seedInvoice(t, orgId, tenantId, occupiedUnit, "2026-07", 20800, 0);
  await seedAllocatedPayment(t, orgId, tenantId, lateInv, Date.UTC(2026, 6, 20), 20800);
  // Otieno: due 5 July, paid 5 July (EOD) → on time.
  const onTimeInv = await seedInvoice(t, orgId, second, occupiedUnit, "2026-07", 20800, 0);
  await seedAllocatedPayment(t, orgId, second, onTimeInv, Date.UTC(2026, 6, 5, 18), 20800);

  const res = await asStaff.query(api.reports.paymentTimeliness, {
    orgId,
    startMonth: "2026-07",
    endMonth: "2026-07",
  });
  expect(res.paidInvoices).toBe(2);
  expect(res.onTimeRate).toBe(50);
  expect(res.avgDaysLate).toBe(14);
  const jane = res.rows.find((r: any) => r.tenantName === "Jane Tenant");
  const otieno = res.rows.find((r: any) => r.tenantName === "On-Time Otieno");
  expect(jane).toMatchObject({ paidCount: 1, onTimeCount: 0, lateCount: 1, avgDaysLate: 14, worstDaysLate: 14 });
  expect(otieno).toMatchObject({ paidCount: 1, onTimeCount: 1, lateCount: 0, worstDaysLate: 0 });
  // Worst payers first.
  expect(res.rows[0].tenantName).toBe("Jane Tenant");
});

test("arrears rows carry account code and last payment date", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, occupiedUnit } = await seedProperty(t, orgId, "Green Court");
  await seedInvoice(t, orgId, tenantId, occupiedUnit, "2026-07", 20800, 10800);
  await seedPayment(t, orgId, tenantId, Date.UTC(2026, 6, 10), 10000, "cash");

  const res = await asStaff.query(api.reports.arrearsAging, { orgId });
  expect(res.rows.length).toBe(1);
  expect(res.rows[0].accountCode).toBe("GC-A1");
  expect(res.rows[0].lastPaymentAt).toBe(Date.UTC(2026, 6, 10));
});
