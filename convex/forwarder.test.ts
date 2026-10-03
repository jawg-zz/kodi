import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import * as forwarder from "./forwarder";
import * as operator from "./operator";
import * as payments from "./payments";

const modules = {
  "./_generated/api.js": () => Promise.resolve({}),
  "./forwarder.js": () => Promise.resolve(forwarder),
  "./operator.js": () => Promise.resolve(operator),
  "./payments.js": () => Promise.resolve(payments),
};

const ADMIN = { subject: "admin-1" };
const STAFF = { subject: "staff-1" };

async function seedPlatformOrg(t: ReturnType<typeof convexTest>) {
  const orgId: Id<"orgs"> = await t.run(async (ctx) => {
    const id = await ctx.db.insert("orgs", {
      name: "Platform",
      plan_code: "growth",
      subscription_status: "active",
      invoice_due_day: 5,
    });
    await ctx.db.insert("mpesaCredentials", {
      orgId: id,
      environment: "sandbox",
      consumerKeyEnc: "x",
      consumerSecretEnc: "y",
      shortcode: "174379",
      passkeyEnc: "z",
      platformPaybill: true,
    });
    return id;
  });
  return orgId;
}

async function seedLandlord(
  t: ReturnType<typeof convexTest>,
  name: string,
  payout: { method: "paybill" | "till" | "pochi" | "b2c"; target: string } | null,
) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("orgs", {
      name,
      plan_code: "starter",
      subscription_status: "active",
      invoice_due_day: 5,
      ...(payout === null
        ? {}
        : { payoutMethod: payout.method, payoutTarget: payout.target, autoForward: true }),
    });
    return id;
  });
}

async function seedCollection(
  t: ReturnType<typeof convexTest>,
  orgId: Id<"orgs">,
  amount: number,
  ageHours: number,
) {
  const tenantId = await t.run(async (ctx) =>
    ctx.db.insert("tenants", {
      orgId,
      full_name: "T",
      phone: "254700000001",
      national_id: "1",
      accountCode: "KDI-X",
      deposit_held: 0,
      status: "active",
    }),
  );
  const paymentId = await t.run(async (ctx) =>
    ctx.db.insert("payments", {
      orgId,
      tenantId,
      amount,
      method: "cash",
      paidAt: Date.now() - ageHours * 3_600_000,
      allocations: [],
      receiptNo: `R-${amount}-${ageHours}`,
      status: "active" as const,
    }),
  );
  await t.run(async (ctx) => {
    await ctx.db.insert("platformCollections", { orgId, paymentId, amount });
  });
}

test("computeFee takes pct of amount, capped per month", async () => {
  const { computeFee } = await import("./forwarder");
  expect(computeFee(200_000, 1.5, 3000, 0)).toBe(3000);
  expect(computeFee(100_000, 1.5, 3000, 0)).toBe(1500);
  expect(computeFee(100_000, 1.5, 3000, 2500)).toBe(500);
  expect(computeFee(100_000, 0, 3000, 0)).toBe(0);
  expect(computeFee(100, 1.5, 3000, 0)).toBe(1);
});

test("distributeFee splits proportionally with no drift", async () => {
  const { distributeFee } = await import("./forwarder");
  const fees = distributeFee([{ amount: 100 }, { amount: 200 }], 45);
  expect(fees.reduce((s, f) => s + f, 0)).toBe(45);
  expect(fees[1]).toBeGreaterThanOrEqual(fees[0]);
  expect(distributeFee([{ amount: 100 }], 0)).toEqual([0]);
});

