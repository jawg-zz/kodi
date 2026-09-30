import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { audit } from "./lib/auth";

/** Internal backing for collect.ts (QR cache + invoice reads + audits). */

export const getInvoiceForQr = internalQuery({
  args: { invoiceId: v.id("invoices") },
  returns: v.union(
    v.object({
      orgId: v.id("orgs"),
      balance: v.number(),
      accountCode: v.string(),
      orgName: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const inv = await ctx.db.get(args.invoiceId);
    if (inv === null) return null;
    const tenant = await ctx.db.get(inv.tenantId);
    if (tenant === null) return null;
    const org = await ctx.db.get(inv.orgId);
    return {
      orgId: inv.orgId,
      balance: inv.balance,
      accountCode: tenant.accountCode,
      orgName: org?.name,
    };
  },
});

export const getCachedQr = internalQuery({
  args: { invoiceId: v.id("invoices") },
  returns: v.union(
    v.object({
      qrBase64: v.string(),
      amount: v.number(),
      refNo: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("invoiceQrs")
      .withIndex("by_invoice", (q) => q.eq("invoiceId", args.invoiceId))
      .first();
    if (row === null) return null;
    return { qrBase64: row.qrBase64, amount: row.amount, refNo: row.refNo };
  },
});

export const storeQr = internalMutation({
  args: {
    orgId: v.id("orgs"),
    invoiceId: v.id("invoices"),
    qrBase64: v.string(),
    amount: v.number(),
    refNo: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("invoiceQrs")
      .withIndex("by_invoice", (q) => q.eq("invoiceId", args.invoiceId))
      .first();
    if (existing === null) {
      await ctx.db.insert("invoiceQrs", args);
    } else {
      await ctx.db.patch(existing._id, {
        qrBase64: args.qrBase64,
        amount: args.amount,
        refNo: args.refNo,
      });
    }
    return null;
  },
});

export const auditShortcodeCheck = internalMutation({
  args: {
    orgId: v.id("orgs"),
    actorUserId: v.string(),
    shortcode: v.string(),
    result: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await audit(ctx, {
      orgId: args.orgId,
      actorUserId: args.actorUserId,
      action: "daraja.shortcode_check",
      entityType: "mpesaCredentials",
      metadata: `${args.shortcode}: ${args.result}`.slice(0, 300),
    });
    return null;
  },
});
