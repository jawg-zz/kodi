import { convex } from "./convex";
import { api } from "../../../../convex/_generated/api";
import type {
  ArrearsAging,
  CollectionMonth,
  DepositSettlement,
  DepositsAndCredits,
  Invoice,
  InvoiceWithRefs,
  MpesaHealth,
  MpesaTransaction,
  Org,
  PaymentsBreakdown,
  PaymentWithRefs,
  Property,
  RentRoll,
  Tenant,
  TenantUserLink,
  Unit,
  UnitWithTenant,
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
    })),
    receipt_no: r.receiptNo,
    recorded_by: r.recordedBy ?? null,
    note: r.note ?? null,
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
  values: Omit<Tenant, "id" | "org_id" | "status" | "notes"> & {
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
    await convex.mutation((api as any).invoices.updateInvoice, {
      id,
      notes: (values as any).notes ?? undefined,
      dueDate: (values as any).due_date,
      total: values.total,
      balance: values.balance,
      status: values.status,
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
}): Promise<string> {
  try {
    return (await convex.mutation(
      (api as any).payments.recordManualPayment,
      {
        orgId: args.orgId,
        tenantId: args.tenantId,
        amount: args.amount,
        method: args.method,
        mpesaCode: args.mpesaCode,
        paidAt: new Date(args.paidAt).getTime(),
        note: args.note,
      },
    )) as string;
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
