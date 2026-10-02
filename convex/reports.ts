import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { assertOrgMember, assertStaff, isMonthKey } from "./lib/auth";

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

/**
 * Single-org cash snapshot for one month: invoice totals plus actual cash
 * received in the month (paidAt window, active rows only). The dashboard
 * uses this instead of expected-minus-outstanding so catch-up payments,
 * voids and refunds can't make the two pages disagree.
 */
export const monthCashSnapshot = query({
  args: { orgId: v.id("orgs"), month: v.string() },
  returns: v.object({
    month: v.string(),
    expected: v.number(),
    collected: v.number(),
    outstanding: v.number(),
    rate: v.number(),
    invoiceCount: v.number(),
  }),
  handler: async (ctx, args) => {
    await assertStaff(ctx, args.orgId);
    if (!isMonthKey(args.month)) throw new ConvexError("Invalid month key");
    const rows = await ctx.db
      .query("invoices")
      .withIndex("by_org_month", (q) =>
        q.eq("orgId", args.orgId).eq("month", args.month),
      )
      .collect();
    const expected = rows.reduce((s, r) => s + r.total, 0);
    const outstanding = rows.reduce((s, r) => s + r.balance, 0);
    const startMs = monthStartMs(args.month);
    const endMs = monthStartMs(addMonthsKey(args.month, 1));
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_org_paidAt", (q) =>
        q.eq("orgId", args.orgId).gte("paidAt", startMs).lt("paidAt", endMs),
      )
      .collect();
    const collected = payments
      .filter((p) => (p.status ?? "active") === "active")
      .reduce((s, p) => s + p.amount, 0);
    return {
      month: args.month,
      expected,
      collected,
      outstanding,
      rate: pct(collected, expected),
      invoiceCount: rows.length,
    };
  },
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
      // Voided/refunded rows stay for the audit trail but are not cash.
      if ((p.status ?? "active") !== "active") continue;
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
  accountCode: v.string(),
  propertyId: v.optional(v.id("properties")),
  propertyName: v.string(),
  balance: v.number(),
  openCount: v.number(),
  oldestMonth: v.string(),
  oldestDueDate: v.string(),
  bucket: bucketValidator,
  lastPaymentAt: v.optional(v.number()),
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
      accountCode: string;
      propertyId?: Id<"properties">;
      propertyName: string;
      balance: number;
      openCount: number;
      oldestMonth: string;
      oldestDueDate: string;
      bucket: Bucket;
      lastPaymentAt?: number;
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
      // Last payment feeds the follow-up list: "owed since March, last
      // paid January" changes the conversation vs a silent non-payer.
      const recentPayments = await ctx.db
        .query("payments")
        .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
        .order("desc")
        .take(10);
      const lastActive = recentPayments.find((p) => (p.status ?? "active") === "active");
      rows.push({
        tenantId,
        tenantName: tenant.full_name,
        phone: tenant.phone,
        accountCode: tenant.accountCode,
        propertyId: propId,
        propertyName: property?.name ?? "—",
        balance: agg.balance,
        openCount: agg.openCount,
        oldestMonth: agg.oldestMonth,
        oldestDueDate: agg.oldestDueDate,
        bucket,
        lastPaymentAt: lastActive?.paidAt,
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
  status: v.optional(v.string()),
  allocationSummary: v.optional(v.string()),
});

const METHODS = ["mpesa_stk", "mpesa_manual", "mpesa_c2b", "cash", "bank"] as const;

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
      status?: string;
      allocationSummary?: string;
    }[] = [];
    for (const p of payments) {
      const tenant = tenantById.get(p.tenantId);
      if (args.propertyId !== undefined) {
        const propId = tenant?.unitId !== undefined ? unitProps.get(tenant.unitId) : undefined;
        if (propId === undefined) continue;
      }
      const status = p.status ?? "active";
      // Reversed rows stay visible for the audit trail but out of totals.
      if (status === "active") {
        const t = totals.get(p.method)!;
        t.total += p.amount;
        t.count += 1;
      }
      const allocs = (p.allocations ?? []) as {
        amount: number;
        month?: string;
      }[];
      rows.push({
        receiptNo: p.receiptNo,
        paidAt: p.paidAt,
        tenantName: tenant?.full_name ?? "—",
        method: p.method,
        mpesaCode: p.mpesaCode,
        amount: p.amount,
        note: p.note,
        status,
        allocationSummary:
          allocs.length === 0
            ? "credit"
            : allocs
                .map((a) => `${a.month ?? "?"}:${a.amount}`)
                .join(" + "),
      });
    }
    rows.sort((a, b) => b.paidAt - a.paidAt);
    const truncated = rows.length > EXPORT_ROW_CAP;
    const activeRows = rows.filter((r) => (r.status ?? "active") === "active");
    return {
      byMethod: METHODS.map((method) => ({ method, ...totals.get(method)! })),
      total: activeRows.reduce((s, r) => s + r.amount, 0),
      count: activeRows.length,
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
    channels: v.array(
      v.object({ channel: v.string(), count: v.number(), amount: v.number() }),
    ),
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
      const cur = totals.get(`stk:${tx.status}`) ?? { count: 0, amount: 0 };
      cur.count += 1;
      cur.amount += tx.amount;
      totals.set(`stk:${tx.status}`, cur);
    }
    // C2B (Paybill) channel alongside STK: queued + matched + rejected.
    const c2b = await ctx.db
      .query("c2bPayments")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    for (const hit of c2b) {
      const created = hit._creationTime;
      if (created < args.startMs || created >= args.endMs) continue;
      const key = `c2b:${hit.status}`;
      const cur = totals.get(key) ?? { count: 0, amount: 0 };
      cur.count += 1;
      cur.amount += hit.transAmount;
      totals.set(key, cur);
    }
    const byStatus = [...totals.entries()].map(([status, t]) => ({ status, ...t }));
    const total = byStatus.reduce((s, r) => s + r.count, 0);
    const success =
      (totals.get("stk:success")?.count ?? 0) +
      (totals.get("c2b:matched")?.count ?? 0);
    const channels = [
      {
        channel: "STK Push",
        count: [...totals.entries()]
          .filter(([k]) => k.startsWith("stk:"))
          .reduce((s, [, t]) => s + t.count, 0),
        amount: [...totals.entries()]
          .filter(([k]) => k.startsWith("stk:"))
          .reduce((s, [, t]) => s + t.amount, 0),
      },
      {
        channel: "Paybill (C2B)",
        count: [...totals.entries()]
          .filter(([k]) => k.startsWith("c2b:"))
          .reduce((s, [, t]) => s + t.count, 0),
        amount: [...totals.entries()]
          .filter(([k]) => k.startsWith("c2b:"))
          .reduce((s, [, t]) => s + t.amount, 0),
      },
    ];
    return {
      byStatus,
      total,
      totalAmount: byStatus.reduce((s, r) => s + r.amount, 0),
      successRate: pct(success, total),
      channels,
    };
  },
});

