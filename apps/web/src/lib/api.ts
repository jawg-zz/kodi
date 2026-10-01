import { convex } from "./convex";
import { api } from "../../../../convex/_generated/api";
import type {
  AllocationPreview,
  ArrearsAging,
  AuditEvent,
  BalanceSnapshot,
  BillManagerState,
  BongaQuote,
  C2bPayment,
  C2bRiskReview,
  C2bStatusView,
  C2bSuggestion,
  CollectionMonth,
  CreditLedgerEntry,
  DailyClose,
  DarajaJob,
  DarajaJobKind,
  DepositSettlement,
  DepositsAndCredits,
  InitiatorStatusView,
  Invoice,
  InvoiceQr,
  InvoiceWithRefs,
  MpesaHealth,
  MpesaTransaction,
  Org,
  PaybillInfo,
  PaymentAlert,
  PaymentRecordResult,
  PaymentsBreakdown,
  PaymentWithRefs,
  Property,
  RentRoll,
  SettlementPayout,
  ShortcodeCheck,
  StatusLookup,
  Tenant,
  TenantUserLink,
  Unit,
  UnitWithTenant,
  WebhookHit,
} from "./types";

function err(e: unknown): never {
  throw new Error(e instanceof Error ? e.message : String(e));
}

const iso = (ms: number): string => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Translators: camelCase Convex rows -> snake_case frontend types
// ---------------------------------------------------------------------------
function toOrg(r: any): Org {
  return {
    id: r._id,
    name: r.name,
    plan_code: r.plan_code,
    subscription_status: r.subscription_status,
    subscription_period_end: r.subscription_period_end ?? null,
    invoice_due_day: r.invoice_due_day,
    reversal_limit: r.reversal_limit ?? null,
    created_at: iso(r._creationTime),
  };
}

function toProperty(r: any): Property {
  return {
    id: r._id,
    org_id: r.orgId,
    name: r.name,
    property_type: r.property_type,
    location: r.location,
    notes: r.notes ?? null,
    created_at: iso(r._creationTime),
  };
}

function emptyTenant(id: string, orgId: string): Tenant {
  return {
    id,
    org_id: orgId,
    full_name: "",
    phone: "",
    national_id: "",
    // Placeholder for ref-hydration only; server rows always carry a code.
    account_code: "",
    unit_id: null,
    move_in_date: null,
    deposit_held: 0,
    status: "active",
    notes: null,
  };
}

function toTenant(r: any): Tenant {
  return {
    id: r._id,
    org_id: r.orgId,
    full_name: r.full_name,
    phone: r.phone,
    national_id: r.national_id ?? "",
    // Required since the creation invariant; legacy rows fall back to ""
    // and the staff backfill heals them.
    account_code: r.accountCode ?? "",
    unit_id: r.unitId ?? null,
    move_in_date: r.move_in_date ?? null,
    deposit_held: r.deposit_held ?? 0,
    status: r.status,
    notes: r.notes ?? null,
  };
}

function toUnit(r: any): Unit {
  return {
    id: r._id,
    org_id: r.orgId,
    property_id: r.propertyId,
    label: r.label,
    unit_type: r.unit_type,
    rent_amount: r.rent_amount,
    water_charge: r.water_charge,
    garbage_charge: r.garbage_charge,
    status: r.status,
    current_tenant_id: r.currentTenantId ?? null,
  };
}

function toUnitWithTenant(r: any): UnitWithTenant {
  const unit = toUnit(r);
  let tenant: Tenant | null = null;
  if (r.tenant) {
    tenant = {
      ...emptyTenant(r.tenant._id ?? r.tenant.id, r.orgId),
      full_name: r.tenant.full_name,
      phone: r.tenant.phone,
      status: r.tenant.status ?? "active",
      deposit_held: r.tenant.deposit_held ?? 0,
      unit_id: r._id,
    };
  }
  return { ...unit, tenant };
}

function emptyUnit(id: string): Unit {
  return {
    id,
    org_id: "",
    property_id: "",
    label: "",
    unit_type: "bedsitter",
    rent_amount: 0,
    water_charge: 0,
    garbage_charge: 0,
    status: "vacant",
    current_tenant_id: null,
  };
}

function toInvoice(r: any): InvoiceWithRefs {
  return {
    id: r._id,
    org_id: r.orgId,
    tenant_id: r.tenantId,
    unit_id: r.unitId ?? null,
    month: r.month,
    lines: r.lines,
    total: r.total,
    due_date: r.dueDate,
    status: r.status,
    balance: r.balance,
    notes: r.notes ?? null,
    tenant: r.tenant
      ? { ...emptyTenant(r.tenant._id, r.orgId), full_name: r.tenant.full_name, phone: r.tenant.phone }
      : null,
    unit: r.unit ? { ...emptyUnit(r.unit._id), label: r.unit.label } : null,
  };
}

function toPayment(r: any): PaymentWithRefs {
  return {
    id: r._id,
    org_id: r.orgId,
    tenant_id: r.tenantId,
    amount: r.amount,
    method: r.method,
    mpesa_code: r.mpesaCode ?? null,
    paid_at: iso(r.paidAt),
    allocations: (r.allocations ?? []).map((a: any) => ({
      invoiceId: a.invoiceId,
      amount: a.amount,
      month: a.month ?? undefined,
    })),
    receipt_no: r.receiptNo,
    recorded_by: r.recordedBy ?? null,
    note: r.note ?? null,
    status: r.status ?? "active",
    checkout_request_id: r.checkoutRequestId ?? null,
    leftover_credit: r.leftoverCredit ?? 0,
    reversed_at: r.reversedAt ? iso(r.reversedAt) : null,
    reverse_reason: r.reverseReason ?? null,
    tenant: r.tenant
      ? {
          ...emptyTenant(r.tenant._id, r.orgId),
          full_name: r.tenant.full_name,
          phone: r.tenant.phone ?? "",
          unit_id: r.tenant.unitId ?? null,
        }
      : null,
  };
}

function toPaymentResult(r: any): PaymentRecordResult {
  return {
    id: r.id ?? r._id,
    allocations: (r.allocations ?? []).map((a: any) => ({
      invoiceId: a.invoiceId,
      amount: a.amount,
      month: a.month ?? undefined,
    })),
    leftover_credit: r.leftoverCredit ?? r.leftover ?? 0,
    credit_used: r.creditUsed ?? r.credit_used ?? 0,
  };
}

function toPreview(r: any): AllocationPreview {
  return {
    allocations: (r.allocations ?? []).map((a: any) => ({
      invoiceId: a.invoiceId,
      month: a.month,
      total: a.total,
      balance: a.balance,
      applied: a.applied,
    })),
    leftover: r.leftover ?? 0,
  };
}

function toCreditEntry(r: any): CreditLedgerEntry {
  return {
    id: r._id,
    kind: r.kind,
    amount: r.amount,
    balance_after: r.balanceAfter,
    payment_id: r.paymentId ?? null,
    note: r.note ?? null,
    created_at: iso(r._creationTime),
  };
}

