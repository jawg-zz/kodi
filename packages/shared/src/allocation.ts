import type { Allocation } from "./types";

export interface OpenInvoice {
  id: string;
  /** Month key "YYYY-MM" — allocation is oldest month first. */
  month: string;
  /** Remaining unpaid amount in whole KES. */
  balance: number;
}

export interface AllocationResult {
  allocations: Allocation[];
  /** Amount that could not be applied to any open invoice (credit / overpayment). */
  leftover: number;
}

/**
 * Applies `amount` to the tenant's open invoices, oldest month first.
 * Mirrors the SQL function `allocate_payment_fifo` — SQL is the runtime source
 * of truth; this powers previews and tests.
 */
export function allocateFifo(
  invoices: OpenInvoice[],
  amount: number
): AllocationResult {
  const sorted = [...invoices]
    .filter((i) => i.balance > 0)
    .sort((a, b) => a.month.localeCompare(b.month));
  let remaining = Math.max(0, Math.round(amount));
  const allocations: Allocation[] = [];
  for (const inv of sorted) {
    if (remaining <= 0) break;
    const applied = Math.min(remaining, inv.balance);
    allocations.push({ invoiceId: inv.id, amount: applied });
    remaining -= applied;
  }
  return { allocations, leftover: remaining };
}
