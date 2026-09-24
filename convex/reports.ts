import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { assertStaff, isMonthKey } from "./lib/auth";

const DAY_MS = 86_400_000;
const MAX_MONTHS = 37;
const EXPORT_ROW_CAP = 5000;

const propertyIdArg = v.optional(v.id("properties"));

function monthKeyFromMs(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthStartMs(key: string): number {
  return Date.parse(`${key}-01T00:00:00Z`);
}

function addMonthsKey(key: string, n: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function expandMonths(start: string, end: string): string[] {
  if (!isMonthKey(start) || !isMonthKey(end) || start > end) {
    throw new ConvexError("Invalid month range");
  }
  const out: string[] = [];
  let cur = start;
  while (cur <= end && out.length < MAX_MONTHS) {
    out.push(cur);
    if (cur === end) break;
    cur = addMonthsKey(cur, 1);
  }
  return out;
}

function daysPastDue(dueDate: string, nowMs: number): number {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(due)) return 0;
  return Math.floor((nowMs - due) / DAY_MS);
}

type Bucket = "Current" | "30+" | "60+" | "90+";

function bucketFor(days: number): Bucket {
  if (days >= 90) return "90+";
  if (days >= 60) return "60+";
  if (days >= 30) return "30+";
  return "Current";
}

const bucketValidator = v.union(
  v.literal("Current"),
  v.literal("30+"),
  v.literal("60+"),
  v.literal("90+"),
);

function pct(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

/** Unit -> property lookup, optionally restricted to one property. */
async function unitPropertyMap(
  ctx: QueryCtx,
  orgId: Id<"orgs">,
  propertyId?: Id<"properties">,
): Promise<Map<Id<"units">, Id<"properties">>> {
  const map = new Map<Id<"units">, Id<"properties">>();
  const units =
    propertyId === undefined
      ? await ctx.db
          .query("units")
          .withIndex("by_org", (q) => q.eq("orgId", orgId))
          .collect()
      : await ctx.db
          .query("units")
          .withIndex("by_property", (q) => q.eq("propertyId", propertyId))
          .collect();
  for (const u of units) {
    if (u.orgId !== orgId) continue;
    map.set(u._id, u.propertyId);
  }
  return map;
}

async function assertPropertyInOrg(
  ctx: QueryCtx,
  orgId: Id<"orgs">,
  propertyId?: Id<"properties">,
): Promise<void> {
  if (propertyId === undefined) return;
  const p = await ctx.db.get(propertyId);
  if (p === null || p.orgId !== orgId) throw new ConvexError("Property not found");
}

// ---------------------------------------------------------------------------
// Collection summary: expected + true cash collected per month
// ---------------------------------------------------------------------------
const collectionMonth = v.object({
  month: v.string(),
  expected: v.number(),
  collected: v.number(),
  outstanding: v.number(),
  rate: v.number(),
  invoiceCount: v.number(),
});

export const collectionSummary = query({
  args: {
    orgId: v.id("orgs"),
    startMonth: v.string(),
    endMonth: v.string(),
    propertyId: propertyIdArg,
  },
  returns: v.array(collectionMonth),
  handler: async (ctx, args) => {
    await assertStaff(ctx, args.orgId);
    await assertPropertyInOrg(ctx, args.orgId, args.propertyId);
    const months = expandMonths(args.startMonth, args.endMonth);
    const unitProps = await unitPropertyMap(ctx, args.orgId, args.propertyId);
    const inScope = (unitId?: Id<"units">): boolean => {
      if (args.propertyId === undefined) return true;
      return unitId !== undefined && unitProps.has(unitId);
    };

    const perMonth = new Map(
      months.map((m) => [
        m,
        { month: m, expected: 0, collected: 0, outstanding: 0, rate: 0, invoiceCount: 0 },
      ]),
    );
    for (const m of months) {
      const rows = await ctx.db
        .query("invoices")
        .withIndex("by_org_month", (q) => q.eq("orgId", args.orgId).eq("month", m))
        .collect();
      const agg = perMonth.get(m)!;
      for (const inv of rows) {
        if (!inScope(inv.unitId)) continue;
        agg.expected += inv.total;
        agg.outstanding += inv.balance;
        agg.invoiceCount += 1;
      }
    }

    const tenants = await ctx.db
      .query("tenants")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const tenantUnit = new Map(tenants.map((t) => [t._id, t.unitId]));
    const startMs = monthStartMs(months[0]);
    const endMs = monthStartMs(addMonthsKey(months[months.length - 1], 1));
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_org_paidAt", (q) =>
        q.eq("orgId", args.orgId).gte("paidAt", startMs).lt("paidAt", endMs),
      )
      .collect();
    for (const p of payments) {
      if (!inScope(tenantUnit.get(p.tenantId))) continue;
      const agg = perMonth.get(monthKeyFromMs(p.paidAt));
      if (agg !== undefined) agg.collected += p.amount;
    }

    return months.map((m) => {
      const agg = perMonth.get(m)!;
      return { ...agg, rate: pct(agg.collected, agg.expected) };
    });
  },
});

// ---------------------------------------------------------------------------
// Arrears aging per tenant with 30/60/90+ buckets
// ---------------------------------------------------------------------------
const arrearsRow = v.object({
  tenantId: v.id("tenants"),
  tenantName: v.string(),
  phone: v.string(),
  propertyId: v.optional(v.id("properties")),
  propertyName: v.string(),
  balance: v.number(),
  openCount: v.number(),
  oldestMonth: v.string(),
  oldestDueDate: v.string(),
  bucket: bucketValidator,
});

const bucketTotal = v.object({
  bucket: bucketValidator,
  balance: v.number(),
  count: v.number(),
});

export const arrearsAging = query({
  args: { orgId: v.id("orgs"), propertyId: propertyIdArg },
  returns: v.object({
    rows: v.array(arrearsRow),
    buckets: v.array(bucketTotal),
    totalBalance: v.number(),
    tenantsInArrears: v.number(),
  }),
  handler: async (ctx, args) => {
    await assertStaff(ctx, args.orgId);
    await assertPropertyInOrg(ctx, args.orgId, args.propertyId);
    const unitProps = await unitPropertyMap(ctx, args.orgId, args.propertyId);

    const tenants = await ctx.db
      .query("tenants")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const tenantById = new Map(tenants.map((t) => [t._id, t]));
    const properties = await ctx.db
      .query("properties")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const propertyById = new Map(properties.map((p) => [p._id, p]));

    const open: { tenantId: Id<"tenants">; month: string; dueDate: string; balance: number }[] = [];
    for (const status of ["unpaid", "partial"] as const) {
      const rows = await ctx.db
        .query("invoices")
        .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", status))
        .collect();
      for (const inv of rows) {
        if (inv.balance <= 0) continue;
        open.push({ tenantId: inv.tenantId, month: inv.month, dueDate: inv.dueDate, balance: inv.balance });
      }
    }

    const nowMs = Date.now();
    const byTenant = new Map<
      Id<"tenants">,
      { balance: number; openCount: number; oldestMonth: string; oldestDueDate: string }
    >();
    for (const inv of open) {
      const cur = byTenant.get(inv.tenantId);
      if (cur === undefined) {
        byTenant.set(inv.tenantId, {
          balance: inv.balance,
          openCount: 1,
          oldestMonth: inv.month,
          oldestDueDate: inv.dueDate,
        });
      } else {
        cur.balance += inv.balance;
        cur.openCount += 1;
        if (inv.month < cur.oldestMonth) cur.oldestMonth = inv.month;
        if (inv.dueDate < cur.oldestDueDate) cur.oldestDueDate = inv.dueDate;
      }
    }

    const rows: {
      tenantId: Id<"tenants">;
      tenantName: string;
      phone: string;
      propertyId?: Id<"properties">;
      propertyName: string;
      balance: number;
      openCount: number;
      oldestMonth: string;
      oldestDueDate: string;
      bucket: Bucket;
    }[] = [];
    const bucketSums = new Map<Bucket, { balance: number; count: number }>([
      ["Current", { balance: 0, count: 0 }],
      ["30+", { balance: 0, count: 0 }],
      ["60+", { balance: 0, count: 0 }],
      ["90+", { balance: 0, count: 0 }],
    ]);
    for (const [tenantId, agg] of byTenant) {
      const tenant = tenantById.get(tenantId);
      if (tenant === undefined) continue;
      const propId = tenant.unitId !== undefined ? unitProps.get(tenant.unitId) : undefined;
      if (args.propertyId !== undefined && propId === undefined) continue;
      const property = propId !== undefined ? propertyById.get(propId) : undefined;
      const bucket = bucketFor(daysPastDue(agg.oldestDueDate, nowMs));
      const b = bucketSums.get(bucket)!;
      b.balance += agg.balance;
      b.count += 1;
      rows.push({
        tenantId,
        tenantName: tenant.full_name,
        phone: tenant.phone,
        propertyId: propId,
        propertyName: property?.name ?? "—",
        balance: agg.balance,
        openCount: agg.openCount,
        oldestMonth: agg.oldestMonth,
        oldestDueDate: agg.oldestDueDate,
        bucket,
      });
    }
    rows.sort((a, b) => b.balance - a.balance);
    return {
      rows: rows as never,
      buckets: (["Current", "30+", "60+", "90+"] as Bucket[]).map((bucket) => ({
        bucket,
        ...bucketSums.get(bucket)!,
      })),
      totalBalance: rows.reduce((s, r) => s + r.balance, 0),
      tenantsInArrears: rows.length,
    };
  },
});

// ---------------------------------------------------------------------------
// Payments breakdown by method + export rows for the window
// ---------------------------------------------------------------------------
const methodTotal = v.object({
  method: v.string(),
  total: v.number(),
  count: v.number(),
});

const paymentRow = v.object({
  receiptNo: v.string(),
  paidAt: v.number(),
  tenantName: v.string(),
  method: v.string(),
  mpesaCode: v.optional(v.string()),
  amount: v.number(),
  note: v.optional(v.string()),
});

const METHODS = ["mpesa_stk", "mpesa_manual", "cash", "bank"] as const;

export const paymentsBreakdown = query({
  args: {
    orgId: v.id("orgs"),
    startMs: v.number(),
    endMs: v.number(),
    propertyId: propertyIdArg,
  },
  returns: v.object({
    byMethod: v.array(methodTotal),
    total: v.number(),
    count: v.number(),
    rows: v.array(paymentRow),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await assertStaff(ctx, args.orgId);
    await assertPropertyInOrg(ctx, args.orgId, args.propertyId);
    if (!(args.startMs < args.endMs)) throw new ConvexError("Invalid date window");
    const unitProps = await unitPropertyMap(ctx, args.orgId, args.propertyId);
    const tenants = await ctx.db
      .query("tenants")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const tenantById = new Map(tenants.map((t) => [t._id, t]));

    const payments = await ctx.db
      .query("payments")
      .withIndex("by_org_paidAt", (q) =>
        q.eq("orgId", args.orgId).gte("paidAt", args.startMs).lt("paidAt", args.endMs),
      )
      .collect();

    const totals = new Map<string, { total: number; count: number }>(
      METHODS.map((m) => [m, { total: 0, count: 0 }]),
    );
    const rows: {
      receiptNo: string;
      paidAt: number;
      tenantName: string;
      method: string;
      mpesaCode?: string;
      amount: number;
      note?: string;
    }[] = [];
    for (const p of payments) {
      const tenant = tenantById.get(p.tenantId);
      if (args.propertyId !== undefined) {
        const propId = tenant?.unitId !== undefined ? unitProps.get(tenant.unitId) : undefined;
        if (propId === undefined) continue;
      }
      const t = totals.get(p.method)!;
      t.total += p.amount;
      t.count += 1;
      rows.push({
        receiptNo: p.receiptNo,
        paidAt: p.paidAt,
        tenantName: tenant?.full_name ?? "—",
        method: p.method,
        mpesaCode: p.mpesaCode,
        amount: p.amount,
        note: p.note,
      });
    }
    rows.sort((a, b) => b.paidAt - a.paidAt);
    const truncated = rows.length > EXPORT_ROW_CAP;
    return {
      byMethod: METHODS.map((method) => ({ method, ...totals.get(method)! })),
      total: rows.reduce((s, r) => s + r.amount, 0),
      count: rows.length,
      rows: rows.slice(0, EXPORT_ROW_CAP) as never,
      truncated,
    };
  },
});

// ---------------------------------------------------------------------------
// M-Pesa transaction health for the window
// ---------------------------------------------------------------------------
const mpesaStatusTotal = v.object({
  status: v.string(),
  count: v.number(),
  amount: v.number(),
});

export const mpesaHealth = query({
  args: { orgId: v.id("orgs"), startMs: v.number(), endMs: v.number() },
  returns: v.object({
    byStatus: v.array(mpesaStatusTotal),
    total: v.number(),
    totalAmount: v.number(),
    successRate: v.number(),
  }),
  handler: async (ctx, args) => {
    await assertStaff(ctx, args.orgId);
    if (!(args.startMs < args.endMs)) throw new ConvexError("Invalid date window");
    const rows = await ctx.db
      .query("mpesaTransactions")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const totals = new Map<string, { count: number; amount: number }>();
    for (const tx of rows) {
      if (tx._creationTime < args.startMs || tx._creationTime >= args.endMs) continue;
      const cur = totals.get(tx.status) ?? { count: 0, amount: 0 };
      cur.count += 1;
      cur.amount += tx.amount;
      totals.set(tx.status, cur);
    }
    const byStatus = [...totals.entries()].map(([status, t]) => ({ status, ...t }));
    const total = byStatus.reduce((s, r) => s + r.count, 0);
    const success = totals.get("success")?.count ?? 0;
    return {
      byStatus,
      total,
      totalAmount: byStatus.reduce((s, r) => s + r.amount, 0),
      successRate: pct(success, total),
    };
  },
});

// ---------------------------------------------------------------------------
// Rent roll & occupancy per property
// ---------------------------------------------------------------------------
const rentRollRow = v.object({
  propertyId: v.id("properties"),
  propertyName: v.string(),
  units: v.number(),
  occupied: v.number(),
  vacant: v.number(),
  notice: v.number(),
  occupancyPct: v.number(),
  monthlyRent: v.number(),
  occupiedRent: v.number(),
});

export const rentRoll = query({
  args: { orgId: v.id("orgs"), propertyId: propertyIdArg },
  returns: v.object({
    rows: v.array(rentRollRow),
    totals: v.object({
      units: v.number(),
      occupied: v.number(),
      vacant: v.number(),
      occupancyPct: v.number(),
      monthlyRent: v.number(),
      occupiedRent: v.number(),
    }),
  }),
  handler: async (ctx, args) => {
    await assertStaff(ctx, args.orgId);
    await assertPropertyInOrg(ctx, args.orgId, args.propertyId);
    const properties =
      args.propertyId === undefined
        ? await ctx.db
            .query("properties")
            .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
            .collect()
        : [await ctx.db.get(args.propertyId)].filter(
            (p): p is NonNullable<typeof p> => p !== null,
          );
    const units =
      args.propertyId === undefined
        ? await ctx.db
            .query("units")
            .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
            .collect()
        : await ctx.db
            .query("units")
            .withIndex("by_property", (q) => q.eq("propertyId", args.propertyId as Id<"properties">))
            .collect();

    const rows = properties.map((p) => {
      const pu = units.filter((u) => u.propertyId === p._id && u.orgId === args.orgId);
      const occupied = pu.filter((u) => u.status === "occupied").length;
      const vacant = pu.filter((u) => u.status === "vacant").length;
      const notice = pu.filter((u) => u.status === "notice").length;
      const rentOf = (u: (typeof pu)[number]) => u.rent_amount + u.water_charge + u.garbage_charge;
      const monthlyRent = pu.reduce((s, u) => s + rentOf(u), 0);
      const occupiedRent = pu
        .filter((u) => u.status !== "vacant")
        .reduce((s, u) => s + rentOf(u), 0);
      return {
        propertyId: p._id,
        propertyName: p.name,
        units: pu.length,
        occupied,
        vacant,
        notice,
        occupancyPct: pct(occupied, pu.length),
        monthlyRent,
        occupiedRent,
      };
    });
    const totals = {
      units: rows.reduce((s, r) => s + r.units, 0),
      occupied: rows.reduce((s, r) => s + r.occupied, 0),
      vacant: rows.reduce((s, r) => s + r.vacant, 0),
      occupancyPct: pct(
        rows.reduce((s, r) => s + r.occupied, 0),
        rows.reduce((s, r) => s + r.units, 0),
      ),
      monthlyRent: rows.reduce((s, r) => s + r.monthlyRent, 0),
      occupiedRent: rows.reduce((s, r) => s + r.occupiedRent, 0),
    };
    return { rows, totals };
  },
});

// ---------------------------------------------------------------------------
// Deposits held / settled + tenant credit carryovers
// ---------------------------------------------------------------------------
export const depositsAndCredits = query({
  args: { orgId: v.id("orgs"), propertyId: propertyIdArg },
  returns: v.object({
    depositHeldTotal: v.number(),
    tenantsHoldingDeposit: v.number(),
    settledDeductions: v.number(),
    settledRefunds: v.number(),
    settlementsCount: v.number(),
    creditBalanceTotal: v.number(),
    tenantsWithCredit: v.number(),
  }),
  handler: async (ctx, args) => {
    await assertStaff(ctx, args.orgId);
    await assertPropertyInOrg(ctx, args.orgId, args.propertyId);
    const unitProps = await unitPropertyMap(ctx, args.orgId, args.propertyId);
    const tenants = await ctx.db
      .query("tenants")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const inScopeTenant = (tenant: (typeof tenants)[number]): boolean => {
      if (args.propertyId === undefined) return true;
      return tenant.unitId !== undefined && unitProps.has(tenant.unitId);
    };
    const scoped = tenants.filter(inScopeTenant);
    const scopedIds = new Set(scoped.map((t) => t._id));

    const settlements = await ctx.db
      .query("depositSettlements")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const scopedSettlements = settlements.filter((s) => scopedIds.has(s.tenantId));
    const credits = await ctx.db
      .query("tenantCredits")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const scopedCredits = credits.filter((c) => scopedIds.has(c.tenantId) && c.balance > 0);

    return {
      depositHeldTotal: scoped.reduce((s, t) => s + t.deposit_held, 0),
      tenantsHoldingDeposit: scoped.filter((t) => t.deposit_held > 0).length,
      settledDeductions: scopedSettlements.reduce((s, x) => s + x.totalDeductions, 0),
      settledRefunds: scopedSettlements.reduce((s, x) => s + x.refundAmount, 0),
      settlementsCount: scopedSettlements.length,
      creditBalanceTotal: scopedCredits.reduce((s, c) => s + c.balance, 0),
      tenantsWithCredit: scopedCredits.length,
    };
  },
});
