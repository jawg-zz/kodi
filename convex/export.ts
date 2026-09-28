import { v } from "convex/values";
import { query } from "./_generated/server";
import { assertOrgMember } from "./lib/auth";

/**
 * Staff-only full-org dump for the Settings → Export backup (JSON) feature.
 * Bounded per table (500–1000 rows) — matches the old client's per-table
 * selects closely enough for a human-readable backup.
 */
export const exportOrg = query({
  args: { orgId: v.id("orgs") },
  returns: v.object({
    exportedAt: v.string(),
    properties: v.array(v.any()),
    units: v.array(v.any()),
    tenants: v.array(v.any()),
    invoices: v.array(v.any()),
    payments: v.array(v.any()),
    deposit_settlements: v.array(v.any()),
    mpesa_transactions: v.array(v.any()),
    tenant_credits: v.array(v.any()),
    credit_ledger: v.array(v.any()),
    c2b_payments: v.array(v.any()),
  }),
  handler: async (ctx, args) => {
    const caller = await assertOrgMember(ctx, args.orgId);
    if (caller.role === "tenant") {
      throw new Error("Staff only");
    }
    const byOrg = (table: "properties" | "units" | "tenants" | "invoices" | "payments" | "depositSettlements" | "mpesaTransactions" | "tenantCredits" | "creditLedger" | "c2bPayments") =>
      ctx.db
        .query(table)
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .take(1000);
    const [properties, units, tenants, invoices, payments, settlements, txs, credits, ledger, c2b] =
      await Promise.all([
        byOrg("properties"),
        byOrg("units"),
        byOrg("tenants"),
        byOrg("invoices"),
        byOrg("payments"),
        byOrg("depositSettlements"),
        byOrg("mpesaTransactions"),
        byOrg("tenantCredits"),
        byOrg("creditLedger"),
        byOrg("c2bPayments"),
      ]);
    return {
      exportedAt: new Date().toISOString(),
      properties,
      units,
      tenants,
      invoices,
      payments,
      deposit_settlements: settlements,
      mpesa_transactions: txs,
      tenant_credits: credits,
      credit_ledger: ledger,
      c2b_payments: c2b,
    };
  },
});
