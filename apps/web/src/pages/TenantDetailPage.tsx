import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { currentMonthKey, formatKES, monthLabel, parseKES } from "@kodi/shared";
import { useAuth } from "../lib/auth";
import {
  generateInvoices,
  getTenant,
  getTenantPortalLink,
  listTenantInvoices,
  listTenantPayments,
  listUnits,
  recordManualPayment,
  settleDeposit,
  updateTenant,
} from "../lib/api";
import type { InvoiceWithRefs, PaymentWithRefs, Tenant, Unit } from "../lib/types";
import { Button } from "../components/Button";
import { Field, Input, Select, Textarea } from "../components/Field";
import { Badge, Card, CardBody, ErrorBanner, Loading, PageHeader } from "../components/ui";
import { Modal } from "../components/Modal";
import { InvoiceStatusBadge, Money } from "../components/domain";
import { MpesaCollectModal } from "../components/MpesaCollectModal";
import { InviteTenantButton } from "./TenantsPage";
import { TenantModal } from "./TenantsPage";

export function TenantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { org } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [invoices, setInvoices] = useState<InvoiceWithRefs[]>([]);
  const [payments, setPayments] = useState<PaymentWithRefs[]>([]);
  const [hasPortal, setHasPortal] = useState(false);
  const [showPay, setShowPay] = useState(false);
  const [showCollect, setShowCollect] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showSettle, setShowSettle] = useState(false);

  const load = async () => {
    if (!org || !id) return;
    setLoading(true);
    setError(null);
    try {
      const [t, u, inv, pay, link] = await Promise.all([
        getTenant(id),
        listUnits(org.id),
        listTenantInvoices(id),
        listTenantPayments(id),
        getTenantPortalLink(id),
      ]);
      setTenant(t);
      setUnits(u);
      setInvoices(inv);
      setPayments(pay);
      setHasPortal(!!link);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id, id]);

  if (loading) return <Loading label="Loading tenant…" />;
  if (error) return <ErrorBanner message={error} onRetry={load} />;
  if (!tenant) return <ErrorBanner message="Tenant not found." />;

  const balance = invoices.reduce((s, i) => s + i.balance, 0);
  const unit = units.find((u) => u.id === tenant.unit_id);
  const lastInvoice = invoices[0];

  const markNotice = async (status: "active" | "notice") => {
    try {
      await updateTenant(tenant.id, { status });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <PageHeader
        title={tenant.full_name}
        sub={`${unit ? `Unit ${unit.label}` : "No unit assigned"} · since ${tenant.move_in_date ?? "—"}`}
        actions={
          <>
            <Button variant="secondary" onClick={() => setShowCollect(true)}>Collect via M-Pesa</Button>
            <Button variant="secondary" onClick={() => setShowPay(true)}>Record payment</Button>
            <Button variant="secondary" onClick={() => setShowEdit(true)}>Edit</Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardBody>
            <h2 className="mb-2 font-semibold">Balance</h2>
            <p className={`text-3xl font-bold ${balance > 0 ? "text-red-600" : "text-brand-600"}`}>
              {formatKES(balance)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {balance > 0 ? `owed${lastInvoice ? ` · oldest: ${monthLabel(lastInvoice.month)}` : ""}` : "fully paid up"}
            </p>
            <div className="mt-3">
              <Badge tone={tenant.status === "active" ? "green" : tenant.status === "notice" ? "amber" : "slate"}>
                {tenant.status.replace("_", " ")}
              </Badge>
            </div>
            <div className="mt-3 space-y-1 text-sm">
              <p><span className="text-slate-500">Phone:</span> {tenant.phone}</p>
              <p><span className="text-slate-500">National ID:</span> {tenant.national_id || "—"}</p>
              <p><span className="text-slate-500">Deposit held:</span> <Money value={tenant.deposit_held} /></p>
            </div>
            <div className="mt-4 space-y-2 border-t border-slate-100 pt-3">
              {tenant.status === "active" && (
                <Button size="sm" variant="secondary" onClick={() => markNotice("notice")}>
                  Put on notice
                </Button>
              )}
              {tenant.status === "notice" && (
                <Button size="sm" variant="secondary" onClick={() => markNotice("active")}>
                  Revert to active
                </Button>
              )}
              {tenant.status !== "moved_out" && (
                <Button size="sm" variant="secondary" onClick={() => setShowSettle(true)}>
                  Settle deposit / move out
                </Button>
              )}
            </div>
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardBody>
            <h2 className="mb-2 font-semibold">Invoice history</h2>
            {invoices.length === 0 ? (
              <p className="text-sm text-slate-500">
                No invoices yet.{" "}
                <button
                  className="font-medium text-brand-600 hover:underline"
                  onClick={async () => {
                    await generateInvoices(org!.id, currentMonthKey());
                    await load();
                  }}
                >
                  Generate this month's invoices
                </button>
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                      <th className="py-2 pr-3">Month</th>
                      <th className="py-2 pr-3 text-right">Total</th>
                      <th className="py-2 pr-3 text-right">Balance</th>
                      <th className="py-2 pr-3">Due</th>
                      <th className="py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {invoices.map((i) => (
                      <tr key={i.id}>
                        <td className="py-2 pr-3 font-medium">{monthLabel(i.month)}</td>
                        <td className="py-2 pr-3 text-right"><Money value={i.total} /></td>
                        <td className="py-2 pr-3 text-right"><Money value={i.balance} /></td>
                        <td className="py-2 pr-3">{i.due_date}</td>
                        <td className="py-2"><InvoiceStatusBadge status={i.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <h2 className="mb-2 mt-6 font-semibold">Payment history</h2>
            {payments.length === 0 ? (
              <p className="text-sm text-slate-500">No payments recorded.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                      <th className="py-2 pr-3">Receipt</th>
                      <th className="py-2 pr-3 text-right">Amount</th>
                      <th className="py-2 pr-3">Method</th>
                      <th className="py-2 pr-3">Date</th>
                      <th className="py-2">Applied to</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {payments.map((p) => (
                      <tr key={p.id}>
                        <td className="py-2 pr-3">
                          <Link to={`/app/payments/${p.id}`} className="font-medium text-brand-600 hover:underline">
                            {p.receipt_no}
                          </Link>
                        </td>
                        <td className="py-2 pr-3 text-right"><Money value={p.amount} /></td>
                        <td className="py-2 pr-3">{p.mpesa_code ? `M-Pesa ${p.mpesa_code}` : p.method}</td>
                        <td className="py-2 pr-3">{new Date(p.paid_at).toLocaleDateString("en-GB")}</td>
                        <td className="py-2 text-xs text-slate-500">
                          {p.allocations.length === 0
                            ? "credit"
                            : p.allocations.map((a) => `${formatKES(a.amount)}`).join(" + ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-4">
        <CardBody>
          <h2 className="mb-2 font-semibold">Tenant portal access</h2>
          {hasPortal ? (
            <p className="text-sm text-green-700">This tenant has a portal login and can view balances, pay via M-Pesa, and download their statement.</p>
          ) : (
            <InviteTenantButton tenant={tenant} />
          )}
        </CardBody>
      </Card>

      {showPay && (
        <RecordPaymentModal
          orgId={org!.id}
          tenantId={tenant.id}
          tenantName={tenant.full_name}
          suggested={lastInvoice && lastInvoice.balance > 0 ? lastInvoice.balance : (unit?.rent_amount ?? 0)}
          onClose={() => setShowPay(false)}
          onRecorded={load}
        />
      )}
      {showCollect && (
        <MpesaCollectModal
          orgId={org!.id}
          tenantId={tenant.id}
          tenantName={tenant.full_name}
          defaultPhone={tenant.phone}
          defaultAmount={lastInvoice && lastInvoice.balance > 0 ? lastInvoice.balance : (unit?.rent_amount ?? 0)}
          onClose={() => setShowCollect(false)}
          onRecorded={load}
        />
      )}
      {showEdit && (
        <TenantModal
          orgId={org!.id}
          tenant={tenant}
          units={units}
          onClose={() => setShowEdit(false)}
          onSaved={load}
        />
      )}
      {showSettle && (
        <SettleDepositModal
          orgId={org!.id}
          tenant={tenant}
          onClose={() => setShowSettle(false)}
          onSettled={() => navigate("/app/tenants")}
        />
      )}
    </div>
  );
}

export function RecordPaymentModal({ orgId, tenantId, tenantName, suggested, onClose, onRecorded }: {
  orgId: string;
  tenantId: string;
  tenantName: string;
  suggested: number;
  onClose: () => void;
  onRecorded: () => Promise<void>;
}) {
  const [amount, setAmount] = useState(suggested ? String(suggested) : "");
  const [method, setMethod] = useState<"mpesa_manual" | "cash" | "bank">("mpesa_manual");
  const [mpesaCode, setMpesaCode] = useState("");
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = parseKES(amount);
    if (value === null || value < 1) { setError("Enter a valid amount in KES."); return; }
    if (method === "mpesa_manual" && !/^[A-Za-z0-9]{8,12}$/.test(mpesaCode.trim())) {
      setError("Enter the M-Pesa transaction code from the confirmation SMS (e.g. SLJ7XK2M9P).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await recordManualPayment({
        orgId,
        tenantId,
        amount: value,
        method,
        mpesaCode: method === "mpesa_manual" ? mpesaCode.trim().toUpperCase() : null,
        paidAt: new Date(paidAt || Date.now()).toISOString(),
        note: note.trim() || null,
      });
      await onRecorded();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Record payment — ${tenantName}`} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Amount (KES)" required>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" required />
          </Field>
          <Field label="Method">
            <Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
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
        <p className="text-xs text-slate-500">
          The payment applies to the oldest unpaid invoice first; any remainder stays as credit.
        </p>
        {error && <ErrorBanner message={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? "Recording…" : "Record payment"}</Button>
        </div>
      </form>
    </Modal>
  );
}

export function SettleDepositModal({ orgId, tenant, onClose, onSettled }: {
  orgId: string;
  tenant: Tenant;
  onClose: () => void;
  onSettled: () => void;
}) {
  const [lines, setLines] = useState<{ label: string; amount: string }[]>([{ label: "Repairs", amount: "" }]);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parsed = lines.map((l) => ({
    label: l.label.trim() || "Deduction",
    amount: parseKES(l.amount) ?? NaN,
  }));
  const total = parsed.reduce((s, l) => s + (Number.isFinite(l.amount) ? l.amount : 0), 0);
  const refund = Math.max(0, tenant.deposit_held - total);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (parsed.some((l) => !Number.isFinite(l.amount))) {
      setError("Every deduction needs a valid amount.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await settleDeposit(orgId, tenant, parsed, refund, notes.trim() || null);
      onSettled();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Settle deposit — ${tenant.full_name}`} onClose={onClose} wide>
      <form onSubmit={save} className="space-y-4">
        <p className="text-sm text-slate-600">
          Deposit held: <Money value={tenant.deposit_held} className="font-semibold" />.
          Move the tenant out and record deductions; the balance is refunded to the tenant.
        </p>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1fr_160px_auto] gap-2">
            <Input value={l.label} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} placeholder="e.g. Repairs, Unpaid balance, Cleaning" />
            <Input value={l.amount} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} inputMode="numeric" placeholder="KES" />
            <Button type="button" variant="ghost" size="sm" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</Button>
          </div>
        ))}
        <Button type="button" variant="secondary" size="sm" onClick={() => setLines([...lines, { label: "", amount: "" }])}>
          Add deduction
        </Button>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Move-out condition, refund method…" />
        </Field>
        <div className="rounded-lg bg-slate-50 p-3 text-sm">
          <p>Total deductions: <Money value={total} className="font-semibold" /></p>
          <p>Refund to tenant: <Money value={refund} className="font-semibold text-brand-600" /></p>
        </div>
        {error && <ErrorBanner message={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? "Settling…" : "Settle & move out"}</Button>
        </div>
      </form>
    </Modal>
  );
}
