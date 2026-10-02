import type {
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
import type { Allocation as SharedAllocation } from "@kodi/shared";

export type { InvoiceLines };
export type Allocation = SharedAllocation;

export interface Org {
  id: string;
  name: string;
  plan_code: PlanCode;
  subscription_status: SubscriptionStatus;
  subscription_period_end: string | null;
  invoice_due_day: number;
  /** Reversals at or above this KES need the owner (0 = gate disabled). */
  reversal_limit: number | null;
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
  /** Stable Paybill account code — required since the creation invariant. */
  account_code: string;
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

export type PaymentStatus = "active" | "voided" | "refunded";

export interface AllocationWithMonth extends SharedAllocation {
  month?: string;
}

export interface Payment {
  id: string;
  org_id: string;
  tenant_id: string;
  amount: number;
  method: PaymentMethod;
  mpesa_code: string | null;
  paid_at: string;
  allocations: AllocationWithMonth[];
  receipt_no: string;
  recorded_by: string | null;
  note: string | null;
  status: PaymentStatus;
  checkout_request_id: string | null;
  leftover_credit: number;
  reversed_at: string | null;
  reverse_reason: string | null;
}

export interface PaymentRecordResult {
  id: string;
  allocations: AllocationWithMonth[];
  leftover_credit: number;
  credit_used: number;
}

export interface AllocationPreviewRow {
  invoiceId: string;
  month: string;
  total: number;
  balance: number;
  applied: number;
}

export interface AllocationPreview {
  allocations: AllocationPreviewRow[];
  leftover: number;
}

export type CreditLedgerKind = "created" | "applied" | "reversed";

export interface CreditLedgerEntry {
  id: string;
  kind: CreditLedgerKind;
  amount: number;
  balance_after: number;
  payment_id: string | null;
  note: string | null;
  created_at: string;
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

export type C2bStatus = "pending_review" | "matched" | "rejected";

export interface C2bPayment {
  id: string;
  org_id: string;
  tenant_id: string | null;
  tenant_name: string | null;
  trans_id: string;
  amount: number;
  bill_ref: string | null;
  msisdn: string;
  sender_name: string | null;
  trans_time: string | null;
  status: C2bStatus;
  match_reason: string | null;
  payment_id: string | null;
  created_at: string;
}

export interface C2bSuggestion {
  tenant_id: string;
  tenant_name: string;
  phone: string;
  account_code: string | null;
  score: number;
  signals: string[];
}

export interface PaybillInfo {
  shortcode: string;
  account_code: string;
  registered: boolean;
}

export interface C2bStatusView {
  configured: boolean;
  shortcode: string;
  registered: boolean;
  registered_at: string | null;
}

// ---------------------------------------------------------------------------
// Extended Daraja tracks (verify / payouts / billmanager / collect /
// bonga). Backend: convex/{verify,payouts,billManager,
// collect,bonga}.ts
// ---------------------------------------------------------------------------
export type DarajaJobKind =
  | "txn_status"
  | "balance"
  | "reversal"
  | "b2c"
  | "topup"
  | "b2b"
  | "tax"
  | "pull";

export type DarajaJobStatus = "pending" | "done" | "failed";

export interface DarajaJob {
  id: string;
  org_id: string;
  kind: DarajaJobKind;
  conversation_id: string;
  status: DarajaJobStatus;
  request_summary?: string | null;
  result_code?: string | null;
  result_desc?: string | null;
  payment_id?: string | null;
  tenant_id?: string | null;
  amount?: number | null;
  created_at: string;
}

export interface InitiatorStatusView {
  configured: boolean;
  initiator_name: string;
  cert_subject?: string | null;
  cert_expired?: boolean | null;
}

export interface BalanceSnapshot {
  balances: { account: string; balance: number }[];
  conversation_id?: string | null;
}

export interface StatusLookup {
  status: string;
  result_code?: string | null;
  result_desc?: string | null;
  conversation_id: string;
}

export interface SettlementPayout {
  b2c_status?: string | null;
  b2c_conversation_id?: string | null;
  b2c_receipt?: string | null;
}

export interface BillManagerState {
  opted_in: boolean;
  email?: string | null;
  last_mirrored_at?: string | null;
  seen_count: number;
}

export interface InvoiceQr {
  qr_base64: string;
  amount: number;
  ref_no: string;
}

export interface ShortcodeCheck {
  org_name?: string | null;
  tariff?: string | null;
  raw: string;
}

export interface BongaQuote {
  points: number;
  value_kes: number;
  raw: string;
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
  account_code: string;
  property_id: string | null;
  property_name: string;
  balance: number;
  open_count: number;
  oldest_month: string;
  oldest_due_date: string;
  bucket: AgingBucket;
  last_payment_at: string | null;
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
  status: string;
  allocation_summary: string | null;
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
  channels: { channel: string; count: number; amount: number }[];
}

export interface DailyCloseRow {
  day: string;
  collected: number;
  count: number;
  by_method: { method: string; total: number; count: number }[];
  by_recorder: { recorder: string; total: number; count: number }[];
}

export interface DailyClose {
  rows: DailyCloseRow[];
  total: number;
  count: number;
}

export interface AuditEvent {
  id: string;
  created_at: string;
  actor: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: string | null;
}

export interface PaymentAlert {
  id: string;
  created_at: string;
  kind: string;
  title: string;
  detail: string | null;
  trans_id: string | null;
  acknowledged: boolean;
}

export interface WebhookHit {
  id: string;
  created_at: string;
  route: string;
  trans_id: string | null;
  shortcode: string | null;
  outcome: string;
  detail: string | null;
  latency_ms: number | null;
}

export interface C2bRiskReview {
  risk: "low" | "medium" | "high";
  checks: string[];
  prior_from_sender: number;
  avg_amount: number;
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

export interface PropertyCollectionRow {
  property_id: string | null;
  property_name: string;
  units: number;
  occupied: number;
  expected: number;
  collected: number;
  outstanding: number;
  rate: number;
  invoice_count: number;
}

export interface PaymentTimelinessRow {
  tenant_id: string;
  tenant_name: string;
  paid_count: number;
  on_time_count: number;
  late_count: number;
  avg_days_late: number;
  worst_days_late: number;
}

export interface PaymentTimeliness {
  paid_invoices: number;
  on_time_rate: number;
  avg_days_late: number;
  rows: PaymentTimelinessRow[];
}
