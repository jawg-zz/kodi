import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

/**
 * Kodi on Convex — rent-management SaaS (Kenya).
 *
 * Ported from Supabase Postgres: all money is integer whole KES,
 * month keys are "YYYY-MM", user references are Convex Auth subject
 * strings (not v.id()), enforced at function boundaries in code
 * (no RLS — auth lives in convex/lib/auth.ts).
 */
export default defineSchema({
  ...authTables,

  plans: defineTable({
    code: v.string(),
    name: v.string(),
    max_units: v.number(),
    price_kes: v.number(),
    sort_order: v.number(),
  }).index("by_code", ["code"]),

  orgs: defineTable({
    name: v.string(),
    plan_code: v.string(),
    subscription_status: v.union(
      v.literal("trialing"),
      v.literal("active"),
      v.literal("past_due"),
    ),
    subscription_period_end: v.optional(v.string()),
    invoice_due_day: v.number(),
  }),

  orgMembers: defineTable({
    orgId: v.id("orgs"),
    /** Convex Auth subject (identity.subject), stable per user. */
    userId: v.string(),
    role: v.union(v.literal("owner"), v.literal("manager")),
  })
    .index("by_org", ["orgId"])
    .index("by_user", ["userId"]),

  profiles: defineTable({
    userId: v.string(),
    full_name: v.string(),
    phone: v.optional(v.string()),
  }).index("by_user", ["userId"]),

  properties: defineTable({
    orgId: v.id("orgs"),
    name: v.string(),
    property_type: v.union(
      v.literal("apartments"),
      v.literal("bedsitters"),
      v.literal("single_rooms"),
      v.literal("mixed"),
      v.literal("commercial"),
    ),
    location: v.string(),
    notes: v.optional(v.string()),
  }).index("by_org", ["orgId"]),

  units: defineTable({
    orgId: v.id("orgs"),
    propertyId: v.id("properties"),
    label: v.string(),
    unit_type: v.union(
      v.literal("bedsitter"),
      v.literal("single"),
      v.literal("one_br"),
      v.literal("two_br"),
      v.literal("three_br"),
      v.literal("shop"),
      v.literal("other"),
    ),
    rent_amount: v.number(),
    water_charge: v.number(),
    garbage_charge: v.number(),
    status: v.union(
      v.literal("vacant"),
      v.literal("occupied"),
      v.literal("notice"),
    ),
    currentTenantId: v.optional(v.id("tenants")),
  })
    .index("by_org", ["orgId"])
    .index("by_property", ["propertyId"])
    .index("by_org_status", ["orgId", "status"]),

  tenants: defineTable({
    orgId: v.id("orgs"),
    full_name: v.string(),
    phone: v.string(),
    national_id: v.string(),
    unitId: v.optional(v.id("units")),
    move_in_date: v.optional(v.string()),
    deposit_held: v.number(),
    status: v.union(
      v.literal("active"),
      v.literal("notice"),
      v.literal("moved_out"),
    ),
    notes: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_phone", ["orgId", "phone"])
    .index("by_unit", ["unitId"]),

  tenantUsers: defineTable({
    tenantId: v.id("tenants"),
    userId: v.string(),
  })
    .index("by_user", ["userId"])
    .index("by_tenant", ["tenantId"]),

  invoices: defineTable({
    orgId: v.id("orgs"),
    tenantId: v.id("tenants"),
    unitId: v.optional(v.id("units")),
    /** Month key "YYYY-MM". */
    month: v.string(),
    lines: v.object({
      rent: v.number(),
      water: v.number(),
      garbage: v.number(),
      other: v.number(),
    }),
    total: v.number(),
    /** ISO date "YYYY-MM-DD". */
    dueDate: v.string(),
    status: v.union(
      v.literal("unpaid"),
      v.literal("partial"),
      v.literal("paid"),
    ),
    balance: v.number(),
    notes: v.optional(v.string()),
  })
    .index("by_org_month", ["orgId", "month"])
    .index("by_org", ["orgId"])
    .index("by_tenant_month", ["tenantId", "month"])
    .index("by_org_status", ["orgId", "status"]),

  receiptCounters: defineTable({
    orgId: v.id("orgs"),
    lastNo: v.number(),
  }).index("by_org", ["orgId"]),

  payments: defineTable({
    orgId: v.id("orgs"),
    tenantId: v.id("tenants"),
    amount: v.number(),
    method: v.union(
      v.literal("mpesa_stk"),
      v.literal("mpesa_manual"),
      v.literal("cash"),
      v.literal("bank"),
    ),
    mpesaCode: v.optional(v.string()),
    /** ms epoch. */
    paidAt: v.number(),
    allocations: v.array(
      v.object({ invoiceId: v.id("invoices"), amount: v.number() }),
    ),
    receiptNo: v.string(),
    recordedBy: v.optional(v.string()),
    note: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_tenant", ["tenantId"])
    .index("by_org_code", ["orgId", "mpesaCode"]),

  mpesaTransactions: defineTable({
    orgId: v.id("orgs"),
    tenantId: v.id("tenants"),
    checkoutRequestId: v.string(),
    merchantRequestId: v.optional(v.string()),
    phone: v.string(),
    amount: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("success"),
      v.literal("failed"),
      v.literal("timeout"),
    ),
    resultCode: v.optional(v.number()),
    resultDesc: v.optional(v.string()),
    mpesaReceipt: v.optional(v.string()),
    paymentId: v.optional(v.id("payments")),
    initiatedBy: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  })
    .index("by_checkout", ["checkoutRequestId"])
    .index("by_org", ["orgId"])
    .index("by_tenant", ["tenantId"])
    .index("by_status", ["status"])
    .index("by_org_idem", ["orgId", "idempotencyKey"]),

  /** Daraja secrets — encrypted blobs, never returned to clients. */
  mpesaCredentials: defineTable({
    orgId: v.id("orgs"),
    environment: v.union(
      v.literal("sandbox"),
      v.literal("production"),
    ),
    consumerKeyEnc: v.string(),
    consumerSecretEnc: v.string(),
    shortcode: v.string(),
    passkeyEnc: v.string(),
  }).index("by_org", ["orgId"]),

  depositSettlements: defineTable({
    orgId: v.id("orgs"),
    tenantId: v.id("tenants"),
    depositHeld: v.number(),
    deductions: v.array(
      v.object({ label: v.string(), amount: v.number() }),
    ),
    totalDeductions: v.number(),
    refundAmount: v.number(),
    notes: v.optional(v.string()),
    settledBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_tenant", ["tenantId"]),

  tenantCredits: defineTable({
    orgId: v.id("orgs"),
    tenantId: v.id("tenants"),
    balance: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_tenant", ["tenantId"]),

  auditLog: defineTable({
    orgId: v.id("orgs"),
    actorUserId: v.optional(v.string()),
    action: v.string(),
    entityType: v.string(),
    entityId: v.optional(v.string()),
    metadata: v.optional(v.string()),
  }).index("by_org", ["orgId"]),

  /** Invite-link flow (replaces Supabase admin-create-user + temp passwords). */
  invites: defineTable({
    orgId: v.id("orgs"),
    email: v.string(),
    fullName: v.string(),
    phone: v.string(),
    kind: v.union(v.literal("tenant"), v.literal("manager")),
    tenantId: v.optional(v.id("tenants")),
    token: v.string(),
    expiresAt: v.number(),
    claimedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_token", ["token"]),
});