// ---------------------------------------------------------------------------
// Daily close: cash received per day + who recorded it (finance sign-off)
// ---------------------------------------------------------------------------
const dailyCloseRow = v.object({
  day: v.string(),
  collected: v.number(),
  count: v.number(),
  byMethod: v.array(
    v.object({ method: v.string(), total: v.number(), count: v.number() }),
  ),
  byRecorder: v.array(
    v.object({ recorder: v.string(), total: v.number(), count: v.number() }),
  ),
});

function dayKeyFromMs(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export const dailyClose = query({
  args: { orgId: v.id("orgs"), startMs: v.number(), endMs: v.number() },
  returns: v.object({ rows: v.array(dailyCloseRow), total: v.number(), count: v.number() }),
  handler: async (ctx, args) => {
    await assertStaff(ctx, args.orgId);
    if (!(args.startMs < args.endMs)) throw new ConvexError("Invalid date window");
    if (args.endMs - args.startMs > 62 * 86_400_000) {
      throw new ConvexError("Keep the close window under 62 days");
    }
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_org_paidAt", (q) =>
        q.eq("orgId", args.orgId).gte("paidAt", args.startMs).lt("paidAt", args.endMs),
      )
      .collect();
    const byDay = new Map<
      string,
      {
        collected: number;
        count: number;
        methods: Map<string, { total: number; count: number }>;
        recorders: Map<string, { total: number; count: number }>;
      }
    >();
    for (const p of payments) {
      if ((p.status ?? "active") !== "active") continue;
      const day = dayKeyFromMs(p.paidAt);
      let agg = byDay.get(day);
      if (agg === undefined) {
        agg = { collected: 0, count: 0, methods: new Map(), recorders: new Map() };
        byDay.set(day, agg);
      }
      agg.collected += p.amount;
      agg.count += 1;
      const m = agg.methods.get(p.method) ?? { total: 0, count: 0 };
      m.total += p.amount;
      m.count += 1;
      agg.methods.set(p.method, m);
      const who =
        p.method === "mpesa_stk" || p.method === "mpesa_c2b"
          ? "M-Pesa auto"
          : (p.recordedBy ?? "unknown");
      const r = agg.recorders.get(who) ?? { total: 0, count: 0 };
      r.total += p.amount;
      r.count += 1;
      agg.recorders.set(who, r);
    }
    const rows = [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([day, agg]) => ({
        day,
        collected: agg.collected,
        count: agg.count,
        byMethod: [...agg.methods.entries()].map(([method, t]) => ({ method, ...t })),
        byRecorder: [...agg.recorders.entries()].map(([recorder, t]) => ({ recorder, ...t })),
      }));
    return {
      rows: rows as never,
      total: rows.reduce((s, r) => s + r.collected, 0),
      count: rows.reduce((s, r) => s + r.count, 0),
    };
  },
});

