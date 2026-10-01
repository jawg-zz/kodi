import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Kodi on Convex — rent-management SaaS (Kenya).
 *
 * Ported from Supabase Postgres: all money is integer whole KES,
 * month keys are "YYYY-MM", user references are OIDC subject strings
 * (identity.subject, not v.id()), enforced at function boundaries in code
 * (no RLS — auth lives in convex/lib/auth.ts).
 *
 * Auth history: Convex Auth Password + authTables until Sept 2026, then a
 * hard cutover to Zitadel OIDC wiped the auth tables; a second hard cutover
 * to self-hosted Logto OIDC followed. Each cutover orphaned old
 * subject-keyed app rows; everyone re-registered.
 */
export default defineSchema({

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
    /**
     * Reversals (void/refund) at or above this KES amount need the owner;
     * below it any staff may reverse. Default 50,000; 0 disables the gate.
     */
    reversal_limit: v.optional(v.number()),
  }),

  orgMembers: defineTable({
    orgId: v.id("orgs"),
    /** OIDC subject (identity.subject), stable per user. */
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
    /**
     * Stable Paybill account code (e.g. "GC-A1"). Required: minted in the
     * same transaction as tenant creation, so no write path can produce a
     * code-less row. Legacy rows healed by backfillAccountCodes.
     */
    accountCode: v.string(),
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
    .index("by_unit", ["unitId"])
    .index("by_account", ["accountCode"]),

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
      v.literal("mpesa_c2b"),
      v.literal("cash"),
      v.literal("bank"),
    ),
    mpesaCode: v.optional(v.string()),
    /** ms epoch. */
    paidAt: v.number(),
    allocations: v.array(
      v.object({
        invoiceId: v.id("invoices"),
        amount: v.number(),
        /** Denormalized invoice month ("YYYY-MM") for receipts/displays. */
        month: v.optional(v.string()),
      }),
    ),
    receiptNo: v.string(),
    recordedBy: v.optional(v.string()),
    note: v.optional(v.string()),
    /**
     * Ledger state. Rows written before this field existed are "active".
     * voided = staff-cancelled (e.g. wrong tenant/amount), refunded = money
     * returned to the tenant. Both reverse allocations + created credit.
     */
    status: v.optional(
      v.union(
        v.literal("active"),
        v.literal("voided"),
        v.literal("refunded"),
      ),
    ),
    /** STK checkout that created this payment — one payment per checkout. */
    checkoutRequestId: v.optional(v.string()),
    /** Overpayment carried to tenant credit by this payment. */
    leftoverCredit: v.optional(v.number()),
    reversedAt: v.optional(v.number()),
    reversedBy: v.optional(v.string()),
    reverseReason: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_tenant", ["tenantId"])
    .index("by_org_paidAt", ["orgId", "paidAt"])
    .index("by_org_code", ["orgId", "mpesaCode"])
    .index("by_checkout", ["checkoutRequestId"]),

  /**
   * Append-only prepaid-credit history per tenant. `amount` is signed:
   * positive when credit is created, negative when consumed/reversed.
   */
  creditLedger: defineTable({
    orgId: v.id("orgs"),
    tenantId: v.id("tenants"),
    paymentId: v.optional(v.id("payments")),
    kind: v.union(
      v.literal("created"),
      v.literal("applied"),
      v.literal("reversed"),
    ),
    amount: v.number(),
    balanceAfter: v.number(),
    note: v.optional(v.string()),
  })
    .index("by_tenant", ["tenantId"])
    .index("by_org", ["orgId"]),

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
    /**
     * Cached Daraja OAuth token (AES-GCM encrypted, same key as the creds).
     * Daraja invalidates the previous token on every mint, so all actions
     * share this one row instead of minting per call. Tokens live 3600s;
     * readers treat the token as stale TOKEN_SKEW_MS early (see lib/daraja).
     */
    darajaTokenEnc: v.optional(v.string()),
    /** ms epoch when the cached token expires (Daraja `expires_in`). */
    darajaTokenExpiresAt: v.optional(v.number()),
    /**
     * C2B (Paybill) wiring. registerUrls must succeed before Safaricom
     * delivers validation/confirmation hits to /c2b-*.
     */
    c2bRegistered: v.optional(v.boolean()),
    c2bRegisteredAt: v.optional(v.number()),
    /**
     * Initiator credentials for Transaction Status / Balance / Reversal /
     * B2C / B2B / Tax APIs. Password is AES-GCM encrypted; the X.509 cert
     * PEM is public-key material (safe as plaintext). Set via the
     * saveInitiatorCreds owner action (Settings → Initiator & payouts).
     */
    initiatorName: v.optional(v.string()),
    initiatorPasswordEnc: v.optional(v.string()),
    initiatorCertPem: v.optional(v.string()),
    /** C2B validation strictness: accept_all (default, money-safe) or strict. */
    validationMode: v.optional(
      v.union(v.literal("accept_all"), v.literal("strict")),
    ),
    /** Lipa na Bonga operator auth (separate SHA256 user/pass scheme). */
    bongaUsernameEnc: v.optional(v.string()),
    bongaPasswordEnc: v.optional(v.string()),
    /** Bill Manager opt-in state; appKey is AES-GCM encrypted. */
    billManagerOptedIn: v.optional(v.boolean()),
    billManagerAppKeyEnc: v.optional(v.string()),
    billManagerEmail: v.optional(v.string()),
    /** Pull Transactions one-time registration + nightly cursor. */
    pullRegistered: v.optional(v.boolean()),
    lastPullAt: v.optional(v.number()),
    /** Nightly Account Balance snapshot cursor. */
    lastBalanceAt: v.optional(v.number()),
  }).index("by_org", ["orgId"]),

  /**
   * Raw C2B (Paybill) hits from Safaricom, one row per TransID. Matched rows
   * link a payment; unmatched rows stay `pending_review` so money is never
   * silently lost when the tenant types the wrong account number.
   */
  c2bPayments: defineTable({
    orgId: v.id("orgs"),
    tenantId: v.optional(v.id("tenants")),
    transId: v.string(),
    transAmount: v.number(),
    billRef: v.optional(v.string()),
    msisdn: v.string(),
    firstName: v.optional(v.string()),
    middleName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    transTime: v.optional(v.string()),
    status: v.union(
      v.literal("pending_review"),
      v.literal("matched"),
      v.literal("rejected"),
    ),
    matchReason: v.optional(v.string()),
    paymentId: v.optional(v.id("payments")),
    rawPayload: v.optional(v.string()),
  })
    .index("by_trans", ["transId"])
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"]),

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
    /** Daraja B2C payout link once the refund leaves via M-Pesa. */
    b2cConversationId: v.optional(v.string()),
    b2cReceipt: v.optional(v.string()),
    b2cStatus: v.optional(
      v.union(v.literal("pending"), v.literal("sent"), v.literal("failed")),
    ),
  })
    .index("by_org", ["orgId"])
    .index("by_tenant", ["tenantId"]),

  /**
   * Outbound Daraja async jobs: Transaction Status lookups, Balance
   * queries, Reversals, B2C/B2B payouts, Tax remittances, Pull windows.
   * One row per OriginatorConversationID (Daraja's own dedupe key):
   * accepted ≠ completed — result callbacks flip the row to done/failed.
   */
  darajaJobs: defineTable({
    orgId: v.id("orgs"),
    kind: v.union(
      v.literal("txn_status"),
      v.literal("balance"),
      v.literal("reversal"),
      v.literal("b2c"),
      v.literal("topup"),
      v.literal("b2b"),
      v.literal("tax"),
      v.literal("pull"),
    ),
    conversationId: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("done"),
      v.literal("failed"),
    ),
    requestSummary: v.optional(v.string()),
    resultCode: v.optional(v.string()),
    resultDesc: v.optional(v.string()),
    rawResult: v.optional(v.string()),
    paymentId: v.optional(v.id("payments")),
    tenantId: v.optional(v.id("tenants")),
    amount: v.optional(v.number()),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_org", ["orgId"])
    .index("by_org_kind", ["orgId", "kind"])
    .index("by_org_status", ["orgId", "status"]),

  /**
   * Bill Manager app state per org: opt-in result, mirror cursor, callback
   * dedupe (transactionId is idempotent across the 5× callback retries).
   */
  billManagerState: defineTable({
    orgId: v.id("orgs"),
    optedIn: v.boolean(),
    appKeyEnc: v.optional(v.string()),
    email: v.optional(v.string()),
    lastMirroredAt: v.optional(v.number()),
    /** transactionIds already ingested (capped list, newest last). */
    seenTransactionIds: v.optional(v.array(v.string())),
  }).index("by_org", ["orgId"]),

  /**
   * Dynamic QR codes minted per invoice (base64 PNG from Daraja). Cached
   * so prints don't re-mint; regenerable when the balance changes.
   */
  invoiceQrs: defineTable({
    orgId: v.id("orgs"),
    invoiceId: v.id("invoices"),
    qrBase64: v.string(),
    amount: v.number(),
    refNo: v.string(),
  })
    .index("by_invoice", ["invoiceId"])
    .index("by_org", ["orgId"]),

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

  /**
   * Inbound Daraja webhook hits (STK callback + C2B validation/confirmation
   * + reversals). Append-only debug trail: what arrived, what we did with
   * it, and how long it took. Bounded — prune jobs keep the last N days.
   */
  webhookLog: defineTable({
    orgId: v.optional(v.id("orgs")),
    route: v.string(),
    transId: v.optional(v.string()),
    shortcode: v.optional(v.string()),
    outcome: v.string(),
    detail: v.optional(v.string()),
    latencyMs: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_route", ["route"]),

  /**
   * Payment anomaly alerts for staff: unusual spikes, unknown senders,
   * verification failures. Acknowledged from the Payments page; never
   * auto-deleted so the trail survives.
   */
  paymentAlerts: defineTable({
    orgId: v.id("orgs"),
    kind: v.string(),
    title: v.string(),
    detail: v.optional(v.string()),
    transId: v.optional(v.string()),
    acknowledged: v.boolean(),
    acknowledgedBy: v.optional(v.string()),
    acknowledgedAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_open", ["orgId", "acknowledged"]),

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
