import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import * as demo from "./demo";
import * as payments from "./payments";
import * as invoices from "./invoices";
import * as tenants from "./tenants";
import * as properties from "./properties";
import * as c2b from "./c2b";
import * as reports from "./reports";
import * as mpesaInternal from "./mpesaInternal";
import * as helpers from "./helpers";

const modules = {
  "./_generated/api.js": () => Promise.resolve({}),
  "./demo.js": () => Promise.resolve(demo),
  "./payments.js": () => Promise.resolve(payments),
  "./invoices.js": () => Promise.resolve(invoices),
  "./tenants.js": () => Promise.resolve(tenants),
  "./properties.js": () => Promise.resolve(properties),
  "./c2b.js": () => Promise.resolve(c2b),
  "./reports.js": () => Promise.resolve(reports),
  "./mpesaInternal.js": () => Promise.resolve(mpesaInternal),
  "./helpers.js": () => Promise.resolve(helpers),
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

async function seedDemoScope(
  t: ReturnType<typeof convexTest>,
  orgId: Id<"orgs">,
) {
  return t.run(async (ctx) => {
    const propId = await ctx.db.insert("properties", {
      orgId,
      name: "Baraka Court (Demo)",
      property_type: "apartments",
      location: "Kilimani",
    });
    const unitId = await ctx.db.insert("units", {
      orgId,
      propertyId: propId,
      label: "A1",
      unit_type: "one_br",
      rent_amount: 20000,
      water_charge: 500,
      garbage_charge: 300,
      status: "occupied",
    });
    const tenantId = await ctx.db.insert("tenants", {
      orgId,
      full_name: "Demo Dan",
      phone: "254700000001",
      national_id: "111",
      accountCode: "BC-A1",
      unitId,
      deposit_held: 20000,
      status: "active",
    });
    await ctx.db.patch(unitId, { currentTenantId: tenantId });
    return { propId, unitId, tenantId };
  });
}

test("demoStatus reports empty when no demo data", async () => {
  const t = convexTest(schema, modules);
  await seedOrg(t);
  const asStaff = t.withIdentity(STAFF);
  const s = await asStaff.query(api.demo.demoStatus, {});
  expect(s).toMatchObject({ properties: 0, tenants: 0, invoices: 0 });
});

test("clearDemoData refuses when nothing demo exists", async () => {
  const t = convexTest(schema, modules);
  await seedOrg(t);
  const asStaff = t.withIdentity(STAFF);
  await expect(asStaff.mutation(api.demo.clearDemoData, {})).rejects.toThrow(
    /No demo data/,
  );
});

test("clearDemoData removes demo scope, keeps real rows", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  const { tenantId, unitId } = await seedDemoScope(t, orgId);

  // Demo invoice + payment (goes through the ledger like the UI loader).
  await t.run(async (ctx) =>
    ctx.db.insert("invoices", {
      orgId,
      tenantId,
      unitId,
      month: "2026-08",
      lines: { rent: 20000, water: 500, garbage: 300, other: 0 },
      total: 20800,
      dueDate: "2026-08-05",
      status: "unpaid",
      balance: 20800,
    }),
  );
  const payment: { id: Id<"payments"> } = await asStaff.mutation(
    api.payments.recordManualPayment,
    {
      orgId,
      tenantId,
      amount: 20800,
      method: "cash",
      mpesaCode: null,
      paidAt: Date.now(),
      note: "Demo payment",
    },
  );
  const paymentId = payment.id;

  // A REAL tenant + property that must survive.
  const real = await t.run(async (ctx) => {
    const propId = await ctx.db.insert("properties", {
      orgId,
      name: "Real Court",
      property_type: "apartments",
      location: "Westlands",
    });
    const u = await ctx.db.insert("units", {
      orgId,
      propertyId: propId,
      label: "R1",
      unit_type: "one_br",
      rent_amount: 30000,
      water_charge: 500,
      garbage_charge: 300,
      status: "occupied",
    });
    const ten = await ctx.db.insert("tenants", {
      orgId,
      full_name: "Real Rita",
      phone: "254711111111",
      national_id: "222",
      accountCode: "RC-R1",
      unitId: u,
      deposit_held: 30000,
      status: "active",
    });
    return { propId, unitId: u, tenantId: ten };
  });

  const before = await asStaff.query(api.demo.demoStatus, {});
  expect(before).toMatchObject({ properties: 1, tenants: 1, invoices: 1 });

  const res = await asStaff.mutation(api.demo.clearDemoData, {});
  expect(res).toMatchObject({
    properties: 1,
    units: 1,
    tenants: 1,
    invoices: 1,
    paymentsVoided: 1,
    paymentsDeleted: 1,
  });

  // Demo gone: tenant, unit, property, invoice, payment.
  const gone = await t.run(async (ctx) => ({
    tenant: await ctx.db.get(tenantId),
    unit: await ctx.db.get(unitId),
    payment: await ctx.db.get(paymentId),
  }));
  expect(gone.tenant).toBeNull();
  expect(gone.unit).toBeNull();
  expect(gone.payment).toBeNull();

  // Real rows untouched.
  const kept = await t.run(async (ctx) => ({
    tenant: await ctx.db.get(real.tenantId),
    unit: await ctx.db.get(real.unitId),
    prop: await ctx.db.get(real.propId),
  }));
  expect(kept.tenant?.full_name).toBe("Real Rita");
  expect(kept.unit?.label).toBe("R1");
  expect(kept.prop?.name).toBe("Real Court");

  const after = await asStaff.query(api.demo.demoStatus, {});
  expect(after).toMatchObject({ properties: 0, tenants: 0 });
});
