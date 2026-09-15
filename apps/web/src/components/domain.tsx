import { formatKES } from "@kodi/shared";
import type { InvoiceLines, InvoiceStatus } from "@kodi/shared";
import { Badge } from "./ui";

export function Money({ value, className = "" }: { value: number; className?: string }) {
  return <span className={className}>{formatKES(value)}</span>;
}

const statusTone: Record<InvoiceStatus, "green" | "amber" | "red"> = {
  paid: "green",
  partial: "amber",
  unpaid: "red",
};

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const label = status === "paid" ? "Paid" : status === "partial" ? "Partial" : "Unpaid";
  return <Badge tone={statusTone[status]}>{label}</Badge>;
}

export function LinesBreakdown({ lines }: { lines: InvoiceLines }) {
  const parts: [string, number][] = [
    ["Rent", lines.rent],
    ["Water", lines.water],
    ["Garbage", lines.garbage],
    ["Other", lines.other],
  ];
  const shown = parts.filter(([, v]) => v > 0);
  if (shown.length === 0) return <span className="text-slate-400">—</span>;
  return (
    <span className="text-xs text-slate-500">
      {shown.map(([label, v]) => `${label} ${formatKES(v)}`).join(" · ")}
    </span>
  );
}

const unitTypeLabels: Record<string, string> = {
  bedsitter: "Bedsitter",
  single: "Single room",
  one_br: "1 bedroom",
  two_br: "2 bedroom",
  three_br: "3 bedroom",
  shop: "Shop",
  other: "Other",
};

export function unitTypeLabel(t: string): string {
  return unitTypeLabels[t] ?? t;
}

const unitStatusTone: Record<string, "green" | "amber" | "slate"> = {
  occupied: "green",
  notice: "amber",
  vacant: "slate",
};

export function UnitStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={unitStatusTone[status] ?? "slate"}>
      {status === "occupied" ? "Occupied" : status === "notice" ? "On notice" : "Vacant"}
    </Badge>
  );
}

const paymentMethodLabels: Record<string, string> = {
  mpesa_stk: "M-Pesa (STK)",
  mpesa_manual: "M-Pesa (manual)",
  cash: "Cash",
  bank: "Bank",
};

export function paymentMethodLabel(m: string): string {
  return paymentMethodLabels[m] ?? m;
}
