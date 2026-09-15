import { supabase } from "./supabase";
import type {
  DepositSettlement,
  Invoice,
  InvoiceWithRefs,
  MpesaTransaction,
  Org,
  PaymentWithRefs,
  Property,
  Tenant,
  TenantUserLink,
  Unit,
  UnitWithTenant,
} from "./types";

function friendlyDbError(error: { message: string; code?: string }): never {
  const msg = error.message;
  if (error.code === "23505" || msg.includes("duplicate key")) {
    if (msg.includes("tenants") || msg.includes("idx_tenants_org_phone")) {
      throw new Error("A tenant with this phone number already exists in your business.");
    }
    if (msg.includes("units")) {
      throw new Error("A unit with this label already exists in this property.");
    }
    if (msg.includes("tenant_users")) {
      throw new Error("This tenant already has a portal login.");
    }
    throw new Error("This record already exists.");
  }
  if (msg.includes("Unit limit reached")) {
    throw new Error(msg);
  }
  throw new Error(msg);
}

function boom(error: { message: string; code?: string } | null): void {
  if (error) friendlyDbError(error);
}

// ---------------------------------------------------------------------------
// Properties & units
// ---------------------------------------------------------------------------
export async function listProperties(orgId: string): Promise<Property[]> {
  const { data, error } = await supabase
    .from("properties")
    .select("*")
    .eq("org_id", orgId)
    .order("name");
  boom(error);
  return (data ?? []) as Property[];
}

export async function listUnits(orgId: string): Promise<UnitWithTenant[]> {
  const { data, error } = await supabase
    .from("units")
    .select("*, tenant:tenants!units_current_tenant_fkey(id, full_name, phone, status, deposit_held)")
    .eq("org_id", orgId)
    .order("label");
  boom(error);
  return (data ?? []) as unknown as UnitWithTenant[];
}

export async function countUnits(orgId: string): Promise<number> {
  const { count, error } = await supabase
    .from("units")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId);
  boom(error);
  return count ?? 0;
}

export async function createProperty(
  orgId: string,
  values: Pick<Property, "name" | "property_type" | "location" | "notes">
): Promise<Property> {
  const { data, error } = await supabase
    .from("properties")
    .insert({ ...values, org_id: orgId })
    .select("*")
    .single();
  boom(error);
  return data as Property;
}

export async function updateProperty(id: string, values: Partial<Property>): Promise<void> {
  const { error } = await supabase.from("properties").update(values).eq("id", id);
  boom(error);
}

export async function deleteProperty(id: string): Promise<void> {
  const { error } = await supabase.from("properties").delete().eq("id", id);
  boom(error);
}

export async function createUnit(
  orgId: string,
  values: Omit<Unit, "id" | "org_id" | "status" | "current_tenant_id">
): Promise<Unit> {
  const { data, error } = await supabase
    .from("units")
    .insert({ ...values, org_id: orgId })
    .select("*")
    .single();
  boom(error);
  return data as Unit;
}

export async function updateUnit(id: string, values: Partial<Unit>): Promise<void> {
  const { error } = await supabase.from("units").update(values).eq("id", id);
  boom(error);
}

export async function deleteUnit(id: string): Promise<void> {
  const { error } = await supabase.from("units").delete().eq("id", id);
  boom(error);
}

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------
export async function listTenants(orgId: string): Promise<Tenant[]> {
  const { data, error } = await supabase
    .from("tenants")
    .select("*")
    .eq("org_id", orgId)
    .order("full_name");
  boom(error);
  return (data ?? []) as Tenant[];
}

export async function getTenant(id: string): Promise<Tenant | null> {
  const { data, error } = await supabase
    .from("tenants")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  boom(error);
  return (data as Tenant) ?? null;
}

export async function createTenant(
  orgId: string,
  values: Omit<Tenant, "id" | "org_id" | "status" | "notes"> & { notes?: string }
): Promise<Tenant> {
  const { data, error } = await supabase
    .from("tenants")
    .insert({ ...values, org_id: orgId })
    .select("*")
    .single();
  boom(error);
  return data as Tenant;
}

