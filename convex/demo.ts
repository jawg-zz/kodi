import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { assertStaff, audit } from "./lib/auth";
import { reversePaymentInTx } from "./lib/ledger";

/**
 * Demo-data lifecycle (Settings → Data). The loader creates properties
 * named "* (Demo)"; everything under them is demo scope. Clearing runs in
 * dependency order — void payments (unwinds allocations + credit), delete
 * invoices, tenants (+credits/links), units, then the properties — so the
 * ledger guards never trip.
 */

const DEMO_SUFFIX = " (Demo)";

const demoSummary = v.object({
  properties: v.number(),
  units: v.number(),
  tenants: v.number(),
  invoices: v.number(),
  paymentsVoided: v.number(),
  paymentsDeleted: v.number(),
});

/** How much demo data exists (drives the UI button + confirm copy). */
export const demoStatus = query({
  args: {},
  returns: demoSummary,
  handler: async (ctx) => {
    const caller = await assertStaff(ctx);
    const props = await ctx.db
      .query("properties")
      .withIndex("by_org", (q) => q.eq("orgId", caller.orgId))
      .collect();
    const demoProps = props.filter((p) => p.name.endsWith(DEMO_SUFFIX));
    const demoPropIds = new Set(demoProps.map((p) => p._id));
    const units = await ctx.db
      .query("units")
      .withIndex("by_org", (q) => q.eq("orgId", caller.orgId))
      .collect();
    const demoUnits = units.filter((u) => demoPropIds.has(u.propertyId));
    const tenants = await ctx.db
      .query("tenants")
      .withIndex("by_org", (q) => q.eq("orgId", caller.orgId))
      .collect();
    const demoTenants = tenants.filter(
      (t) =>
        t.unitId !== undefined &&
        demoUnits.some((u) => u._id === t.unitId),
    );
    const demoTenantIds = new Set(demoTenants.map((t) => t._id));
    const invoices = await ctx.db
      .query("invoices")
      .withIndex("by_org", (q) => q.eq("orgId", caller.orgId))
      .collect();
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_org", (q) => q.eq("orgId", caller.orgId))
      .collect();
    return {
      properties: demoProps.length,
      units: demoUnits.length,
      tenants: demoTenants.length,
      invoices: invoices.filter((i) => demoTenantIds.has(i.tenantId)).length,
      paymentsVoided: payments.filter(
        (p) =>
          demoTenantIds.has(p.tenantId) && (p.status ?? "active") !== "active",
      ).length,
      paymentsDeleted: 0,
    };
  },
});

/**
 * Staff: remove all demo data for the org. Voids demo payments first
 * (ledger unwind, audited per payment), then deletes invoices, tenants
 * (+ credits, portal links), units, and the demo properties. Real
 * (non-demo) rows are never touched: scope is strictly the "(Demo)"
 * properties and their tenants.
 */
export const clearDemoData = mutation({
  args: {},
  returns: demoSummary,
  handler: async (ctx) => {
    const caller = await assertStaff(ctx);
    const orgId = caller.orgId;

    const props = await ctx.db
      .query("properties")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
    const demoProps = props.filter((p) => p.name.endsWith(DEMO_SUFFIX));
    if (demoProps.length === 0) {
      throw new ConvexError("No demo data to remove.");
    }
    const demoPropIds = new Set(demoProps.map((p) => p._id));

    const units = await ctx.db
      .query("units")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
    const demoUnits = units.filter((u) => demoPropIds.has(u.propertyId));

    const tenants = await ctx.db
      .query("tenants")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
    const demoTenants = tenants.filter(
      (t) =>
        t.unitId !== undefined && demoUnits.some((u) => u._id === t.unitId),
    );
    const demoTenantIds = new Set(demoTenants.map((t) => t._id));

    // 1) Void demo payments (restores invoice balances, claws back credit).
    let voided = 0;
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
    for (const p of payments) {
      if (!demoTenantIds.has(p.tenantId)) continue;
      if ((p.status ?? "active") !== "active") continue;
      await reversePaymentInTx(
        ctx,
        p._id,
        "voided",
        "Demo data removed",
        caller.userId,
      );
      await audit(ctx, {
        orgId,
        actorUserId: caller.userId,
        action: "payment.void",
        entityType: "payment",
        entityId: p._id,
        metadata: JSON.stringify({ demo: true, receiptNo: p.receiptNo }),
      });
      voided += 1;
    }

    // 2) Delete demo payments (now all voided) + invoices.
    let paymentsDeleted = 0;
    for (const p of payments) {
      if (!demoTenantIds.has(p.tenantId)) continue;
      await ctx.db.delete(p._id);
      paymentsDeleted += 1;
    }
    const invoices = await ctx.db
      .query("invoices")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
    let invoicesDeleted = 0;
    for (const inv of invoices) {
      if (!demoTenantIds.has(inv.tenantId)) continue;
      await ctx.db.delete(inv._id);
      invoicesDeleted += 1;
    }

    // 3) Delete demo tenants (+ credits, portal links, STK/C2B rows).
    for (const t of demoTenants) {
      const credits = await ctx.db
        .query("tenantCredits")
        .withIndex("by_tenant", (q) => q.eq("tenantId", t._id))
        .collect();
      for (const c of credits) await ctx.db.delete(c._id);
      const ledger = await ctx.db
        .query("creditLedger")
        .withIndex("by_tenant", (q) => q.eq("tenantId", t._id))
        .collect();
      for (const l of ledger) await ctx.db.delete(l._id);
      const links = await ctx.db
        .query("tenantUsers")
        .withIndex("by_tenant", (q) => q.eq("tenantId", t._id))
        .collect();
      for (const l of links) await ctx.db.delete(l._id);
      const txs = await ctx.db
        .query("mpesaTransactions")
        .withIndex("by_tenant", (q) => q.eq("tenantId", t._id))
        .collect();
      for (const tx of txs) await ctx.db.delete(tx._id);
      const c2b = await ctx.db
        .query("c2bPayments")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect();
      for (const hit of c2b) {
        if (hit.tenantId === t._id) await ctx.db.delete(hit._id);
      }
      const settlements = await ctx.db
        .query("depositSettlements")
        .withIndex("by_tenant", (q) => q.eq("tenantId", t._id))
        .collect();
      for (const s of settlements) await ctx.db.delete(s._id);
      await ctx.db.delete(t._id);
    }

    // 4) Delete demo units + properties.
    for (const u of demoUnits) await ctx.db.delete(u._id);
    for (const p of demoProps) await ctx.db.delete(p._id);

    await audit(ctx, {
      orgId,
      actorUserId: caller.userId,
      action: "demo.clear",
      entityType: "org",
      entityId: orgId,
      metadata: JSON.stringify({
        properties: demoProps.length,
        units: demoUnits.length,
        tenants: demoTenants.length,
        invoices: invoicesDeleted,
        paymentsVoided: voided,
        paymentsDeleted,
      }),
    });
    return {
      properties: demoProps.length,
      units: demoUnits.length,
      tenants: demoTenants.length,
      invoices: invoicesDeleted,
      paymentsVoided: voided,
      paymentsDeleted,
    };
  },
});
