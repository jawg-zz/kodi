import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { audit } from "./lib/auth";
import { recordPaymentCore } from "./lib/ledger";
import { decryptSecret } from "./lib/mpesaCrypto";

/** Internal Bill Manager backing: opt-in flags, app-key reads, mirror selection, payment ingest. */

export const markOptedIn = internalMutation({
    args: {
      orgId: v.id("orgs"),
      email: v.string(),
      appKeyEnc: v.optional(v.string()),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
      const existing = await ctx.db
        .query("billManagerState")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .first();
      if (existing === null) {
        await ctx.db.insert("billManagerState", {
          orgId: args.orgId,
          optedIn: true,
          appKeyEnc: args.appKeyEnc,
          email: args.email,
        });
      } else {
        await ctx.db.patch(existing._id, {
          optedIn: true,
          appKeyEnc: args.appKeyEnc ?? existing.appKeyEnc,
          email: args.email,
        });
      }
      const creds = await ctx.db
        .query("mpesaCredentials")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .first();
      if (creds !== null) {
        await ctx.db.patch(creds._id, {
          billManagerOptedIn: true,
          billManagerEmail: args.email,
          ...(args.appKeyEnc !== undefined
            ? { billManagerAppKeyEnc: args.appKeyEnc }
            : {}),
        });
      }
      return null;
    },
});

export const getAppKey = internalQuery({
    args: { orgId: v.id("orgs") },
    returns: v.union(v.string(), v.null()),
    handler: async (ctx, args) => {
      const state = await ctx.db
        .query("billManagerState")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .first();
      const enc =
        state?.appKeyEnc ??
        (
          await ctx.db
            .query("mpesaCredentials")
            .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
            .first()
        )?.billManagerAppKeyEnc;
      if (enc === undefined) return null;
      try {
        return await decryptSecret(enc);
      } catch {
        return null;
      }
    },
});

export const unpaidForMirror = internalQuery({
    args: { orgId: v.id("orgs"), month: v.optional(v.string()) },
    returns: v.object({
      appKey: v.union(v.string(), v.null()),
      invoices: v.array(
        v.object({
          invoiceId: v.string(),
          tenantName: v.string(),
          phone: v.string(),
          month: v.string(),
          dueDate: v.string(),
          accountCode: v.string(),
          balance: v.number(),
          items: v.array(
            v.object({ itemName: v.string(), amount: v.number() }),
          ),
        }),
      ),
    }),
    handler: async (ctx, args) => {
      const state = await ctx.db
        .query("billManagerState")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .first();
      const enc =
        state?.appKeyEnc ??
        (
          await ctx.db
            .query("mpesaCredentials")
            .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
            .first()
        )?.billManagerAppKeyEnc;
      let appKey: string | null = null;
      if (enc !== undefined) {
        try {
          appKey = await decryptSecret(enc);
        } catch {
          appKey = null;
        }
      }
      const invoices = await ctx.db
        .query("invoices")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect();
      const out = [];
      for (const inv of invoices) {
        if (inv.balance <= 0) continue;
        if (args.month !== undefined && inv.month !== args.month) continue;
        const tenant = await ctx.db.get(inv.tenantId);
        if (tenant === null) continue;
        out.push({
          invoiceId: String(inv._id),
          tenantName: tenant.full_name,
          phone: tenant.phone,
          month: inv.month,
          dueDate: inv.dueDate,
          accountCode: tenant.accountCode,
          balance: inv.balance,
          items: [
            { itemName: "Rent", amount: inv.lines.rent },
            { itemName: "Water", amount: inv.lines.water },
            { itemName: "Garbage", amount: inv.lines.garbage },
            { itemName: "Other", amount: inv.lines.other },
          ].filter((i) => i.amount > 0),
        });
      }
      return { appKey, invoices: out };
    },
});

export const markMirrored = internalMutation({
    args: {
      orgId: v.id("orgs"),
      actorUserId: v.string(),
      summary: v.string(),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
      const state = await ctx.db
        .query("billManagerState")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .first();
      if (state !== null) {
        await ctx.db.patch(state._id, { lastMirroredAt: Date.now() });
      }
      await audit(ctx, {
        orgId: args.orgId,
        actorUserId: args.actorUserId,
        action: "billmanager.mirror",
        entityType: "invoice",
        metadata: args.summary.slice(0, 300),
      });
      return null;
    },
});

export const auditCancel = internalMutation({
    args: {
      orgId: v.id("orgs"),
      actorUserId: v.string(),
      ref: v.string(),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
      await audit(ctx, {
        orgId: args.orgId,
        actorUserId: args.actorUserId,
        action: "billmanager.cancel",
        entityType: "invoice",
        entityId: args.ref,
      });
      return null;
    },
});

  /**
   * Ingest a Bill Manager payment callback: dedupe by transactionId
   * (Safaricom retries 5×), then reconcile through recordC2bInternal so
   * matching/allocation/credit behave exactly like a C2B hit.
   */