export async function updateTenant(id: string, values: Partial<Tenant>): Promise<void> {
  const { error } = await supabase.from("tenants").update(values).eq("id", id);
  boom(error);
}

export async function deleteTenant(id: string): Promise<void> {
  const { error } = await supabase.from("tenants").delete().eq("id", id);
  boom(error);
}

export async function getTenantPortalLink(tenantId: string): Promise<TenantUserLink | null> {
  const { data, error } = await supabase
    .from("tenant_users")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  boom(error);
  return (data as TenantUserLink) ?? null;
}

export async function settleDeposit(
  orgId: string,
  tenant: Tenant,
  deductions: { label: string; amount: number }[],
  refund: number,
  notes: string | null
): Promise<DepositSettlement> {
  const userId = (await supabase.auth.getUser()).data.user?.id ?? null;
  const totalDeductions = deductions.reduce((s, d) => s + d.amount, 0);
  const { data, error } = await supabase
    .from("deposit_settlements")
    .insert({
      org_id: orgId,
      tenant_id: tenant.id,
      deposit_held: tenant.deposit_held,
      deductions,
      total_deductions: totalDeductions,
      refund_amount: refund,
      notes,
      settled_by: userId,
    })
    .select("*")
    .single();
  boom(error);
  await updateTenant(tenant.id, { status: "moved_out" });
  return data as DepositSettlement;
}

export async function listSettlements(orgId: string): Promise<DepositSettlement[]> {
  const { data, error } = await supabase
    .from("deposit_settlements")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });
  boom(error);
  return (data ?? []) as DepositSettlement[];
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------
export async function listInvoices(orgId: string, month?: string): Promise<InvoiceWithRefs[]> {
  let query = supabase
    .from("invoices")
    .select("*, tenant:tenants(id, full_name, phone), unit:units(label)")
    .eq("org_id", orgId)
    .order("due_date", { ascending: false });
  if (month) query = query.eq("month", month);
  const { data, error } = await query;
  boom(error);
  return (data ?? []) as unknown as InvoiceWithRefs[];
}

export async function listTenantInvoices(tenantId: string): Promise<InvoiceWithRefs[]> {
  const { data, error } = await supabase
    .from("invoices")
    .select("*, unit:units(label)")
    .eq("tenant_id", tenantId)
    .order("month", { ascending: false });
  boom(error);
  return (data ?? []) as unknown as InvoiceWithRefs[];
}

export async function generateInvoices(orgId: string, month: string): Promise<number> {
  const { data, error } = await supabase.rpc("generate_monthly_invoices", {
    p_org: orgId,
    p_month: month,
  });
  boom(error);
  return (data as number) ?? 0;
}

export async function updateInvoice(id: string, values: Partial<Invoice>): Promise<void> {
  const { error } = await supabase.from("invoices").update(values).eq("id", id);
  boom(error);
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
export async function listPayments(orgId: string, tenantId?: string): Promise<PaymentWithRefs[]> {
  let query = supabase
    .from("payments")
    .select("*, tenant:tenants(id, full_name)")
    .eq("org_id", orgId)
    .order("paid_at", { ascending: false })
    .limit(500);
  if (tenantId) query = query.eq("tenant_id", tenantId);
  const { data, error } = await query;
  boom(error);
  return (data ?? []) as unknown as PaymentWithRefs[];
}

export async function listTenantPayments(tenantId: string): Promise<PaymentWithRefs[]> {
  const { data, error } = await supabase
    .from("payments")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("paid_at", { ascending: false });
  boom(error);
  return (data ?? []) as unknown as PaymentWithRefs[];
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
  const { data, error } = await supabase.rpc("record_payment", {
    p_org: args.orgId,
    p_tenant: args.tenantId,
    p_amount: args.amount,
    p_method: args.method,
    p_mpesa_code: args.mpesaCode,
    p_paid_at: args.paidAt,
    p_note: args.note,
    p_recorded_by: (await supabase.auth.getUser()).data.user?.id ?? null,
  });
  boom(error);
  return data as string;
}

export async function getPayment(id: string): Promise<PaymentWithRefs | null> {
  const { data, error } = await supabase
    .from("payments")
    .select("*, tenant:tenants(id, full_name, phone, unit_id)")
    .eq("id", id)
    .maybeSingle();
  boom(error);
  return (data as unknown as PaymentWithRefs) ?? null;
}

// ---------------------------------------------------------------------------
// M-Pesa STK (edge functions)
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Invoke an edge function with one retry. Cold starts and transient network
 * blips surface as "Failed to send a request to the Edge Function" — a
 * single retry a few seconds later almost always succeeds.
 */
async function invokeFn<T>(name: string, body: unknown, retries = 1): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(2500);
    try {
      const { data, error } = await supabase.functions.invoke(name, { body });
      if (error) {
        // Function responded with an error payload — no point retrying 4xx.
        throw new Error(error.message);
      }
      return data as T;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      // Retry only network-level failures, not function logic errors.
      if (!/failed to send a request|network|fetch|timeout|econn/i.test(msg)) throw e;
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `Could not reach the ${name} service (${msg}). Check your connection and try again.`
  );
}

