import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import * as operator from "./operator";
import * as orgs from "./orgs";
import * as invoices from "./invoices";
import * as helpers from "./helpers";

const modules = {
  "./_generated/api.js": () => Promise.resolve({}),
  "./operator.js": () => Promise.resolve(operator),
  "./orgs.js": () => Promise.resolve(orgs),
  "./invoices.js": () => Promise.resolve(invoices),
  "./helpers.js": () => Promise.resolve(helpers),
};

const ADMIN = { subject: "admin-1" };
const STAFF = { subject: "staff-1" };

async function seedAdmin(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("platformAdmins", { userId: ADMIN.subject, createdAt: 1 });
  });
  return t.withIdentity(ADMIN);
}

async function seedOrg(t: ReturnType<typeof convexTest>, name = "Test Org") {
  const orgId: Id<"orgs"> = await t.run(async (ctx) => {
    const id = await ctx.db.insert("orgs", {
      name,
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

test("non-admin cannot use the operator console", async () => {
  const t = convexTest(schema, modules);
  const { orgId } = await seedOrg(t);
  const asStranger = t.withIdentity(STAFF);
  await expect(asStranger.query(api.operator.orgOverview, {})).rejects.toThrow(
    /Not a platform admin/,
  );
  await expect(
    asStranger.mutation(api.operator.setOrgPlanStatus, { orgId, status: "suspended" }),
  ).rejects.toThrow(/Not a platform admin/);
  await expect(
    asStranger.mutation(api.operator.recordSettlement, {
      orgId,
      amount: 100,
      payoutRef: "X",
    }),
  ).rejects.toThrow(/Not a platform admin/);
});

test("admin sees org overview and can suspend an org", async () => {
  const t = convexTest(schema, modules);
  const asAdmin = await seedAdmin(t);
  const { orgId } = await seedOrg(t, "Landlord B");
  const rows = await asAdmin.query(api.operator.orgOverview, {});
  expect(rows.length).toBe(1);
  expect(rows[0].name).toBe("Landlord B");
  expect(rows[0].status).toBe("active");
  await asAdmin.mutation(api.operator.setOrgPlanStatus, {
    orgId,
    status: "suspended",
  });
  const rows2 = await asAdmin.query(api.operator.orgOverview, {});
  expect(rows2[0].status).toBe("suspended");
});

test("recordSettlement marks oldest rows settled with the payout ref", async () => {
  const t = convexTest(schema, modules);
  const asAdmin = await seedAdmin(t);
  const { orgId } = await seedOrg(t);
  const tenantId = await t.run(async (ctx) =>
    ctx.db.insert("tenants", {
      orgId,
      full_name: "Jane Tenant",
      phone: "254700000001",
      national_id: "123",
      accountCode: "KDI-TEST",
      deposit_held: 0,
      status: "active",
    }),
  );
  const paymentId = await t.run(async (ctx) =>
    ctx.db.insert("payments", {
      orgId,
      tenantId,
      amount: 100,
      method: "cash",
      paidAt: 1,
      allocations: [],
      receiptNo: "R1",
      status: "active" as const,
    }),
  );
  await t.run(async (ctx) => {
    await ctx.db.insert("platformCollections", { orgId, paymentId, amount: 100 });
    await ctx.db.insert("platformCollections", { orgId, paymentId, amount: 200 });
  });
  const res = await asAdmin.mutation(api.operator.recordSettlement, {
    orgId,
    amount: 150,
    payoutRef: "MPESA-1",
  });
  expect(res).toEqual({ rows: 1, settled: 100 });
  const rows = await t.run(async (ctx) => ctx.db.query("platformCollections").collect());
  const settled = rows.filter((r) => r.settledAt !== undefined);
  expect(settled.length).toBe(1);
  expect(settled[0].payoutRef).toBe("MPESA-1");
  expect(settled[0].settleKind).toBe("manual");
});

test("owner can set payout preference; manager cannot", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  await asStaff.mutation(api.orgs.setPayoutPreference, {
    orgId,
    method: "till",
    target: "654321",
  });
  const org = await t.run(async (ctx) => ctx.db.get(orgId));
  expect(org?.payoutMethod).toBe("till");
  expect(org?.payoutTarget).toBe("654321");
  await expect(
    asStaff.mutation(api.orgs.setPayoutPreference, {
      orgId,
      method: "paybill",
      target: "abc",
    }),
  ).rejects.toThrow(/5–12 digits/);
});

test("suspended org cannot generate invoices", async () => {
  const t = convexTest(schema, modules);
  const { orgId, asStaff } = await seedOrg(t);
  await t.run(async (ctx) => ctx.db.patch(orgId, { subscription_status: "suspended" }));
  await expect(
    asStaff.mutation(api.invoices.generateInvoices, { orgId, month: "2026-09" }),
  ).rejects.toThrow(/suspended/);
});
