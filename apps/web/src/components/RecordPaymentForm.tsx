import { useEffect, useState } from "react";
import { formatKES, monthLabel, normalizeMpesaCode, parseKES } from "@kodi/shared";
import {
  getTenantCredit,
  listTenantInvoices,
  previewAllocation,
  recordManualPayment,
} from "../lib/api";
import type { AllocationPreview, InvoiceWithRefs } from "../lib/types";
import { Button } from "./Button";
import { Field, Input, Select } from "./Field";
import { ErrorBanner } from "./ui";
import { Money } from "./domain";

export type ManualMethod = "mpesa_manual" | "cash" | "bank";

/**
 * Shared record-payment form: allocation preview, per-invoice targeting,
 * held-credit spend, and overpayment warning. Used by the Payments page
 * (any tenant) and the tenant detail page (fixed tenant).
 */
export function RecordPaymentFields({ orgId, tenantId, suggested, presetTargets, onDone }: {
  orgId: string;
  tenantId: string;
  suggested: number;
  /** Pre-checked invoice targets (e.g. "pay this invoice" from Invoices). */
  presetTargets?: string[];
  onDone: () => Promise<void>;
}) {
  const [amount, setAmount] = useState(suggested ? String(suggested) : "");
  const [method, setMethod] = useState<ManualMethod>("mpesa_manual");
  const [mpesaCode, setMpesaCode] = useState("");
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [targets, setTargets] = useState<string[]>(presetTargets ?? []);
  const [useCredit, setUseCredit] = useState(false);
  const [invoices, setInvoices] = useState<InvoiceWithRefs[]>([]);
  const [credit, setCredit] = useState(0);
  const [preview, setPreview] = useState<AllocationPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Open-invoice context for targeting + credit. Fail-open: the form still
  // records FIFO when the context reads fail.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [inv, c] = await Promise.all([
          listTenantInvoices(tenantId),
          getTenantCredit(tenantId),
        ]);
        if (!alive) return;
        setInvoices(inv.filter((i) => i.balance > 0));
        setCredit(c);
      } catch {
        if (!alive) return;
        setInvoices([]);
        setCredit(0);
      }
    })();
    return () => {
      alive = false;
    };
  }, [tenantId]);

  // Live FIFO preview, debounced. Targeting changes the final split, so the
  // preview is labeled FIFO-only when targets are picked.
  useEffect(() => {
    const value = parseKES(amount);
    if (value === null || value < 1 || !tenantId) {
      setPreview(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const p = await previewAllocation(tenantId, value);
        if (alive) setPreview(p);
      } catch {
        if (alive) setPreview(null);
      }
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [amount, tenantId]);

  const openTotal = invoices.reduce((s, i) => s + i.balance, 0);
  const parsed = parseKES(amount);
  const overpay = parsed !== null && openTotal > 0 && parsed > openTotal + credit;

  const toggleTarget = (id: string) => {
    setTargets((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    );
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = parseKES(amount);
    if (value === null || value < 1) {
      setError("Enter a valid amount in KES.");
      return;
    }
    const code = normalizeMpesaCode(mpesaCode);
    if (method === "mpesa_manual" && !code) {
      setError("Enter the M-Pesa transaction code from the confirmation SMS (e.g. SLJ7XK2M9P).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await recordManualPayment({
        orgId,
        tenantId,
        amount: value,
        method,
        mpesaCode: method === "mpesa_manual" ? code : null,
        paidAt: new Date(paidAt || Date.now()).toISOString(),
        note: note.trim() || null,
        targets: targets.length > 0 ? targets : undefined,
        useCredit: credit > 0 ? useCredit : false,
      });
      if (res.leftover_credit > 0 || res.credit_used > 0) {
        // Keep the outcome visible — the page reloads underneath.
      }
      await onDone();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(/already exists|duplicate/i.test(msg)
        ? "This M-Pesa code was already recorded. Check Payments before retrying."
        : msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Amount (KES)" required>
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" required />
        </Field>
        <Field label="Method">
          <Select value={method} onChange={(e) => setMethod(e.target.value as ManualMethod)}>
            <option value="mpesa_manual">M-Pesa (transaction code)</option>
            <option value="cash">Cash</option>
            <option value="bank">Bank transfer</option>
          </Select>
        </Field>
      </div>
      {method === "mpesa_manual" && (
        <Field label="M-Pesa transaction code" required hint="From the tenant's confirmation SMS.">
          <Input value={mpesaCode} onChange={(e) => setMpesaCode(e.target.value.toUpperCase())} placeholder="SLJ7XK2M9P" />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-4">
        <Field label="Date received">
          <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
        </Field>
        <Field label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
        </Field>
      </div>

      {credit > 0 && (
        <label className="flex items-start gap-2 rounded-lg border border-brand-100 bg-brand-50/50 p-3 text-sm">
          <input
            type="checkbox"
            checked={useCredit}
            onChange={(e) => setUseCredit(e.target.checked)}
            className="mt-1"
          />
          <span>
            Spend <Money value={credit} className="font-semibold" /> prepaid credit first.
            <span className="block text-xs text-slate-500">
              Credit settles the oldest invoices before this cash is applied.
            </span>
          </span>
        </label>
      )}

      {invoices.length > 1 && (
        <Field
          label="Pay specific invoices first (optional)"
          hint="Checked months are settled before the oldest-first remainder."
        >
          <div className="space-y-1 rounded-lg border border-slate-200 p-2">
            {invoices.map((i) => (
              <label key={i.id} className="flex items-center justify-between gap-2 px-1 py-1 text-sm">
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={targets.includes(i.id)}
                    onChange={() => toggleTarget(i.id)}
                  />
                  {monthLabel(i.month)}
                </span>
                <Money value={i.balance} className="text-slate-500" />
              </label>
            ))}
          </div>
        </Field>
      )}

      {preview && parsed !== null && parsed >= 1 && (
        <div className="rounded-lg bg-slate-50 p-3 text-sm">
          <p className="mb-1 font-medium text-slate-700">
            {targets.length > 0 ? "Oldest-first remainder (targets apply first)" : "This payment will"}
          </p>
          {preview.allocations.length === 0 ? (
            <p className="text-slate-500">
              Held as <Money value={preview.leftover} className="font-semibold" /> prepaid credit — no open invoices.
            </p>
          ) : (
            <ul className="space-y-1">
              {preview.allocations.map((a) => (
                <li key={a.invoiceId} className="flex justify-between">
                  <span>{monthLabel(a.month)}</span>
                  <Money value={a.applied} />
                </li>
              ))}
              {preview.leftover > 0 && (
                <li className="flex justify-between text-brand-700">
                  <span>Prepaid credit</span>
                  <Money value={preview.leftover} className="font-semibold" />
                </li>
              )}
            </ul>
          )}
        </div>
      )}

      {overpay && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          This is {formatKES(parsed - openTotal - credit)} more than owed
          {credit > 0 && !useCredit ? " (plus unspent credit)" : ""} — the
          excess is kept as prepaid credit for the next invoice.
        </div>
      )}

      {!overpay && (
        <p className="text-xs text-slate-500">
          The payment applies to the oldest unpaid invoice first; any remainder is kept as prepaid
          credit and applies automatically to the next invoice.
        </p>
      )}
      {error && <ErrorBanner message={error} />}
      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={busy}>{busy ? "Recording…" : "Record payment"}</Button>
      </div>
    </form>
  );
}