export async function stkInitiate(args: {
  tenantId: string;
  phone: string;
  amount: number;
}): Promise<{ checkoutRequestId: string }> {
  return invokeFn("stk-initiate", args);
}

export async function stkStatus(
  checkoutRequestId: string
): Promise<MpesaTransaction> {
  // Poll path already retries on a timer — no extra retry here.
  const { data, error } = await supabase.functions.invoke("stk-status", {
    body: { checkoutRequestId },
  });
  if (error) throw new Error(error.message);
  return data as MpesaTransaction;
}

export async function listMpesaTransactions(orgId: string): Promise<MpesaTransaction[]> {
  const { data, error } = await supabase
    .from("mpesa_transactions")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(100);
  boom(error);
  return (data ?? []) as MpesaTransaction[];
}

// ---------------------------------------------------------------------------
// Org / settings
// ---------------------------------------------------------------------------
export async function updateOrg(id: string, values: Partial<Org>): Promise<void> {
  const { error } = await supabase.from("orgs").update(values).eq("id", id);
  boom(error);
}

export async function createOrg(name: string, planCode: string): Promise<Org> {
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) throw new Error("You must be signed in to create an organization.");
  const profile = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", user.user.id)
    .maybeSingle();
  const { data, error } = await supabase.rpc("create_org_with_owner", {
    p_name: name,
    p_plan_code: planCode,
    p_full_name:
      (profile.data as { full_name?: string } | null)?.full_name ??
      (user.user.user_metadata?.full_name as string | undefined) ??
      "",
    p_phone: (user.user.user_metadata?.phone as string | undefined) ?? null,
  });
  boom(error);
  return data as unknown as Org;
}

export interface InviteResult {
  email: string;
  tempPassword: string | null;
  invited: boolean;
}

export async function inviteUser(args: {
  email: string;
  fullName: string;
  phone: string;
  kind: "tenant" | "manager";
  tenantId?: string;
}): Promise<InviteResult> {
  return invokeFn("invite-user", args);
}

export async function listStaff(orgId: string): Promise<{ user_id: string; role: string; name: string }[]> {
  const { data, error } = await supabase.rpc("list_staff_members", {
    p_org: orgId,
  });
  boom(error);
  return ((data ?? []) as { user_id: string; role: string; full_name: string }[]).map((r) => ({
    user_id: r.user_id,
    role: r.role,
    name: r.full_name || "(no profile)",
  }));
}

// ---------------------------------------------------------------------------
// M-Pesa credentials (via edge function; never direct DB access)
// ---------------------------------------------------------------------------
export interface MpesaCredsView {
  configured: boolean;
  environment: "sandbox" | "production";
  shortcode: string;
}

export async function getMpesaCreds(): Promise<MpesaCredsView> {
  return invokeFn("mpesa-credentials", { action: "get" });
}

export async function saveMpesaCreds(values: {
  environment: "sandbox" | "production";
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
}): Promise<void> {
  await invokeFn<unknown>("mpesa-credentials", { action: "save", ...values });
}