function toTx(r: any): MpesaTransaction {
  return {
    id: r._id,
    org_id: r.orgId,
    tenant_id: r.tenantId,
    checkout_request_id: r.checkoutRequestId,
    merchant_request_id: r.merchantRequestId ?? null,
    phone: r.phone,
    amount: r.amount,
    status: r.status,
    result_code: r.resultCode ?? null,
    result_desc: r.resultDesc ?? null,
    mpesa_receipt: r.mpesaReceipt ?? null,
    payment_id: r.paymentId ?? null,
    created_at: iso(r._creationTime),
  };
}

function toSettlement(r: any): DepositSettlement {
  return {
    id: r._id,
    org_id: r.orgId,
    tenant_id: r.tenantId,
    deposit_held: r.depositHeld,
    deductions: r.deductions ?? [],
    total_deductions: r.totalDeductions,
    refund_amount: r.refundAmount,
    notes: r.notes ?? null,
    created_at: iso(r._creationTime),
  };
}

// ---------------------------------------------------------------------------
// Properties & units
// ---------------------------------------------------------------------------
export async function listProperties(orgId: string): Promise<Property[]> {
  try {
    const rows = (await convex.query((api as any).properties.listProperties, {
      orgId,
    })) as any[];
    return rows.map(toProperty);
  } catch (e) {
    return err(e);
  }
}

export async function listUnits(orgId: string): Promise<UnitWithTenant[]> {
  try {
    const rows = (await convex.query((api as any).properties.listUnits, {
      orgId,
    })) as any[];
    return rows.map(toUnitWithTenant);
  } catch (e) {
    return err(e);
  }
}

export async function countUnits(orgId: string): Promise<number> {
  try {
    return (await convex.query((api as any).properties.countUnits, {
      orgId,
    })) as number;
  } catch (e) {
    return err(e);
  }
}

export async function createProperty(
  orgId: string,
  values: Pick<Property, "name" | "property_type" | "location" | "notes">,
): Promise<Property> {
  try {
    const row = (await convex.mutation((api as any).properties.createProperty, {
      orgId,
      name: values.name,
      property_type: values.property_type,
      location: values.location ?? "",
      notes: values.notes ?? undefined,
    })) as any;
    return toProperty(row);
  } catch (e) {
    return err(e);
  }
}

export async function updateProperty(
  id: string,
  values: Partial<Property>,
): Promise<void> {
  try {
    await convex.mutation((api as any).properties.updateProperty, {
      id,
      name: values.name,
      property_type: values.property_type,
      location: values.location,
      notes: values.notes ?? undefined,
    });
  } catch (e) {
    return err(e);
  }
}

export async function deleteProperty(id: string): Promise<void> {
  try {
    await convex.mutation((api as any).properties.deleteProperty, { id });
  } catch (e) {
    return err(e);
  }
}

export async function createUnit(
  orgId: string,
  values: Omit<Unit, "id" | "org_id" | "status" | "current_tenant_id">,
): Promise<Unit> {
  try {
    const row = (await convex.mutation((api as any).properties.createUnit, {
      orgId,
      propertyId: (values as any).property_id,
      label: values.label,
      unit_type: values.unit_type,
      rent_amount: values.rent_amount,
      water_charge: values.water_charge,
      garbage_charge: values.garbage_charge,
    })) as any;
    return toUnit(row);
  } catch (e) {
    return err(e);
  }
}

export async function updateUnit(
  id: string,
  values: Partial<Unit> & { property_id?: string },
): Promise<void> {
  try {
    await convex.mutation((api as any).properties.updateUnit, {
      id,
      label: values.label,
      unit_type: values.unit_type,
      rent_amount: values.rent_amount,
      water_charge: values.water_charge,
      garbage_charge: values.garbage_charge,
      propertyId: (values as any).property_id,
    });
  } catch (e) {
    return err(e);
  }
}

export async function deleteUnit(id: string): Promise<void> {
  try {
    await convex.mutation((api as any).properties.deleteUnit, { id });
  } catch (e) {
    return err(e);
  }
}

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------
export async function listTenants(orgId: string): Promise<Tenant[]> {
  try {
    const rows = (await convex.query((api as any).tenants.listTenants, {
      orgId,
    })) as any[];
    return rows.map(toTenant);
  } catch (e) {
    return err(e);
  }
}

export async function getTenant(id: string): Promise<Tenant | null> {
  try {
    const row = (await convex.query((api as any).tenants.getTenant, {
      id,
    })) as any;
    return row ? toTenant(row) : null;
  } catch (e) {
    return err(e);
  }
}

export async function createTenant(
  orgId: string,
  // account_code is server-minted at creation — callers never supply it.
  values: Omit<Tenant, "id" | "org_id" | "status" | "notes" | "account_code"> & {
    notes?: string;
  },
): Promise<Tenant> {
  try {
    const row = (await convex.mutation((api as any).tenants.createTenant, {
      orgId,
      full_name: values.full_name,
      phone: values.phone,
      national_id: (values as any).national_id ?? "",
      unitId: (values as any).unit_id ?? undefined,
      move_in_date: (values as any).move_in_date ?? undefined,
      deposit_held: (values as any).deposit_held ?? 0,
      notes: (values as any).notes ?? undefined,
    })) as any;
    return toTenant(row);
  } catch (e) {
    return err(e);
  }
}

export async function updateTenant(
  id: string,
  values: Partial<Tenant>,
): Promise<void> {
  try {
    await convex.mutation((api as any).tenants.updateTenant, {
      id,
      full_name: values.full_name,
      phone: values.phone,
      national_id: (values as any).national_id,
      unitId:
        (values as any).unit_id === null
          ? null
          : ((values as any).unit_id ?? undefined),
      move_in_date:
        (values as any).move_in_date === null
          ? null
          : ((values as any).move_in_date ?? undefined),
      deposit_held: values.deposit_held,
      status: values.status,
      notes:
        (values as any).notes === null ? null : ((values as any).notes ?? undefined),
    });
  } catch (e) {
    return err(e);
  }
}

export async function deleteTenant(id: string): Promise<void> {
  try {
    await convex.mutation((api as any).tenants.deleteTenant, { id });
  } catch (e) {
    return err(e);
  }
}

export async function getTenantPortalLink(
  tenantId: string,
): Promise<TenantUserLink | null> {
  try {
    const row = (await convex.query(
      (api as any).tenants.getTenantPortalLink,
      { tenantId },
    )) as any;
    return row ? { tenant_id: row.tenantId, user_id: row.userId } : null;
  } catch (e) {
    return err(e);
  }
}

export async function settleDeposit(
  orgId: string,
  tenant: Tenant,
  deductions: { label: string; amount: number }[],
  refund: number,
  notes: string | null,
): Promise<DepositSettlement> {
  try {
    const row = (await convex.mutation((api as any).tenants.settleDeposit, {
      orgId,
      tenantId: tenant.id,
      deductions,
      refundAmount: refund,
      notes: notes ?? undefined,
    })) as any;
    return toSettlement(row);
  } catch (e) {
    return err(e);
  }
}

