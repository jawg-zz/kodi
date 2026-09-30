import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import { assertOrgMember, assertStaff, audit } from "./lib/auth";

/**
 * darajaJobs row lifecycle for outbound async Daraja calls (Transaction
 * Status, Balance, Reversal, B2C/B2B, Tax, Pull). One row per
 * OriginatorConversationID: accepted ≠ completed — the /async-result/*
 * callback flips the row to done/failed.
 */

const jobKind = v.union(
  v.literal("txn_status"),
  v.literal("balance"),
  v.literal("reversal"),
  v.literal("b2c"),
  v.literal("topup"),
  v.literal("b2b"),
  v.literal("tax"),
  v.literal("pull"),
);

const jobStatus = v.union(
  v.literal("pending"),
  v.literal("done"),
  v.literal("failed"),
);

const jobShape = v.object({
  _id: v.id("darajaJobs"),
  _creationTime: v.number(),
  orgId: v.id("orgs"),
  kind: jobKind,
  conversationId: v.string(),
  status: jobStatus,
  requestSummary: v.optional(v.string()),
  resultCode: v.optional(v.string()),
  resultDesc: v.optional(v.string()),
  rawResult: v.optional(v.string()),
  paymentId: v.optional(v.id("payments")),
  tenantId: v.optional(v.id("tenants")),
  amount: v.optional(v.number()),
});

export const openJob = internalMutation({
  args: {
    orgId: v.id("orgs"),
    kind: jobKind,
    conversationId: v.string(),
    summary: v.optional(v.string()),
    tenantId: v.optional(v.id("tenants")),
    paymentId: v.optional(v.id("payments")),
    amount: v.optional(v.number()),
  },
  returns: v.id("darajaJobs"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("darajaJobs", {
      orgId: args.orgId,
      kind: args.kind,
      conversationId: args.conversationId,
      status: "pending",
      requestSummary: args.summary?.slice(0, 300),
      tenantId: args.tenantId,
      paymentId: args.paymentId,
      amount: args.amount,
    });
  },
});

export const markJobAccepted = internalMutation({
  args: {
    jobId: v.id("darajaJobs"),
    darajaConversationId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null) return null;
    await ctx.db.patch(args.jobId, {
      resultDesc: `Accepted${args.darajaConversationId ? ` · ${args.darajaConversationId}` : ""} — awaiting Daraja result callback`,
    });
    return null;
  },
});

export const markJobFailed = internalMutation({
  args: { jobId: v.id("darajaJobs"), resultDesc: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null) return null;
    await ctx.db.patch(args.jobId, {
      status: "failed",
      resultDesc: args.resultDesc?.slice(0, 500),
    });
    return null;
  },
});

/**
 * Resolve a job from a Daraja Result/Timeout callback: match by our
 * OriginatorConversationID first, then Daraja's ConversationID echo.
 * Applies kind-specific side effects (reversal voids, B2C marks
 * settlements) via the callback dispatch in http.ts — this function only
 * flips the row and returns it for dispatch.
 */
export const resolveJobByConversation = internalMutation({
  args: {
    originatorConversationId: v.optional(v.string()),
    conversationId: v.optional(v.string()),
    resultCode: v.string(),
    resultDesc: v.optional(v.string()),
    rawResult: v.optional(v.string()),
  },
  returns: v.union(jobShape, v.null()),
  handler: async (ctx, args) => {
    const ids = [args.originatorConversationId, args.conversationId].filter(
      (s): s is string => typeof s === "string" && s !== "",
    );
    let job = null;
    for (const id of ids) {
      job = await ctx.db
        .query("darajaJobs")
        .withIndex("by_conversation", (q) => q.eq("conversationId", id))
        .first();
      if (job !== null) break;
    }
    if (job === null) return null;
    if (job.status !== "pending") return job;
    const ok = args.resultCode === "0";
    await ctx.db.patch(job._id, {
      status: ok ? "done" : "failed",
      resultCode: args.resultCode.slice(0, 32),
      resultDesc: args.resultDesc?.slice(0, 500),
      rawResult: args.rawResult?.slice(0, 2000),
    });
    return await ctx.db.get(job._id);
  },
});

/** Staff: outbound job history for the payouts/verification UI. */
export const listDarajaJobs = query({
  args: {
    orgId: v.id("orgs"),
    kind: v.optional(jobKind),
    limit: v.optional(v.number()),
  },
  returns: v.array(jobShape),
  handler: async (ctx, args) => {
    const caller = await assertOrgMember(ctx, args.orgId);
    if (caller.role === "tenant") throw new ConvexError("Staff only");
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const q =
      args.kind === undefined
        ? ctx.db
            .query("darajaJobs")
            .withIndex("by_org", (qq) => qq.eq("orgId", args.orgId))
        : ctx.db
            .query("darajaJobs")
            .withIndex("by_org_kind", (qq) =>
              qq.eq("orgId", args.orgId).eq("kind", args.kind as never),
            );
    return await q.order("desc").take(limit);
  },
});

/** Staff: acknowledge a failed job's alert trail (audit only). */
export const noteJob = mutation({
  args: { jobId: v.id("darajaJobs"), note: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null) throw new ConvexError("Job not found");
    const caller = await assertStaff(ctx, job.orgId);
    await audit(ctx, {
      orgId: job.orgId,
      actorUserId: caller.userId,
      action: `daraja_job.note.${job.kind}`,
      entityType: "darajaJobs",
      entityId: String(job._id),
      metadata: args.note.slice(0, 300),
    });
    return null;
  },
});

export { jobKind, jobShape, jobStatus };
