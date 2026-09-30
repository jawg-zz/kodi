import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * Nightly cron workers. Cron handlers are mutations (no fetch allowed),
 * so each worker only SELECTS eligible orgs; the actual Daraja calls run
 * from the dashboard-invoked actions (pullC2bWindow / queryAccountBalance)
 * or a future scheduler action. This keeps credentials flowing through the
 * same audited action path instead of a headless mutation.
 *
 * Eligibility: Daraja creds saved + initiator set (+ pull registered for
 * the pull worker). The UI "Run nightly reconciliation" buttons call the
 * same selectors and then fire the actions.
 */

export const pullDueOrgs = internalMutation({
  args: {},
  returns: v.array(v.id("orgs")),
  handler: async (ctx) => {
    const rows = await ctx.db.query("mpesaCredentials").collect();
    const dayAgo = Date.now() - 24 * 3600_000;
    return rows
      .filter(
        (r) =>
          r.pullRegistered === true &&
          r.initiatorName !== undefined &&
          (r.lastPullAt ?? 0) < dayAgo,
      )
      .map((r) => r.orgId);
  },
});

export const balanceDueOrgs = internalMutation({
  args: {},
  returns: v.array(v.id("orgs")),
  handler: async (ctx) => {
    const rows = await ctx.db.query("mpesaCredentials").collect();
    const dayAgo = Date.now() - 24 * 3600_000;
    return rows
      .filter(
        (r) =>
          r.initiatorName !== undefined &&
          (r.lastBalanceAt ?? 0) < dayAgo,
      )
      .map((r) => r.orgId);
  },
});