export async function listSettlements(
  orgId: string,
): Promise<DepositSettlement[]> {
  try {
    const rows = (await convex.query((api as any).tenants.listSettlements, {
      orgId,
    })) as any[];
    return rows.map(toSettlement);
  } catch (e) {
    return err(e);
  }
}

export async function getSettlement(
  id: string,
): Promise<(DepositSettlement & { tenant: Tenant | null }) | null> {
  try {
    const row = (await convex.query((api as any).tenants.getSettlement, {
      id,
    })) as any;
    if (!row) return null;
    return {
      ...toSettlement(row),
      tenant: row.tenant
        ? {
            ...emptyTenant(row.tenant._id, row.orgId),
            full_name: row.tenant.full_name,
            phone: row.tenant.phone,
          }
        : null,
    };
  } catch (e) {
    return err(e);
  }
}

export async function previewAllocation(
  tenantId: string,
  amount: number,
): Promise<AllocationPreview> {
  try {
    const row = (await convex.query(
      (api as any).invoices.previewAllocation,
      { tenantId, amount },
    )) as any;
    return toPreview(row);
  } catch (e) {
    return err(e);
  }
}

/** Prepaid-credit history for one tenant, newest first. */
export async function getCreditLedger(
  tenantId: string,
): Promise<CreditLedgerEntry[]> {
  try {
    const rows = (await convex.query(
      (api as any).tenants.getCreditLedger,
      { tenantId },
    )) as any[];
    return rows.map(toCreditEntry);
  } catch (e) {
    return err(e);
  }
}

/** Sweep a tenant's held credit onto open invoices now. Returns KES consumed. */
export async function applyCreditNow(tenantId: string): Promise<number> {
  try {
    return (await convex.mutation((api as any).tenants.applyCreditNow, {
      tenantId,
    })) as number;
  } catch (e) {
    return err(e);
  }
}

