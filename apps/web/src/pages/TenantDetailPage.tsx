import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { currentMonthKey, formatKES, monthLabel, parseKES } from "@kodi/shared";
import { useAuth } from "../lib/auth";
import {
  applyCreditNow,
  generateInvoices,
  getCreditLedger,
  getTenant,
  getTenantCredit,
  getTenantPortalLink,
  listTenantInvoices,
  listTenantPayments,
  listUnits,
  settleDeposit,
  updateTenant,
} from "../lib/api";
import type { CreditLedgerEntry, InvoiceWithRefs, PaymentWithRefs, Tenant, Unit } from "../lib/types";
import { Button } from "../components/Button";
import { Field, Input, Textarea } from "../components/Field";
import { Badge, Card, CardBody, ErrorBanner, Loading, PageHeader } from "../components/ui";
import { Modal } from "../components/Modal";
import { InvoiceStatusBadge, Money, PaymentStatusBadge } from "../components/domain";
import { MpesaCollectModal } from "../components/MpesaCollectModal";
import { RecordPaymentFields } from "../components/RecordPaymentForm";
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
  const [credit, setCredit] = useState(0);
  const [ledger, setLedger] = useState<CreditLedgerEntry[]>([]);
  const [hasPortal, setHasPortal] = useState(false);
  const [showPay, setShowPay] = useState(false);
  const [payTargets, setPayTargets] = useState<string[]>([]);
  const [showCollect, setShowCollect] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showSettle, setShowSettle] = useState(false);
  const [creditBusy, setCreditBusy] = useState(false);
  const [creditMsg, setCreditMsg] = useState<string | null>(null);

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
      try {
        setCredit(await getTenantCredit(id));
      } catch {
        setCredit(0);
      }
      try {
        setLedger(await getCreditLedger(id));
      } catch {
        setLedger([]);
      }
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
  const oldest = [...invoices].filter((i) => i.balance > 0).sort((a, b) => a.month.localeCompare(b.month))[0];
  const netOwed = Math.max(0, balance - credit);

  const markNotice = async (status: "active" | "notice") => {
    try {
      await updateTenant(tenant.id, { status });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openRecord = (targets: string[] = []) => {
    setPayTargets(targets);
    setShowPay(true);
  };

  const handleApplyCredit = async () => {
    if (!id) return;
    setCreditBusy(true);
    setCreditMsg(null);
    try {
      const consumed = await applyCreditNow(id);
      setCreditMsg(consumed > 0
        ? `${formatKES(consumed)} of prepaid credit applied to the oldest invoices.`
        : "No open invoices for the credit to settle.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreditBusy(false);
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
            <Button variant="secondary" onClick={() => openRecord()}>Record payment</Button>
            <Button variant="secondary" onClick={() => setShowEdit(true)}>Edit</Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardBody>
            <h2 className="mb-2 font-semibold">Balance</h2>
            <p className={`text-3xl font-bold ${netOwed > 0 ? "text-red-600" : "text-brand-600"}`}>
              {formatKES(netOwed)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {netOwed > 0 ? `owed${oldest ? ` · oldest: ${monthLabel(oldest.month)}` : ""}` : credit > 0 ? "fully paid up — credit held" : "fully paid up"}
            </p>
            {credit > 0 && (
              <>
                <p className="mt-1 text-xs font-medium text-brand-600">
                  Prepaid credit: {formatKES(credit)} (applies automatically to new invoices)
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={handleApplyCredit} disabled={creditBusy || balance <= 0}>
                    {creditBusy ? "Applying…" : "Apply credit now"}
                  </Button>
                </div>
                {creditMsg && <p className="mt-1 text-xs text-green-700">{creditMsg}</p>}
                {ledger.length > 0 && (
                  <details className="mt-2 text-xs text-slate-500">
                    <summary className="cursor-pointer font-medium text-slate-600">Credit history ({ledger.length})</summary>
                    <ul className="mt-1 space-y-1">
                      {ledger.slice(0, 8).map((l) => (
                        <li key={l.id} className="flex justify-between gap-2">
                          <span>
                            {l.kind === "created" ? "Overpayment" : l.kind === "applied" ? "Applied" : "Reversed"}
                            {l.note ? ` · ${l.note}` : ""}
                          </span>
                          <span className={l.amount >= 0 ? "text-brand-600" : ""}>{formatKES(l.amount)}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
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
                      <th className="py-2"><span className="sr-only">Actions</span></th>
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
                        <td className="py-2 text-right">
                          {i.balance > 0 && (
                            <span className="flex justify-end gap-2">
                              <button onClick={() => setShowCollect(true)} className="text-xs font-medium text-brand-600 hover:underline">
                                Collect
                              </button>
                              <button onClick={() => openRecord([i.id])} className="text-xs font-medium text-brand-600 hover:underline">
                                Pay
                              </button>
                            </span>
                          )}
                        </td>
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
                      <tr key={p.id} className={(p.status ?? "active") !== "active" ? "opacity-60" : undefined}>
                        <td className="py-2 pr-3">
                          <Link to={`/app/payments/${p.id}`} className="font-medium text-brand-600 hover:underline">
                            {p.receipt_no}
                          </Link>{" "}
                          {(p.status ?? "active") !== "active" && (
                            <PaymentStatusBadge status={p.status} />
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right"><Money value={p.amount} /></td>
                        <td className="py-2 pr-3">{p.mpesa_code ? `M-Pesa ${p.mpesa_code}` : p.method}</td>
                        <td className="py-2 pr-3">{new Date(p.paid_at).toLocaleDateString("en-GB")}</td>
                        <td className="py-2 text-xs text-slate-500">
                          {p.allocations.length === 0
                            ? "held as prepaid credit"
                            : p.allocations.map((a) => `${a.month ? monthLabel(a.month) : formatKES(a.amount)}${a.month ? ` ${formatKES(a.amount)}` : ""}`).join(" + ")}
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
        <Modal title={`Record payment — ${tenant.full_name}`} onClose={() => { setShowPay(false); setPayTargets([]); }}>
          <RecordPaymentFields
            orgId={org!.id}
            tenantId={tenant.id}
            suggested={netOwed > 0 ? netOwed : (unit?.rent_amount ?? 0)}
            presetTargets={payTargets}
            onDone={async () => {
              setShowPay(false);
              setPayTargets([]);
              await load();
            }}
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => { setShowPay(false); setPayTargets([]); }}>Cancel</Button>
          </div>
        </Modal>
      )}
      {showCollect && (
        <MpesaCollectModal
          tenantId={tenant.id}
          tenantName={tenant.full_name}
          defaultPhone={tenant.phone}
          defaultAmount={netOwed > 0 ? netOwed : (unit?.rent_amount ?? 0)}
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
      {showSettle && tenant && (
        <SettleDepositModal
          outstanding={netOwed}
          orgId={org!.id}
          tenant={tenant}
          onClose={() => setShowSettle(false)}
          onSettled={() => navigate("/app/tenants")}
        />
      )}
    </div>
  );
}

export function SettleDepositModal({ orgId, tenant, outstanding, onClose, onSettled }: {
  orgId: string;
  tenant: Tenant;
  outstanding: number;
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
        {outstanding > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            Unpaid invoices: <Money value={outstanding} className="font-semibold" />. Consider
            adding an “Unpaid balance” deduction line below so the arrears are not written off
            with the refund.
          </div>
        )}
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
