import type {
  Allocation,
  InvoiceLines,
  InvoiceStatus,
  OrgRole,
  PaymentMethod,
  PlanCode,
  PropertyType,
  SubscriptionStatus,
  TenantStatus,
  UnitStatus,
  UnitType,
} from "@kodi/shared";

export type { Allocation, InvoiceLines };

export interface Org {
  id: string;
  name: string;
  plan_code: PlanCode;
  subscription_status: SubscriptionStatus;
  subscription_period_end: string | null;
  invoice_due_day: number;
  created_at: string;
}

export interface OrgMember {
  org_id: string;
  user_id: string;
  role: OrgRole;
}

export interface Profile {
  id: string;
  full_name: string;
  phone: string | null;
}

export interface Property {
  id: string;
  org_id: string;
  name: string;
  property_type: PropertyType;
  location: string;
  notes: string | null;
  created_at: string;
}

export interface Unit {
  id: string;
  org_id: string;
  property_id: string;
  label: string;
  unit_type: UnitType;
  rent_amount: number;
  water_charge: number;
  garbage_charge: number;
  status: UnitStatus;
  current_tenant_id: string | null;
}

export interface Tenant {
  id: string;
  org_id: string;
  full_name: string;
  phone: string;
  national_id: string;
  unit_id: string | null;
  move_in_date: string | null;
  deposit_held: number;
  status: TenantStatus;
  notes: string | null;
}

export interface Invoice {
  id: string;
  org_id: string;
  tenant_id: string;
  unit_id: string | null;
  month: string;
  lines: InvoiceLines;
  total: number;
  due_date: string;
  status: InvoiceStatus;
  balance: number;
  notes: string | null;
}

export interface Payment {
  id: string;
  org_id: string;
  tenant_id: string;
  amount: number;
  method: PaymentMethod;
  mpesa_code: string | null;
  paid_at: string;
  allocations: Allocation[];
  receipt_no: string;
  recorded_by: string | null;
  note: string | null;
}

export interface MpesaTransaction {
  id: string;
  org_id: string;
  tenant_id: string;
  checkout_request_id: string;
  merchant_request_id: string | null;
  phone: string;
  amount: number;
  status: "pending" | "success" | "failed" | "timeout";
  result_code: number | null;
  result_desc: string | null;
  mpesa_receipt: string | null;
  payment_id: string | null;
  created_at: string;
}

export interface DepositSettlement {
  id: string;
  org_id: string;
  tenant_id: string;
  deposit_held: number;
  deductions: { label: string; amount: number }[];
  total_deductions: number;
  refund_amount: number;
  notes: string | null;
  created_at: string;
}

export interface TenantUserLink {
  tenant_id: string;
  user_id: string;
}

export type UnitWithTenant = Unit & { tenant: Tenant | null };
export type InvoiceWithRefs = Invoice & { tenant: Tenant | null; unit: Unit | null };
export type PaymentWithRefs = Payment & { tenant: Tenant | null };

// ---------------------------------------------------------------------------
// Server-aggregated reports (convex/reports.ts)
// ---------------------------------------------------------------------------
export type AgingBucket = "Current" | "30+" | "60+" | "90+";

export interface CollectionMonth {
  month: string;
  expected: number;
  collected: number;
  outstanding: number;
  rate: number;
  invoice_count: number;
}

export interface ArrearsRow {
  tenant_id: string;
  tenant_name: string;
  phone: string;
  property_id: string | null;
  property_name: string;
  balance: number;
  open_count: number;
  oldest_month: string;
  oldest_due_date: string;
  bucket: AgingBucket;
}

export interface ArrearsAging {
  rows: ArrearsRow[];
  buckets: { bucket: AgingBucket; balance: number; count: number }[];
  total_balance: number;
  tenants_in_arrears: number;
}

export interface MethodTotal {
  method: string;
  total: number;
  count: number;
}

export interface ReportPaymentRow {
  receipt_no: string;
  paid_at: number;
  tenant_name: string;
  method: string;
  mpesa_code: string | null;
  amount: number;
  note: string | null;
}

export interface PaymentsBreakdown {
  by_method: MethodTotal[];
  total: number;
  count: number;
  rows: ReportPaymentRow[];
  truncated: boolean;
}

export interface MpesaHealth {
  by_status: { status: string; count: number; amount: number }[];
  total: number;
  total_amount: number;
  success_rate: number;
}

export interface RentRollRow {
  property_id: string;
  property_name: string;
  units: number;
  occupied: number;
  vacant: number;
  notice: number;
  occupancy_pct: number;
  monthly_rent: number;
  occupied_rent: number;
}

export interface RentRoll {
  rows: RentRollRow[];
  totals: {
    units: number;
    occupied: number;
    vacant: number;
    occupancy_pct: number;
    monthly_rent: number;
    occupied_rent: number;
  };
}

export interface DepositsAndCredits {
  deposit_held_total: number;
  tenants_holding_deposit: number;
  settled_deductions: number;
  settled_refunds: number;
  settlements_count: number;
  credit_balance_total: number;
  tenants_with_credit: number;
}