// ---------------------------------------------------------------------------
// Audit trail: every ledger-touching event, newest first (staff)
// ---------------------------------------------------------------------------
const auditRow = v.object({
  _id: v.id("auditLog"),
  _creationTime: v.number(),
  actorUserId: v.optional(v.string()),
  action: v.string(),
  entityType: v.string(),
  entityId: v.optional(v.string()),
  metadata: v.optional(v.string()),
});

export const auditTrail = query({
  args: {
    orgId: v.id("orgs"),
    action: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.array(auditRow),
  handler: async (ctx, args) => {
    const caller = await assertOrgMember(ctx, args.orgId);
    if (caller.role === "tenant") throw new ConvexError("Staff only");
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
    let rows = await ctx.db
      .query("auditLog")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(limit * 2);
    if (args.action !== undefined) {
      rows = rows.filter((r) => r.action === args.action);
    }
    return rows.slice(0, limit).map((r) => ({
      _id: r._id,
      _creationTime: r._creationTime,
      actorUserId: r.actorUserId,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      metadata: r.metadata,
    })) as never;
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

// ---------------------------------------------------------------------------
// Property performance: how each building collects over the window
// ---------------------------------------------------------------------------
const propertyCollectionRow = v.object({
  propertyId: v.optional(v.id("properties")),
  propertyName: v.string(),
  units: v.number(),
  occupied: v.number(),
  expected: v.number(),
  collected: v.number(),
  outstanding: v.number(),
  rate: v.number(),
  invoiceCount: v.number(),
});

/**
 * Per-property collection for the month window, cash basis like
 * collectionSummary. Answers "which building pays and which doesn't" —
 * the comparison a multi-property owner actually makes. Invoices whose
 * unit is unknown (or absent) roll into an "Unassigned" row so totals
 * always reconcile with the org-wide summary.
 */
export const propertyCollection = query({
  args: {
    orgId: v.id("orgs"),
    startMonth: v.string(),
    endMonth: v.string(),
  },
  returns: v.object({ rows: v.array(propertyCollectionRow) }),
  handler: async (ctx, args) => {
    await assertStaff(ctx, args.orgId);
    const months = expandMonths(args.startMonth, args.endMonth);

    const properties = await ctx.db
      .query("properties")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const units = await ctx.db
      .query("units")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const unitProps = new Map<Id<"units">, Id<"properties">>();
    const perProperty = new Map<
      Id<"properties"> | "unassigned",
      { units: number; occupied: number; expected: number; collected: number; outstanding: number; invoiceCount: number }
    >();
    const blank = () => ({ units: 0, occupied: 0, expected: 0, collected: 0, outstanding: 0, invoiceCount: 0 });
    for (const p of properties) perProperty.set(p._id, blank());
    perProperty.set("unassigned", blank());
    for (const u of units) {
      const agg = perProperty.get(u.propertyId);
      if (agg === undefined) continue;
      agg.units += 1;
      if (u.status === "occupied") agg.occupied += 1;
      unitProps.set(u._id, u.propertyId);
    }

    for (const m of months) {
      const rows = await ctx.db
        .query("invoices")
        .withIndex("by_org_month", (q) => q.eq("orgId", args.orgId).eq("month", m))
        .collect();
      for (const inv of rows) {
        const key =
          (inv.unitId !== undefined ? unitProps.get(inv.unitId) : undefined) ?? "unassigned";
        const agg = perProperty.get(key);
        if (agg === undefined) continue;
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
      if ((p.status ?? "active") !== "active") continue;
      const unitId = tenantUnit.get(p.tenantId);
      const key = (unitId !== undefined ? unitProps.get(unitId) : undefined) ?? "unassigned";
      const agg = perProperty.get(key);
      if (agg !== undefined) agg.collected += p.amount;
    }

    const nameOf = new Map(properties.map((p) => [p._id, p.name]));
    const rows = [...perProperty.entries()]
      .map(([key, agg]) => ({
        propertyId: key === "unassigned" ? undefined : (key as Id<"properties">),
        propertyName: key === "unassigned" ? "Unassigned" : (nameOf.get(key as Id<"properties">) ?? "—"),
        units: agg.units,
        occupied: agg.occupied,
        expected: agg.expected,
        collected: agg.collected,
        outstanding: agg.outstanding,
        rate: pct(agg.collected, agg.expected),
        invoiceCount: agg.invoiceCount,
      }))
      .filter((r) => r.units > 0 || r.invoiceCount > 0);
    rows.sort((a, b) => b.collected - a.collected);
    return { rows: rows as never };
  },
});

// ---------------------------------------------------------------------------
// Payment timeliness: who pays on time, who pays late, by how much
// ---------------------------------------------------------------------------
const timelinessRow = v.object({
  tenantId: v.id("tenants"),
  tenantName: v.string(),
  paidCount: v.number(),
  onTimeCount: v.number(),
  lateCount: v.number(),
  avgDaysLate: v.number(),
  worstDaysLate: v.number(),
});

/**
 * On-time behaviour per tenant over the window. An invoice counts once
 * it has any active payment allocated to it; lateness is measured from
 * the FIRST payment that touched the invoice (a partial on the 3rd and
 * the balance a month later is still one on-time start). Same-day or
 * earlier is on time. Powers keep/chase decisions, not scoring theater.
 */
export const paymentTimeliness = query({
  args: {
    orgId: v.id("orgs"),
    startMonth: v.string(),
    endMonth: v.string(),
    propertyId: propertyIdArg,
  },
  returns: v.object({
    paidInvoices: v.number(),
    onTimeRate: v.number(),
    avgDaysLate: v.number(),
    rows: v.array(timelinessRow),
  }),
  handler: async (ctx, args) => {
    await assertStaff(ctx, args.orgId);
    await assertPropertyInOrg(ctx, args.orgId, args.propertyId);
    const months = expandMonths(args.startMonth, args.endMonth);
    const unitProps = await unitPropertyMap(ctx, args.orgId, args.propertyId);
    const inScope = (unitId?: Id<"units">): boolean => {
      if (args.propertyId === undefined) return true;
      return unitId !== undefined && unitProps.has(unitId);
    };

    const invoices = [];
    for (const m of months) {
      const rows = await ctx.db
        .query("invoices")
        .withIndex("by_org_month", (q) => q.eq("orgId", args.orgId).eq("month", m))
        .collect();
      for (const inv of rows) {
        if (!inScope(inv.unitId)) continue;
        invoices.push(inv);
      }
    }
    const invoiceById = new Map(invoices.map((i) => [i._id, i]));

    const firstPaidAt = new Map<Id<"invoices">, number>();
    if (invoices.length > 0) {
      const startMs = monthStartMs(months[0]);
      const payments = await ctx.db
        .query("payments")
        .withIndex("by_org_paidAt", (q) =>
          q.eq("orgId", args.orgId).gte("paidAt", startMs),
        )
        .collect();
      for (const p of payments) {
        if ((p.status ?? "active") !== "active") continue;
        for (const a of p.allocations) {
          if (!invoiceById.has(a.invoiceId)) continue;
          const cur = firstPaidAt.get(a.invoiceId);
          if (cur === undefined || p.paidAt < cur) firstPaidAt.set(a.invoiceId, p.paidAt);
        }
      }
    }

    const tenants = await ctx.db
      .query("tenants")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const tenantById = new Map(tenants.map((t) => [t._id, t]));

    type Agg = { paid: number; onTime: number; lateSum: number; worst: number };
    const byTenant = new Map<Id<"tenants">, Agg>();
    let totalLateDays = 0;
    let lateInvoices = 0;
    for (const [invoiceId, paidAt] of firstPaidAt) {
      const inv = invoiceById.get(invoiceId);
      if (inv === undefined) continue;
      const due = Date.parse(`${inv.dueDate}T23:59:59Z`);
      const daysLate = Number.isNaN(due)
        ? 0
        : Math.max(0, Math.floor((paidAt - due) / DAY_MS));
      const agg = byTenant.get(inv.tenantId) ?? { paid: 0, onTime: 0, lateSum: 0, worst: 0 };
      agg.paid += 1;
      if (daysLate === 0) {
        agg.onTime += 1;
      } else {
        agg.lateSum += daysLate;
        agg.worst = Math.max(agg.worst, daysLate);
        totalLateDays += daysLate;
        lateInvoices += 1;
      }
      byTenant.set(inv.tenantId, agg);
    }

    const rows = [...byTenant.entries()]
      .filter(([id]) => tenantById.has(id))
      .map(([id, agg]) => ({
        tenantId: id,
        tenantName: tenantById.get(id)?.full_name ?? "—",
        paidCount: agg.paid,
        onTimeCount: agg.onTime,
        lateCount: agg.paid - agg.onTime,
        avgDaysLate: agg.lateSum > 0 ? Math.round((agg.lateSum / (agg.paid - agg.onTime)) * 10) / 10 : 0,
        worstDaysLate: agg.worst,
      }))
      .sort((a, b) => b.worstDaysLate - a.worstDaysLate || b.lateCount - a.lateCount);
    const paidInvoices = firstPaidAt.size;
    const onTime = paidInvoices - lateInvoices;
    return {
      paidInvoices,
      onTimeRate: pct(onTime, paidInvoices),
      avgDaysLate: lateInvoices > 0 ? Math.round((totalLateDays / lateInvoices) * 10) / 10 : 0,
      rows: rows as never,
    };
  },
});