/** Prepaid credit held for a tenant (overpayments carried forward). */
export async function getTenantCredit(tenantId: string): Promise<number> {
  try {
    return (await convex.query((api as any).tenants.getTenantCredit, {
      tenantId,
    })) as number;
  } catch (e) {
    return err(e);
  }
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------
export async function listInvoices(
  orgId: string,
  month?: string,
): Promise<InvoiceWithRefs[]> {
  try {
    const rows = (await convex.query((api as any).invoices.listInvoices, {
      orgId,
      month,
    })) as any[];
    return rows.map(toInvoice);
  } catch (e) {
    return err(e);
  }
}

export async function listTenantInvoices(
  tenantId: string,
): Promise<InvoiceWithRefs[]> {
  try {
    const rows = (await convex.query(
      (api as any).invoices.listTenantInvoices,
      { tenantId },
    )) as any[];
    return rows.map(toInvoice);
  } catch (e) {
    return err(e);
  }
}

export async function getInvoice(id: string): Promise<InvoiceWithRefs | null> {
  try {
    const row = (await convex.query((api as any).invoices.getInvoice, {
      id,
    })) as any;
    return row ? toInvoice(row) : null;
  } catch (e) {
    return err(e);
  }
}

export async function generateInvoices(
  orgId: string,
  month: string,
): Promise<number> {
  try {
    return (await convex.mutation((api as any).invoices.generateInvoices, {
      orgId,
      month,
    })) as number;
  } catch (e) {
    return err(e);
  }
}

export async function updateInvoice(
  id: string,
  values: Partial<Invoice>,
): Promise<void> {
  try {
    // Totals/balances are ledger-owned server-side; only due date + notes
    // are editable so allocated money keeps adding up.
    await convex.mutation((api as any).invoices.updateInvoice, {
      id,
      notes: (values as any).notes ?? undefined,
      dueDate: (values as any).due_date,
    });
  } catch (e) {
    return err(e);
  }
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
export async function listPayments(
  orgId: string,
  tenantId?: string,
): Promise<PaymentWithRefs[]> {
  try {
    const rows = (await convex.query((api as any).payments.listPayments, {
      orgId,
      tenantId,
    })) as any[];
    return rows.map(toPayment);
  } catch (e) {
    return err(e);
  }
}

export async function listTenantPayments(
  tenantId: string,
): Promise<PaymentWithRefs[]> {
  try {
    const rows = (await convex.query(
      (api as any).payments.listTenantPayments,
      { tenantId },
    )) as any[];
    return rows.map(toPayment);
  } catch (e) {
    return err(e);
  }
}

export async function recordManualPayment(args: {
  orgId: string;
  tenantId: string;
  amount: number;
  method: "mpesa_manual" | "cash" | "bank";
  mpesaCode: string | null;
  paidAt: string;
  note: string | null;
  /** Pay these invoices first (then FIFO across the rest). */
  targets?: string[];
  /** Spend the tenant's held prepaid credit before applying the cash. */
  useCredit?: boolean;
}): Promise<PaymentRecordResult> {
  try {
    const row = (await convex.mutation(
      (api as any).payments.recordManualPayment,
      {
        orgId: args.orgId,
        tenantId: args.tenantId,
        amount: args.amount,
        method: args.method,
        mpesaCode: args.mpesaCode,
        paidAt: new Date(args.paidAt).getTime(),
        note: args.note,
        targets: args.targets,
        useCredit: args.useCredit,
      },
    )) as any;
    return toPaymentResult(row);
  } catch (e) {
    return err(e);
  }
}

/** Void a wrongly-recorded payment: reverses allocations + created credit. */
export async function voidPayment(
  id: string,
  reason: string,
): Promise<{ credit_shortfall: number }> {
  try {
    const row = (await convex.mutation((api as any).payments.voidPayment, {
      id,
      reason,
    })) as any;
    return { credit_shortfall: row.creditShortfall ?? 0 };
  } catch (e) {
    return err(e);
  }
}

/** Record that money from a payment was returned to the tenant. */
export async function refundPayment(
  id: string,
  reason: string,
): Promise<{ credit_shortfall: number }> {
  try {
    const row = (await convex.mutation((api as any).payments.refundPayment, {
      id,
      reason,
    })) as any;
    return { credit_shortfall: row.creditShortfall ?? 0 };
  } catch (e) {
    return err(e);
  }
}

export async function getPayment(
  id: string,
): Promise<PaymentWithRefs | null> {
  try {
    const row = (await convex.query((api as any).payments.getPayment, {
      id,
    })) as any;
    return row ? toPayment(row) : null;
  } catch (e) {
    return err(e);
  }
}

// ---------------------------------------------------------------------------
// M-Pesa STK (Convex actions)
// ---------------------------------------------------------------------------
export async function stkInitiate(args: {
  tenantId: string;
  phone: string;
  amount: number;
  idempotencyKey?: string;
}): Promise<{ checkoutRequestId: string; deduplicated?: boolean }> {
  try {
    return (await convex.action((api as any).mpesa.stkInitiate, {
      tenantId: args.tenantId,
      phone: args.phone,
      amount: args.amount,
      idempotencyKey: args.idempotencyKey,
    })) as { checkoutRequestId: string; deduplicated?: boolean };
  } catch (e) {
    return err(e);
  }
}

export async function listTenantMpesaAttempts(
  tenantId: string,
): Promise<MpesaTransaction[]> {
  try {
    const rows = (await convex.query(
      (api as any).mpesa.listTenantMpesaAttempts,
      { tenantId },
    )) as any[];
    return rows.map(toTx);
  } catch (e) {
    return err(e);
  }
}

export async function stkStatus(
  checkoutRequestId: string,
): Promise<MpesaTransaction> {
  try {
    const row = (await convex.action((api as any).mpesa.stkStatus, {
      checkoutRequestId,
    })) as any;
    return toTx(row);
  } catch (e) {
    return err(e);
  }
}

export async function listMpesaTransactions(
  orgId: string,
): Promise<MpesaTransaction[]> {
  try {
    const rows = (await convex.query(
      (api as any).mpesa.listMpesaTransactions,
      { orgId },
    )) as any[];
    return rows.map(toTx);
  } catch (e) {
    return err(e);
  }
}

// ---------------------------------------------------------------------------
// M-Pesa C2B (Paybill): tenants pay from the M-Pesa menu, Kodi auto-records
// ---------------------------------------------------------------------------
function toC2b(r: any): C2bPayment {
  return {
    id: r._id,
    org_id: r.orgId,
    tenant_id: r.tenantId ?? null,
    tenant_name: r.tenantName ?? null,
    trans_id: r.transId,
    amount: r.transAmount,
    bill_ref: r.billRef ?? null,
    msisdn: r.msisdn,
    sender_name: r.senderName ?? null,
    trans_time: r.transTime ?? null,
    status: r.status,
    match_reason: r.matchReason ?? null,
    payment_id: r.paymentId ?? null,
    created_at: iso(r._creationTime),
  };
}

export async function listC2bPayments(
  orgId: string,
  status?: "pending_review" | "matched" | "rejected",
): Promise<C2bPayment[]> {
  try {
    const rows = (await convex.query((api as any).c2b.listC2bPayments, {
      orgId,
      status,
    })) as any[];
    return rows.map(toC2b);
  } catch (e) {
    return err(e);
  }
}

export async function matchC2bPayment(
  id: string,
  tenantId: string,
): Promise<string> {
  try {
    return (await convex.mutation((api as any).c2b.matchC2bPayment, {
      id,
      tenantId,
    })) as string;
  } catch (e) {
    return err(e);
  }
}

export async function rejectC2bPayment(
  id: string,
  reason: string,
): Promise<void> {
  try {
    await convex.mutation((api as any).c2b.rejectC2bPayment, { id, reason });
  } catch (e) {
    return err(e);
  }
}

/** Ranked tenant suggestions for a queued Paybill hit. */
export async function suggestC2bTenant(id: string): Promise<C2bSuggestion[]> {
  try {
    const rows = (await convex.query((api as any).c2b.suggestC2bTenant, {
      id,
    })) as any[];
    return rows.map((r: any) => ({
      tenant_id: r.tenantId,
      tenant_name: r.tenantName,
      phone: r.phone,
      account_code: r.accountCode ?? null,
      score: r.score,
      signals: r.signals ?? [],
    }));
  } catch (e) {
    return err(e);
  }
}

/** Match every queued hit with an unambiguous sender phone. */
export async function bulkMatchC2bByPhone(
  orgId: string,
): Promise<{ matched: number; skipped: number }> {
  try {
    return (await convex.mutation((api as any).c2b.bulkMatchC2bByPhone, {
      orgId,
    })) as { matched: number; skipped: number };
  } catch (e) {
    return err(e);
  }
}

/** What the tenant types into the M-Pesa Paybill menu. */
export async function getPaybillInfo(
  tenantId: string,
): Promise<PaybillInfo | null> {
  try {
    const row = (await convex.query((api as any).c2b.getPaybillInfo, {
      tenantId,
    })) as any;
    if (!row) return null;
    return {
      shortcode: row.shortcode,
      account_code: row.accountCode,
      registered: row.registered,
    };
  } catch (e) {
    return err(e);
  }
}

/** Mint the tenant's Paybill account code if they don't have one yet. */
export async function ensureMyAccountCode(): Promise<string> {
  try {
    return (await convex.mutation(
      (api as any).c2b.ensureMyAccountCode,
      {},
    )) as string;
  } catch (e) {
    return err(e);
  }
}

/** Staff: mint one tenant's Paybill account code (pre-code rows). */
export async function ensureTenantAccountCode(
  tenantId: string,
): Promise<string> {
  try {
    return (await convex.mutation(
      (api as any).c2b.ensureTenantAccountCode,
      { tenantId },
    )) as string;
  } catch (e) {
    return err(e);
  }
}

/** Staff: backfill codes for every tenant in the org missing one. */
export async function backfillAccountCodes(
  orgId: string,
): Promise<{ minted: number; skipped: number }> {
  try {
    return (await convex.mutation((api as any).c2b.backfillAccountCodes, {
      orgId,
    })) as { minted: number; skipped: number };
  } catch (e) {
    return err(e);
  }
}

export async function getC2bStatus(): Promise<C2bStatusView> {
  try {
    const row = (await convex.query((api as any).c2b.getC2bStatus, {})) as any;
    return {
      configured: row.configured,
      shortcode: row.shortcode,
      registered: row.registered,
      registered_at: row.registeredAt ? iso(row.registeredAt) : null,
    };
  } catch (e) {
    return err(e);
  }
}

export async function registerC2bUrls(): Promise<boolean> {
  try {
    const row = (await convex.action(
      (api as any).c2b.registerC2bUrls,
      {},
    )) as any;
    return row.registered;
  } catch (e) {
    return err(e);
  }
}

/** Owner: switch C2B validation strictness (accept_all vs strict). */
export async function setValidationMode(
  orgId: string,
  mode: "accept_all" | "strict",
): Promise<void> {
  try {
    await convex.mutation((api as any).c2b.setValidationMode, {
      orgId,
      mode,
    });
  } catch (e) {
    return err(e);
  }
}

// ---------------------------------------------------------------------------
// Extended Daraja tracks: initiator, verify, payouts, bill manager,
// QR/shortcode check, Bonga. Translators stay snake_case.
// ---------------------------------------------------------------------------
function toDarajaJob(r: any): DarajaJob {
  return {
    id: r._id,
    org_id: r.orgId,
    kind: r.kind,
    conversation_id: r.conversationId,
    status: r.status,
    request_summary: r.requestSummary ?? null,
    result_code: r.resultCode ?? null,
    result_desc: r.resultDesc ?? null,
    payment_id: r.paymentId ?? null,
    tenant_id: r.tenantId ?? null,
    amount: r.amount ?? null,
    created_at: iso(r._creationTime),
  };
}

export async function getInitiatorStatus(): Promise<InitiatorStatusView> {
  try {
    const row = (await convex.query(
      (api as any).mpesa.getInitiatorStatus,
      {},
    )) as any;
    return {
      configured: row.configured,
      initiator_name: row.initiatorName,
      cert_subject: row.certSubject ?? null,
      cert_expired: row.certExpired ?? null,
    };
  } catch (e) {
    return err(e);
  }
}

export async function saveInitiatorCreds(values: {
  initiatorName: string;
  initiatorPassword: string;
  initiatorCertPem: string;
}): Promise<{ cert_subject: string; cert_valid_to: string; cert_key_bits: number }> {
  try {
    const row = (await convex.action(
      (api as any).mpesa.saveInitiatorCreds,
      values,
    )) as any;
    return {
      cert_subject: row.certSubject,
      cert_valid_to: row.certValidTo,
      cert_key_bits: row.certKeyBits,
    };
  } catch (e) {
    return err(e);
  }
}

export async function queryTransactionStatus(args: {
  orgId: string;
  transactionId?: string;
  originatorConversationId?: string;
  partyA?: string;
  remarks?: string;
}): Promise<{ conversation_id: string; job_id: string }> {
  try {
    const row = (await convex.action(
      (api as any).verify.queryTransactionStatus,
      args,
    )) as any;
    return { conversation_id: row.conversationId, job_id: row.jobId };
  } catch (e) {
    return err(e);
  }
}

export async function latestStatusFor(
  orgId: string,
  transactionId: string,
): Promise<StatusLookup | null> {
  try {
    const row = (await convex.query((api as any).verify.latestStatusFor, {
      orgId,
      transactionId,
    })) as any;
    if (!row) return null;
    return {
      status: row.status,
      result_code: row.resultCode ?? null,
      result_desc: row.resultDesc ?? null,
      conversation_id: row.conversationId,
    };
  } catch (e) {
    return err(e);
  }
}

export async function queryAccountBalance(
  orgId: string,
): Promise<{ conversation_id: string; job_id: string }> {
  try {
    const row = (await convex.action(
      (api as any).verify.queryAccountBalance,
      { orgId },
    )) as any;
    return { conversation_id: row.conversationId, job_id: row.jobId };
  } catch (e) {
    return err(e);
  }
}

export async function latestBalance(orgId: string): Promise<BalanceSnapshot> {
  try {
    const row = (await convex.query((api as any).verify.latestBalance, {
      orgId,
    })) as any;
    return {
      balances: (row.balances ?? []).map((b: any) => ({
        account: b.account,
        balance: b.balance,
      })),
      conversation_id: row.conversationId ?? null,
    };
  } catch (e) {
    return err(e);
  }
}

export async function registerPull(orgId: string): Promise<boolean> {
  try {
    const row = (await convex.action((api as any).verify.registerPull, {
      orgId,
    })) as any;
    return row.registered;
  } catch (e) {
    return err(e);
  }
}

export async function pullC2bWindow(args: {
  orgId: string;
  startDate?: string;
  endDate?: string;
  offset?: number;
}): Promise<{ pulled: number; ingested: number; matched: number; queued: number }> {
  try {
    return (await convex.action((api as any).verify.pullC2bWindow, args)) as {
      pulled: number;
      ingested: number;
      matched: number;
      queued: number;
    };
  } catch (e) {
    return err(e);
  }
}

export async function listDarajaJobs(
  orgId: string,
  kind?: DarajaJobKind,
): Promise<DarajaJob[]> {
  try {
    const rows = (await convex.query((api as any).darajaJobs.listDarajaJobs, {
      orgId,
      kind,
    })) as any[];
    return rows.map(toDarajaJob);
  } catch (e) {
    return err(e);
  }
}

export async function reverseDarajaPayment(args: {
  orgId: string;
  paymentId: string;
  receiverParty?: string;
  remarks?: string;
}): Promise<{ conversation_id: string; job_id: string }> {
  try {
    const row = (await convex.action(
      (api as any).payouts.reverseDarajaPayment,
      args,
    )) as any;
    return { conversation_id: row.conversationId, job_id: row.jobId };
  } catch (e) {
    return err(e);
  }
}

export async function payB2cRefund(args: {
  orgId: string;
  tenantId: string;
  phone: string;
  amount: number;
  commandId?: "BusinessPayment" | "SalaryPayment" | "PromotionPayment";
  settlementId?: string;
  remarks?: string;
}): Promise<{ conversation_id: string; job_id: string }> {
  try {
    const row = (await convex.action(
      (api as any).payouts.payB2cRefund,
      args,
    )) as any;
    return { conversation_id: row.conversationId, job_id: row.jobId };
  } catch (e) {
    return err(e);
  }
}

export async function topUpFloat(
  orgId: string,
  amount: number,
): Promise<{ conversation_id: string; job_id: string }> {
  try {
    const row = (await convex.action((api as any).payouts.topUpFloat, {
      orgId,
      amount,
    })) as any;
    return { conversation_id: row.conversationId, job_id: row.jobId };
  } catch (e) {
    return err(e);
  }
}

export async function payBusinessBill(args: {
  orgId: string;
  commandId: "BusinessPayBill" | "BusinessBuyGoods" | "BusinessTransferFromMMFToUtility";
  partyB: string;
  amount: number;
  accountReference?: string;
  requester?: string;
  remarks?: string;
}): Promise<{ conversation_id: string; job_id: string }> {
  try {
    const row = (await convex.action(
      (api as any).payouts.payBusinessBill,
      args,
    )) as any;
    return { conversation_id: row.conversationId, job_id: row.jobId };
  } catch (e) {
    return err(e);
  }
}

export async function payToPochi(args: {
  orgId: string;
  phone: string;
  amount: number;
  remarks?: string;
}): Promise<{ conversation_id: string; job_id: string }> {
  try {
    const row = (await convex.action((api as any).payouts.payToPochi, args)) as any;
    return { conversation_id: row.conversationId, job_id: row.jobId };
  } catch (e) {
    return err(e);
  }
}

export async function hakikishaB2c(
  orgId: string,
  phone: string,
): Promise<{ first_name?: string | null; masked_name?: string | null; raw: string }> {
  try {
    const row = (await convex.action((api as any).payouts.hakikishaB2c, {
      orgId,
      phone,
    })) as any;
    return {
      first_name: row.firstName ?? null,
      masked_name: row.maskedName ?? null,
      raw: row.raw,
    };
  } catch (e) {
    return err(e);
  }
}

export async function remitTax(args: {
  orgId: string;
  amount: number;
  kraPrn: string;
  remarks?: string;
}): Promise<{ conversation_id: string; job_id: string }> {
  try {
    const row = (await convex.action((api as any).payouts.remitTax, args)) as any;
    return { conversation_id: row.conversationId, job_id: row.jobId };
  } catch (e) {
    return err(e);
  }
}

export async function getSettlementPayout(
  settlementId: string,
): Promise<SettlementPayout | null> {
  try {
    const row = (await convex.query((api as any).payouts.getSettlementPayout, {
      settlementId,
    })) as any;
    if (!row) return null;
    return {
      b2c_status: row.b2cStatus ?? null,
      b2c_conversation_id: row.b2cConversationId ?? null,
      b2c_receipt: row.b2cReceipt ?? null,
    };
  } catch (e) {
    return err(e);
  }
}

export async function getBillManagerState(
  orgId: string,
): Promise<BillManagerState> {
  try {
    const row = (await convex.query(
      (api as any).billManager.getBillManagerState,
      { orgId },
    )) as any;
    return {
      opted_in: row.optedIn,
      email: row.email ?? null,
      last_mirrored_at: row.lastMirroredAt ? iso(row.lastMirroredAt) : null,
      seen_count: row.seenCount,
    };
  } catch (e) {
    return err(e);
  }
}

export async function optInBillManager(args: {
  orgId: string;
  email: string;
  officialContact: string;
  sendReminders: boolean;
}): Promise<boolean> {
  try {
    const row = (await convex.action(
      (api as any).billManager.optInBillManager,
      args,
    )) as any;
    return row.optedIn;
  } catch (e) {
    return err(e);
  }
}

export async function mirrorInvoicesToBillManager(args: {
  orgId: string;
  month?: string;
}): Promise<{ mirrored: number; failed: number }> {
  try {
    return (await convex.action(
      (api as any).billManager.mirrorInvoicesToBillManager,
      args,
    )) as { mirrored: number; failed: number };
  } catch (e) {
    return err(e);
  }
}

export async function mintInvoiceQr(
  invoiceId: string,
  merchantName?: string,
): Promise<InvoiceQr> {
  try {
    const row = (await convex.action((api as any).collect.mintInvoiceQr, {
      invoiceId,
      merchantName,
    })) as any;
    return { qr_base64: row.qrBase64, amount: row.amount, ref_no: row.refNo };
  } catch (e) {
    return err(e);
  }
}

export async function getInvoiceQr(
  invoiceId: string,
): Promise<InvoiceQr | null> {
  try {
    const row = (await convex.query((api as any).collect.getInvoiceQr, {
      invoiceId,
    })) as any;
    if (!row) return null;
    return { qr_base64: row.qrBase64, amount: row.amount, ref_no: row.refNo };
  } catch (e) {
    return err(e);
  }
}

export async function verifyShortcodeOwner(args: {
  orgId: string;
  shortcode?: string;
}): Promise<ShortcodeCheck> {
  try {
    const row = (await convex.action(
      (api as any).collect.verifyShortcodeOwner,
      args,
    )) as any;
    return { org_name: row.orgName ?? null, tariff: row.tariff ?? null, raw: row.raw };
  } catch (e) {
    return err(e);
  }
}

export async function noteJob(jobId: string, note: string): Promise<void> {
  try {
    await convex.mutation((api as any).darajaJobs.noteJob, { jobId, note });
  } catch (e) {
    return err(e);
  }
}

export async function expressCheckoutPush(args: {
  orgId: string;
  operatorId: string;
  operatorPin: string;
  amount: number;
}): Promise<{ conversation_id: string; job_id: string }> {
  try {
    const row = (await convex.action(
      (api as any).payouts.expressCheckoutPush,
      args,
    )) as any;
    return { conversation_id: row.conversationId, job_id: row.jobId };
  } catch (e) {
    return err(e);
  }
}

export async function cancelBillManagerInvoice(args: {
  orgId: string;
  externalReference: string;
  bulk?: boolean;
}): Promise<void> {
  try {
    await convex.action((api as any).billManager.cancelBillManagerInvoice, args);
  } catch (e) {
    return err(e);
  }
}

export async function updateBillManagerDetails(args: {
  orgId: string;
  email?: string;
  officialContact?: string;
  sendReminders?: boolean;
}): Promise<void> {
  try {
    await convex.action((api as any).billManager.updateBillManagerDetails, args);
  } catch (e) {
    return err(e);
  }
}

export async function acknowledgeBillManagerReceipt(
  orgId: string,
  transactionId: string,
): Promise<void> {
  try {
    await convex.mutation(
      (api as any).billManager.acknowledgeBillManagerReceipt,
      { orgId, transactionId },
    );
  } catch (e) {
    return err(e);
  }
}

export async function quoteBongaPoints(
  orgId: string,
  phone: string,
): Promise<BongaQuote> {
  try {
    const row = (await convex.action((api as any).bonga.quoteBongaPoints, {
      orgId,
      phone,
    })) as any;
    return { points: row.points, value_kes: row.valueKes, raw: row.raw };
  } catch (e) {
    return err(e);
  }
}

export async function redeemBongaPoints(args: {
  orgId: string;
  tenantId: string;
  phone: string;
  points: number;
}): Promise<{ raw: string }> {
  try {
    return (await convex.action((api as any).bonga.redeemBongaPoints, args)) as {
      raw: string;
    };
  } catch (e) {
    return err(e);
  }
}

export async function saveBongaCreds(args: {
  orgId: string;
  username: string;
  password: string;
}): Promise<void> {
  try {
    await convex.action((api as any).bonga.saveBongaCreds, args);
  } catch (e) {
    return err(e);
  }
}

// ---------------------------------------------------------------------------
// Org / settings
// ---------------------------------------------------------------------------
export async function updateOrg(
  id: string,
  values: Partial<Org>,
): Promise<void> {
  try {
    await convex.mutation((api as any).orgs.updateOrg, {
      orgId: id,
      name: values.name,
      invoice_due_day: (values as any).invoice_due_day,
      plan_code: (values as any).plan_code,
      reversal_limit: (values as any).reversal_limit,
      subscription_status: values.subscription_status,
    });
  } catch (e) {
    return err(e);
  }
}

export async function createOrg(name: string, planCode: string): Promise<Org> {
  try {
    const row = (await convex.mutation((api as any).orgs.createOrg, {
      name,
      planCode,
    })) as any;
    return toOrg(row);
  } catch (e) {
    return err(e);
  }
}

export interface InviteResult {
  email: string;
  tempPassword: string | null;
  invited: boolean;
  /** Convex invite-link flow: share `/invite/<token>` with the invitee. */
  inviteToken?: string;
}

export async function inviteUser(args: {
  email: string;
  fullName: string;
  phone: string;
  kind: "tenant" | "manager";
  tenantId?: string;
}): Promise<InviteResult> {
  try {
    return (await convex.action((api as any).invites.inviteUser, {
      email: args.email,
      fullName: args.fullName,
      phone: args.phone,
      kind: args.kind,
      tenantId: args.tenantId,
    })) as InviteResult;
  } catch (e) {
    return err(e);
  }
}

export async function getInvite(token: string): Promise<{
  email: string;
  fullName: string;
  kind: "tenant" | "manager";
  expired: boolean;
  claimed: boolean;
} | null> {
  try {
    return (await convex.query((api as any).invites.getInvite, {
      token,
    })) as {
      email: string;
      fullName: string;
      kind: "tenant" | "manager";
      expired: boolean;
      claimed: boolean;
    } | null;
  } catch (e) {
    return err(e);
  }
}

export async function claimInvite(
  token: string,
): Promise<{ orgId: string; kind: string }> {
  try {
    return (await convex.action((api as any).invites.claimInvite, {
      token,
    })) as { orgId: string; kind: string };
  } catch (e) {
    return err(e);
  }
}

export async function listStaff(
  orgId: string,
): Promise<{ user_id: string; role: string; name: string }[]> {
  try {
    return (await convex.query((api as any).orgs.listStaff, {
      orgId,
    })) as { user_id: string; role: string; name: string }[];
  } catch (e) {
    return err(e);
  }
}

// ---------------------------------------------------------------------------
// M-Pesa credentials (never expose secrets; view only)
// ---------------------------------------------------------------------------
export interface MpesaCredsView {
  configured: boolean;
  environment: "sandbox" | "production";
  shortcode: string;
}

export async function getMpesaCreds(): Promise<MpesaCredsView> {
  try {
    return (await convex.query((api as any).mpesa.getMpesaCreds, {})) as MpesaCredsView;
  } catch (e) {
    return err(e);
  }
}

export async function saveMpesaCreds(values: {
  environment: "sandbox" | "production";
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
}): Promise<void> {
  try {
    await convex.action((api as any).mpesa.saveMpesaCreds, values);
  } catch (e) {
    return err(e);
  }
}

/** Full-org JSON backup for Settings → Export. */
export async function exportOrgBackup(
  orgId: string,
): Promise<Record<string, unknown>> {
  try {
    return (await convex.query((api as any).export.exportOrg, {
      orgId,
    })) as Record<string, unknown>;
  } catch (e) {
    return err(e);
  }
}

export interface DemoSummary {
  properties: number;
  units: number;
  tenants: number;
  invoices: number;
  paymentsVoided: number;
  paymentsDeleted: number;
}

/** How much "(Demo)" data exists in the org. */
export async function demoStatus(): Promise<DemoSummary> {
  try {
    return (await convex.query((api as any).demo.demoStatus, {})) as DemoSummary;
  } catch (e) {
    return err(e);
  }
}

/** Remove all demo data (voids payments first, then deletes down the tree). */
export async function clearDemoData(): Promise<DemoSummary> {
  try {
    return (await convex.mutation(
      (api as any).demo.clearDemoData,
      {},
    )) as DemoSummary;
  } catch (e) {
    return err(e);
  }
}

// ---------------------------------------------------------------------------
// Reports (server-aggregated)
// ---------------------------------------------------------------------------
function toCollectionMonth(r: any): CollectionMonth {
  return {
    month: r.month,
    expected: r.expected,
    collected: r.collected,
    outstanding: r.outstanding,
    rate: r.rate,
    invoice_count: r.invoiceCount,
  };
}

function toArrearsAging(r: any): ArrearsAging {
  return {
    rows: (r.rows ?? []).map((x: any) => ({
      tenant_id: x.tenantId,
      tenant_name: x.tenantName,
      phone: x.phone,
      property_id: x.propertyId ?? null,
      property_name: x.propertyName,
      balance: x.balance,
      open_count: x.openCount,
      oldest_month: x.oldestMonth,
      oldest_due_date: x.oldestDueDate,
      bucket: x.bucket,
    })),
    buckets: r.buckets ?? [],
    total_balance: r.totalBalance,
    tenants_in_arrears: r.tenantsInArrears,
  };
}

function toPaymentsBreakdown(r: any): PaymentsBreakdown {
  return {
    by_method: (r.byMethod ?? []).map((x: any) => ({
      method: x.method,
      total: x.total,
      count: x.count,
    })),
    total: r.total,
    count: r.count,
    rows: (r.rows ?? []).map((x: any) => ({
      receipt_no: x.receiptNo,
      paid_at: x.paidAt,
      tenant_name: x.tenantName,
      method: x.method,
      mpesa_code: x.mpesaCode ?? null,
      amount: x.amount,
      note: x.note ?? null,
      status: x.status ?? "active",
      allocation_summary: x.allocationSummary ?? null,
    })),
    truncated: r.truncated,
  };
}

function toMpesaHealth(r: any): MpesaHealth {
  return {
    by_status: (r.byStatus ?? []).map((x: any) => ({
      status: x.status,
      count: x.count,
      amount: x.amount,
    })),
    total: r.total,
    total_amount: r.totalAmount,
    success_rate: r.successRate,
    channels: (r.channels ?? []).map((x: any) => ({
      channel: x.channel,
      count: x.count,
      amount: x.amount,
    })),
  };
}

function toDailyClose(r: any): DailyClose {
  return {
    rows: (r.rows ?? []).map((x: any) => ({
      day: x.day,
      collected: x.collected,
      count: x.count,
      by_method: (x.byMethod ?? []).map((m: any) => ({
        method: m.method,
        total: m.total,
        count: m.count,
      })),
      by_recorder: (x.byRecorder ?? []).map((m: any) => ({
        recorder: m.recorder,
        total: m.total,
        count: m.count,
      })),
    })),
    total: r.total,
    count: r.count,
  };
}

function toAuditEvent(r: any): AuditEvent {
  return {
    id: r._id,
    created_at: iso(r._creationTime),
    actor: r.actorUserId ?? null,
    action: r.action,
    entity_type: r.entityType,
    entity_id: r.entityId ?? null,
    metadata: r.metadata ?? null,
  };
}

function toAlert(r: any): PaymentAlert {
  return {
    id: r._id,
    created_at: iso(r._creationTime),
    kind: r.kind,
    title: r.title,
    detail: r.detail ?? null,
    trans_id: r.transId ?? null,
    acknowledged: r.acknowledged,
  };
}

function toWebhookHit(r: any): WebhookHit {
  return {
    id: r._id,
    created_at: iso(r._creationTime),
    route: r.route,
    trans_id: r.transId ?? null,
    shortcode: r.shortcode ?? null,
    outcome: r.outcome,
    detail: r.detail ?? null,
    latency_ms: r.latencyMs ?? null,
  };
}

function toRiskReview(r: any): C2bRiskReview {
  return {
    risk: r.risk,
    checks: r.checks ?? [],
    prior_from_sender: r.priorFromSender ?? 0,
    avg_amount: r.avgAmount ?? 0,
  };
}

function toRentRoll(r: any): RentRoll {
  return {
    rows: (r.rows ?? []).map((x: any) => ({
      property_id: x.propertyId,
      property_name: x.propertyName,
      units: x.units,
      occupied: x.occupied,
      vacant: x.vacant,
      notice: x.notice,
      occupancy_pct: x.occupancyPct,
      monthly_rent: x.monthlyRent,
      occupied_rent: x.occupiedRent,
    })),
    totals: {
      units: r.totals.units,
      occupied: r.totals.occupied,
      vacant: r.totals.vacant,
      occupancy_pct: r.totals.occupancyPct,
      monthly_rent: r.totals.monthlyRent,
      occupied_rent: r.totals.occupiedRent,
    },
  };
}

function toDepositsAndCredits(r: any): DepositsAndCredits {
  return {
    deposit_held_total: r.depositHeldTotal,
    tenants_holding_deposit: r.tenantsHoldingDeposit,
    settled_deductions: r.settledDeductions,
    settled_refunds: r.settledRefunds,
    settlements_count: r.settlementsCount,
    credit_balance_total: r.creditBalanceTotal,
    tenants_with_credit: r.tenantsWithCredit,
  };
}

const reportsArgs = (orgId: string, extra: Record<string, unknown> = {}) => ({
  orgId,
  ...Object.fromEntries(
    Object.entries(extra).filter(([, v]) => v !== undefined && v !== "all"),
  ),
});

export async function getCollectionSummary(args: {
  orgId: string;
  startMonth: string;
  endMonth: string;
  propertyId?: string;
}): Promise<CollectionMonth[]> {
  try {
    const rows = (await convex.query(
      (api as any).reports.collectionSummary,
      reportsArgs(args.orgId, {
        startMonth: args.startMonth,
        endMonth: args.endMonth,
        propertyId: args.propertyId,
      }),
    )) as any[];
    return rows.map(toCollectionMonth);
  } catch (e) {
    return err(e);
  }
}

export async function getArrearsAging(args: {
  orgId: string;
  propertyId?: string;
}): Promise<ArrearsAging> {
  try {
    const row = (await convex.query(
      (api as any).reports.arrearsAging,
      reportsArgs(args.orgId, { propertyId: args.propertyId }),
    )) as any;
    return toArrearsAging(row);
  } catch (e) {
    return err(e);
  }
}

export async function getPaymentsBreakdown(args: {
  orgId: string;
  startMs: number;
  endMs: number;
  propertyId?: string;
}): Promise<PaymentsBreakdown> {
  try {
    const row = (await convex.query(
      (api as any).reports.paymentsBreakdown,
      reportsArgs(args.orgId, {
        startMs: args.startMs,
        endMs: args.endMs,
        propertyId: args.propertyId,
      }),
    )) as any;
    return toPaymentsBreakdown(row);
  } catch (e) {
    return err(e);
  }
}

export async function getMpesaHealth(args: {
  orgId: string;
  startMs: number;
  endMs: number;
}): Promise<MpesaHealth> {
  try {
    const row = (await convex.query((api as any).reports.mpesaHealth, {
      orgId: args.orgId,
      startMs: args.startMs,
      endMs: args.endMs,
    })) as any;
    return toMpesaHealth(row);
  } catch (e) {
    return err(e);
  }
}

export async function getRentRoll(args: {
  orgId: string;
  propertyId?: string;
}): Promise<RentRoll> {
  try {
    const row = (await convex.query(
      (api as any).reports.rentRoll,
      reportsArgs(args.orgId, { propertyId: args.propertyId }),
    )) as any;
    return toRentRoll(row);
  } catch (e) {
    return err(e);
  }
}

export async function getDepositsAndCredits(args: {
  orgId: string;
  propertyId?: string;
}): Promise<DepositsAndCredits> {
  try {
    const row = (await convex.query(
      (api as any).reports.depositsAndCredits,
      reportsArgs(args.orgId, { propertyId: args.propertyId }),
    )) as any;
    return toDepositsAndCredits(row);
  } catch (e) {
    return err(e);
  }
}

/** Single-month cash snapshot: same cash definition as Reports. */
export async function getMonthCashSnapshot(
  orgId: string,
  month: string,
): Promise<{ collected: number; expected: number; outstanding: number }> {
  try {
    const row = (await convex.query(
      (api as any).reports.monthCashSnapshot,
      { orgId, month },
    )) as any;
    return {
      collected: row.collected,
      expected: row.expected,
      outstanding: row.outstanding,
    };
  } catch (e) {
    return err(e);
  }
}

export async function getDailyClose(args: {
  orgId: string;
  startMs: number;
  endMs: number;
}): Promise<DailyClose> {
  try {
    const row = (await convex.query((api as any).reports.dailyClose, {
      orgId: args.orgId,
      startMs: args.startMs,
      endMs: args.endMs,
    })) as any;
    return toDailyClose(row);
  } catch (e) {
    return err(e);
  }
}

export async function getAuditTrail(
  orgId: string,
  action?: string,
): Promise<AuditEvent[]> {
  try {
    const rows = (await convex.query((api as any).reports.auditTrail, {
      orgId,
      action,
    })) as any[];
    return rows.map(toAuditEvent);
  } catch (e) {
    return err(e);
  }
}

export async function listAlerts(orgId: string): Promise<PaymentAlert[]> {
  try {
    const rows = (await convex.query((api as any).c2b.listAlerts, {
      orgId,
    })) as any[];
    return rows.map(toAlert);
  } catch (e) {
    return err(e);
  }
}

export async function acknowledgeAlert(id: string): Promise<void> {
  try {
    await convex.mutation((api as any).c2b.acknowledgeAlert, { id });
  } catch (e) {
    return err(e);
  }
}

export async function listWebhookLog(orgId: string): Promise<WebhookHit[]> {
  try {
    const rows = (await convex.query((api as any).c2b.listWebhookLog, {
      orgId,
    })) as any[];
    return rows.map(toWebhookHit);
  } catch (e) {
    return err(e);
  }
}

export async function verifyC2bTransaction(id: string): Promise<C2bRiskReview> {
  try {
    const row = (await convex.query((api as any).c2b.verifyC2bTransaction, {
      id,
    })) as any;
    return toRiskReview(row);
  } catch (e) {
    return err(e);
  }
}

export interface C2bSimulation {
  match: { tenant_name: string; reason: string } | null;
  preview: { month: string; balance: number; applied: number }[];
  leftover: number;
  suggestions: { tenant_name: string; score: number; signals: string[] }[];
}

/** Dry-run a Paybill confirmation: matching + split, nothing written. */
export async function simulateC2b(args: {
  orgId: string;
  billRef?: string;
  msisdn: string;
  amount: number;
}): Promise<C2bSimulation> {
  try {
    const row = (await convex.query((api as any).c2b.simulateC2b, {
      orgId: args.orgId,
      billRef: args.billRef,
      msisdn: args.msisdn,
      amount: args.amount,
    })) as any;
    return {
      match: row.match
        ? { tenant_name: row.match.tenantName, reason: row.match.reason }
        : null,
      preview: (row.preview ?? []).map((p: any) => ({
        month: p.month,
        balance: p.balance,
        applied: p.applied,
      })),
      leftover: row.leftover ?? 0,
      suggestions: (row.suggestions ?? []).map((s: any) => ({
        tenant_name: s.tenantName,
        score: s.score,
        signals: s.signals ?? [],
      })),
    };
  } catch (e) {
    return err(e);
  }
}