export const ingestPayment = internalMutation({
    args: {
      shortcode: v.string(),
      transactionId: v.string(),
      paidAmount: v.number(),
      msisdn: v.string(),
      accountReference: v.optional(v.string()),
      dateCreated: v.optional(v.string()),
    },
    returns: v.object({
      status: v.string(),
      deduplicated: v.boolean(),
      // Acknowledgment fields for the reconciliation POST (docs step 3):
      // only present on fresh matched ingests. The route fires the POST;
      // without it Safaricom never sends the tenant the e-receipt.
      ack: v.optional(
        v.object({
          orgId: v.id("orgs"),
          paymentDate: v.string(),
          paidAmount: v.number(),
          accountReference: v.string(),
          transactionId: v.string(),
          phoneNumber: v.string(),
          fullName: v.string(),
          invoiceName: v.string(),
          externalReference: v.string(),
        }),
      ),
    }),
    handler: async (ctx, args) => {
      // Route shortcode → org via the credentials scan (one row per org —
      // same pattern as c2b.ts orgForShortcode).
      const rows = await ctx.db.query("mpesaCredentials").collect();
      const orgRow = rows.find((r) => r.shortcode === args.shortcode);
      if (orgRow === undefined) {
        throw new ConvexError("Unknown business shortcode");
      }
      const bmState = await ctx.db
        .query("billManagerState")
        .withIndex("by_org", (q) => q.eq("orgId", orgRow.orgId))
        .first();
      const seen = bmState?.seenTransactionIds ?? [];
      if (seen.includes(args.transactionId)) {
        return { status: "duplicate", deduplicated: true };
      }
      const existing = await ctx.db
        .query("c2bPayments")
        .withIndex("by_trans", (q) => q.eq("transId", args.transactionId))
        .first();
      if (existing !== null) {
        return { status: existing.status, deduplicated: true };
      }
      // Match: account code exact → national ID → phone exact (FULL msisdn
      // from Bill Manager, so exact phone works — no masking here).
      const ref = (args.accountReference ?? "").trim().toUpperCase();
      let tenantId: Id<"tenants"> | null = null;
      let reason = "";
      if (ref !== "") {
        const byCode = await ctx.db
          .query("tenants")
          .withIndex("by_account", (q) => q.eq("accountCode", ref))
          .first();
        if (byCode !== null && byCode.orgId === orgRow.orgId) {
          tenantId = byCode._id;
          reason = `billmanager account ${ref}`;
        }
      }
      if (tenantId === null) {
        const tenants = await ctx.db
          .query("tenants")
          .withIndex("by_org", (q) => q.eq("orgId", orgRow.orgId))
          .collect();
        const byPhone = tenants.filter(
          (t) =>
            t.status !== "moved_out" &&
            t.phone.replace(/\D/g, "") === args.msisdn.replace(/\D/g, ""),
        );
        if (byPhone.length === 1) {
          tenantId = byPhone[0]._id;
          reason = "billmanager full phone";
        }
      }
      if (tenantId === null) {
        const id = await ctx.db.insert("c2bPayments", {
          orgId: orgRow.orgId,
          transId: args.transactionId,
          transAmount: Math.round(args.paidAmount),
          billRef: args.accountReference?.trim() || undefined,
          msisdn: args.msisdn,
          transTime: args.dateCreated,
          status: "pending_review",
          matchReason: `Bill Manager: no tenant for ref "${args.accountReference ?? ""}" or phone`,
          rawPayload: `billmanager:${args.transactionId}`,
        });
        void id;
        if (bmState !== null) {
          await ctx.db.patch(bmState._id, {
            seenTransactionIds: [...seen, args.transactionId].slice(-500),
          });
        }
        return { status: "pending_review", deduplicated: false };
      }
      const res = await recordPaymentCore(ctx, {
        orgId: orgRow.orgId,
        tenantId,
        amount: Math.round(args.paidAmount),
        method: "mpesa_c2b",
        mpesaCode: args.transactionId,
        note: `Bill Manager ${args.shortcode}${ref ? ` · ${ref}` : ""}`,
      });
      await ctx.db.insert("c2bPayments", {
        orgId: orgRow.orgId,
        tenantId,
        transId: args.transactionId,
        transAmount: Math.round(args.paidAmount),
        billRef: args.accountReference?.trim() || undefined,
        msisdn: args.msisdn,
        transTime: args.dateCreated,
        status: "matched",
        matchReason: reason,
        paymentId: res.id,
        rawPayload: `billmanager:${args.transactionId}`,
      });
      if (bmState !== null) {
        await ctx.db.patch(bmState._id, {
          seenTransactionIds: [...seen, args.transactionId].slice(-500),
        });
      }
      // Best-effort ack fields: tenant name + the invoice this payment
      // most plausibly settles (newest open invoice). Missing pieces fall
      // back to the callback values — the ack POST accepts them.
      const tenant = await ctx.db.get(tenantId);
      const openInv = await ctx.db
        .query("invoices")
        .withIndex("by_tenant_month", (q) => q.eq("tenantId", tenantId))
        .order("desc")
        .take(5);
      const newestOpen = openInv.find((i) => i.balance > 0) ?? openInv[0];
      return {
        status: "matched",
        deduplicated: false,
        ack: {
          orgId: orgRow.orgId,
          paymentDate: (args.dateCreated ?? new Date().toISOString()).slice(0, 10),
          paidAmount: Math.round(args.paidAmount),
          accountReference: (args.accountReference ?? "").trim(),
          transactionId: args.transactionId,
          phoneNumber: args.msisdn,
          fullName: tenant?.full_name ?? "",
          invoiceName: newestOpen !== undefined ? `Rent ${newestOpen.month}` : "",
          externalReference:
            newestOpen !== undefined ? String(newestOpen._id) : "",
        },
      };
    },
});
