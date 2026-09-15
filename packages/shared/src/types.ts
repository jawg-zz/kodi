export type PlanCode = "starter" | "growth" | "pro";
export type SubscriptionStatus = "trialing" | "active" | "past_due";
export type OrgRole = "owner" | "manager";

export type PropertyType =
  | "apartments"
  | "bedsitters"
  | "single_rooms"
  | "mixed"
  | "commercial";

export type UnitType =
  | "bedsitter"
  | "single"
  | "one_br"
  | "two_br"
  | "three_br"
  | "shop"
  | "other";

export type UnitStatus = "vacant" | "occupied" | "notice";
export type TenantStatus = "active" | "notice" | "moved_out";
export type InvoiceStatus = "unpaid" | "partial" | "paid";
export type PaymentMethod = "mpesa_stk" | "mpesa_manual" | "cash" | "bank";
export type MpesaTxStatus = "pending" | "success" | "failed" | "timeout";

export interface InvoiceLines {
  rent: number;
  water: number;
  garbage: number;
  other: number;
}

export interface Allocation {
  invoiceId: string;
  amount: number;
}

export interface Plan {
  code: PlanCode;
  name: string;
  maxUnits: number;
  priceKes: number;
}

export const PLANS: Plan[] = [
  { code: "starter", name: "Starter", maxUnits: 10, priceKes: 0 },
  { code: "growth", name: "Growth", maxUnits: 50, priceKes: 1500 },
  { code: "pro", name: "Pro", maxUnits: 200, priceKes: 4000 },
];

export function planByCode(code: string): Plan {
  return PLANS.find((p) => p.code === code) ?? PLANS[0];
}