test("previewSweep returns unsettled rows oldest-first with totals", async () => {
  const t = convexTest(schema, modules);
  await seedPlatformOrg(t);
  const landlord = await seedLandlord(t, "L1", { method: "paybill", target: "615395" });
  // holdHours: 0 — every freshly seeded row is past the window; the test
  // then verifies unsettled-only filtering and oldest-first ordering.
  await seedCollection(t, landlord, 1000, 48);
  await seedCollection(t, landlord, 500, 1);
  const preview = await t.run(async (ctx) =>
    ctx.runQuery(internal.forwarder.previewSweep, { orgId: landlord, holdHours: 0 }),
  );
  expect(preview.total).toBe(1500);
  expect(preview.rows.length).toBe(2);
  expect(preview.rows[0].amount).toBe(1000);
  // A settled row drops out of the next preview.
  await t.run(async (ctx) => {
    const rows = await ctx.db.query("platformCollections").collect();
    await ctx.db.patch(rows[0]._id, { settledAt: Date.now(), payoutRef: "X" });
  });
  const preview2 = await t.run(async (ctx) =>
    ctx.runQuery(internal.forwarder.previewSweep, { orgId: landlord, holdHours: 0 }),
  );
  expect(preview2.total).toBe(500);
  expect(preview2.rows.length).toBe(1);
});

test("sweepCandidates skips suspended orgs and orgs without payout targets", async () => {
  const t = convexTest(schema, modules);
  await seedPlatformOrg(t);
  await seedLandlord(t, "Ready", { method: "till", target: "654321" });
  await seedLandlord(t, "NoTarget", null);
  const suspended = await seedLandlord(t, "Suspended", {
    method: "paybill",
    target: "615395",
  });
  await t.run(async (ctx) =>
    ctx.db.patch(suspended, { subscription_status: "suspended" }),
  );
  const cands = await t.run(async (ctx) =>
    ctx.runQuery(internal.forwarder.sweepCandidates, {}),
  );
  expect(cands.map((c) => c.name)).toEqual(["Ready"]);
});

test("refund after forward writes a negative adjustment row", async () => {
  const t = convexTest(schema, modules);
  await seedPlatformOrg(t);
  const landlord = await seedLandlord(t, "L2", { method: "paybill", target: "615395" });
  const tenantId = await t.run(async (ctx) =>
    ctx.db.insert("tenants", {
      orgId: landlord,
      full_name: "T2",
      phone: "254700000002",
      national_id: "2",
      accountCode: "KDI-Y",
      deposit_held: 0,
      status: "active",
    }),
  );
  const paymentId = await t.run(async (ctx) =>
    ctx.db.insert("payments", {
      orgId: landlord,
      tenantId,
      amount: 5000,
      method: "mpesa_c2b",
      paidAt: Date.now(),
      allocations: [],
      receiptNo: "R-FWD",
      status: "active" as const,
    }),
  );
  await t.run(async (ctx) => {
    await ctx.db.insert("platformCollections", {
      orgId: landlord,
      paymentId,
      amount: 5000,
      fee: 75,
      settledAt: Date.now(),
      payoutRef: "B2B-1",
      settleKind: "auto",
    });
  });
  // Reverse the payment through the public void path — the ledger
  // should gain a negative adjustment row netting the forwarded money.
  await t.run(async (ctx) => {
    await ctx.db.insert("orgMembers", {
      orgId: landlord,
      userId: STAFF.subject,
      role: "owner",
    });
  });
  await t.withIdentity(STAFF).mutation(api.payments.voidPayment, {
    id: paymentId,
    reason: "test void after forward",
  });
  const rows = await t.run(async (ctx) => ctx.db.query("platformCollections").collect());
  const adj = rows.filter((r) => r.amount < 0);
  expect(adj.length).toBe(1);
  expect(adj[0].amount).toBe(-(5000 - 75));
  expect(adj[0].fee).toBe(-75);
});

test("forwardLedger returns newest rows with org names", async () => {
  const t = convexTest(schema, modules);
  const asAdmin = t.withIdentity(ADMIN);
  await t.run(async (ctx) => {
    await ctx.db.insert("platformAdmins", { userId: ADMIN.subject, createdAt: 1 });
  });
  await seedPlatformOrg(t);
  const landlord = await seedLandlord(t, "L3", { method: "paybill", target: "615395" });
  await seedCollection(t, landlord, 2000, 48);
  const rows = await asAdmin.query(api.operator.forwardLedger, { take: 10 });
  expect(rows.length).toBe(1);
  expect(rows[0].orgName).toBe("L3");
  expect(rows[0].pending).toBe(true);
  expect(rows[0].amount).toBe(2000);
});
