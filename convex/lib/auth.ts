import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

export type StaffRole = "owner" | "manager";

export interface Caller {
  userId: string;
  orgId: Id<"orgs">;
  role: StaffRole;
  tenantId: null;
}

export interface TenantCaller {
  userId: string;
  orgId: Id<"orgs">;
  role: "tenant";
  tenantId: Id<"tenants">;
}

export type AnyCaller = Caller | TenantCaller;

async function subject(ctx: QueryCtx | MutationCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw new ConvexError("Not authenticated");
  return identity.subject;
}

/**
 * Resolve the caller to staff membership or tenant linkage.
 * Throws ConvexError when the user belongs to no org.
 */
export async function getCaller(ctx: QueryCtx | MutationCtx): Promise<AnyCaller> {
  const userId = await subject(ctx);
  const membership = await ctx.db
    .query("orgMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (membership !== null) {
    return {
      userId,
      orgId: membership.orgId,
      role: membership.role,
      tenantId: null,
    };
  }
  const link = await ctx.db
    .query("tenantUsers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (link !== null) {
    const tenant = await ctx.db.get(link.tenantId);
    if (tenant !== null) {
      return { userId, orgId: tenant.orgId, role: "tenant", tenantId: tenant._id };
    }
  }
  throw new ConvexError("Account is not linked to any organization");
}

/** Staff-only; optionally pins to one org. Returns the staff caller. */
export async function assertStaff(
  ctx: QueryCtx | MutationCtx,
  orgId?: Id<"orgs">,
): Promise<Caller> {
  const caller = await getCaller(ctx);
  if (caller.role === "tenant") throw new ConvexError("Staff only");
  if (orgId !== undefined && caller.orgId !== orgId) {
    throw new ConvexError("Not a member of this organization");
  }
  return caller;
}

export async function assertOwner(
  ctx: QueryCtx | MutationCtx,
  orgId?: Id<"orgs">,
): Promise<Caller> {
  const caller = await assertStaff(ctx, orgId);
  if (caller.role !== "owner") {
    throw new ConvexError("Only the business owner can do this");
  }
  return caller;
}

export async function assertOrgMember(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"orgs">,
): Promise<AnyCaller> {
  const caller = await getCaller(ctx);
  if (caller.orgId !== orgId) {
    throw new ConvexError("Not a member of this organization");
  }
  return caller;
}

/** Kenyan mobile numbers → 254 canonical (port of Supabase _shared/mod.ts). */
export function normalizePhone(input: string): string | null {
  if (!input) return null;
  let digits = input.replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("0")) {
    digits = "254" + digits.slice(1);
  } else if (
    digits.length === 9 &&
    (digits.startsWith("7") || digits.startsWith("1"))
  ) {
    digits = "254" + digits;
  }
  if (digits.length !== 12 || !digits.startsWith("254")) return null;
  const local = digits.slice(3);
  if (!local.startsWith("7") && !local.startsWith("1")) return null;
  return digits;
}

export function isMonthKey(key: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) return false;
  return !Number.isNaN(Date.parse(`${key}-01T00:00:00Z`));
}

/** Due date "YYYY-MM-DD" from month + due day, clamped to month end. */
export function dueDateFor(month: string, dueDay: number): string {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const day = Math.min(Math.max(1, Math.floor(dueDay)), lastDay);
  return `${month}-${String(day).padStart(2, "0")}`;
}

/** Daraja timestamp: YYYYMMDDHHMMSS in Africa/Nairobi (UTC+3, no DST). */
export function darajaTimestamp(d = new Date()): string {
  const eat = new Date(d.getTime() + 3 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${eat.getUTCFullYear()}${p(eat.getUTCMonth() + 1)}${p(eat.getUTCDate())}` +
    `${p(eat.getUTCHours())}${p(eat.getUTCMinutes())}${p(eat.getUTCSeconds())}`
  );
}

export function stkPassword(
  shortcode: string,
  passkey: string,
  timestamp: string,
): string {
  // btoa (not Buffer): this module loads in the V8 isolate too.
  // Inputs are Daraja ASCII (digits + timestamp), so btoa is safe.
  return btoa(`${shortcode}${passkey}${timestamp}`);
}

export function audit(
  ctx: MutationCtx,
  args: {
    orgId: Id<"orgs">;
    actorUserId?: string;
    action: string;
    entityType: string;
    entityId?: string;
    metadata?: string;
  },
): Promise<Id<"auditLog">> {
  return ctx.db.insert("auditLog", {
    orgId: args.orgId,
    actorUserId: args.actorUserId,
    action: args.action,
    entityType: args.entityType,
    entityId: args.entityId,
    metadata: args.metadata,
  });
}
