import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth";
import {
  ensureMyAccountCode,
  getInvoiceQr,
  getPaybillInfo,
  getTenantCredit,
  listTenantInvoices,
  listTenantPayments,
  mintInvoiceQr,
} from "../lib/api";
import { stkInitiate, stkStatus } from "../lib/api";
import type { InvoiceWithRefs, MpesaTransaction, PaybillInfo, PaymentWithRefs } from "../lib/types";
import { Button } from "../components/Button";
import { Field, Input } from "../components/Field";
import { Modal } from "../components/Modal";
import { Badge, Card, CardBody, ErrorBanner, Loading, Stat } from "../components/ui";
import { InvoiceStatusBadge, Money, paymentMethodLabel } from "../components/domain";
import { formatKES, formatDate, monthLabel, normalizeKenyanPhone, parseKES } from "@kodi/shared";

export function PortalPage() {
  const { tenant } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<InvoiceWithRefs[]>([]);
  const [payments, setPayments] = useState<PaymentWithRefs[]>([]);
  const [credit, setCredit] = useState(0);
  const [showPay, setShowPay] = useState(false);
  const [tx, setTx] = useState<MpesaTransaction | null>(null);

  const load = async () => {
    if (!tenant) return;
    setLoading(true);
    setError(null);
    try {
      const [inv, pay] = await Promise.all([
        listTenantInvoices(tenant.id),
        listTenantPayments(tenant.id),
      ]);
      setInvoices(inv);
      setPayments(pay);
      try {
        setCredit(await getTenantCredit(tenant.id));
      } catch {
        // Credit table may not exist on older backends — fail open.
        setCredit(0);
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
  }, [tenant?.id]);

  useEffect(() => {
    if (!tx || tx.status !== "pending") return;
    let polls = 0;
    const timer = setInterval(async () => {
      polls += 1;
      try {
        const latest = await stkStatus(tx.checkout_request_id);
        setTx(latest);
        if (latest.status === "success") {
          clearInterval(timer);
          void load();
        } else if (latest.status === "failed" || latest.status === "timeout") {
          clearInterval(timer);
        } else if (polls >= 45) {
          // 3 minutes: handset prompt long expired; stop polling, keep state.
          clearInterval(timer);
        }
      } catch {
        // keep polling
      }
    }, 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx?.checkout_request_id, tx?.status]);

  if (loading) return <Loading label="Loading your account…" />;
  if (error) return <ErrorBanner message={error} onRetry={load} />;
  if (!tenant) return <ErrorBanner message="Tenant account not found." />;

  const balance = invoices.reduce((s, i) => s + i.balance, 0);
  const oldest = [...invoices].filter((i) => i.balance > 0).sort((a, b) => a.month.localeCompare(b.month))[0];
  const netOwed = Math.max(0, balance - credit);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Balance owed" value={formatKES(netOwed)} accent={netOwed > 0 ? "red" : "green"} sub={oldest ? `oldest: ${monthLabel(oldest.month)}` : credit > 0 ? "all paid up — credit held" : "all paid up"} />
        <Stat label="Invoices" value={String(invoices.length)} sub={`${invoices.filter((i) => i.status === "paid").length} paid`} />
        <Stat label={credit > 0 ? "Prepaid credit" : "Payments made"} value={credit > 0 ? formatKES(credit) : String(payments.length)} sub={credit > 0 ? "applies automatically to new invoices" : payments.length ? `latest ${formatKES(payments[0].amount)}` : "none yet"} />
      </div>

      {netOwed > 0 && (
        <Card>
          <CardBody>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold">Pay your rent</h2>
                <p className="text-sm text-slate-500">
                  Two ways: get an STK prompt on your phone, or pay from the M-Pesa menu yourself.
                </p>
              </div>
              <Button variant="mpesa" onClick={() => setShowPay(true)}>Pay via M-Pesa</Button>
            </div>
            <PaybillCard tenantId={tenant.id} balance={netOwed} invoiceId={oldest?.id} />
            {tx && tx.status === "pending" && (
              <div className="mt-3 rounded-lg bg-blue-50 p-3 text-sm text-blue-800">
                A prompt for {formatKES(tx.amount)} was sent to your phone. Enter your M-Pesa PIN to complete it — this page updates automatically.
              </div>
            )}
            {tx && tx.status === "success" && (
              <div className="mt-3 rounded-lg border border-brand-100 bg-brand-50 p-3 text-sm font-medium text-brand-700 print-ink">
                Payment of {formatKES(tx.amount)} confirmed{tx.mpesa_receipt ? ` (M-Pesa ${tx.mpesa_receipt})` : ""}. Thank you!
              </div>
            )}
            {tx && (tx.status === "failed" || tx.status === "timeout") && (
              <div className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">
                The payment did not complete{tx.result_desc ? `: ${tx.result_desc}` : "."} You can try again.
              </div>
            )}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody>
          <h2 className="mb-2 font-semibold">Your invoices</h2>
          {invoices.length === 0 ? (
            <p className="text-sm text-slate-500">No invoices yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="rtable w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                    <th className="py-2 pr-3">Month</th>
                    <th className="py-2 pr-3 text-right">Total</th>
                    <th className="py-2 pr-3 text-right">Balance</th>
                    <th className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {invoices.map((i) => (
                    <tr key={i.id}>
                      <td data-label="Month" className="py-2 pr-3 font-medium">{monthLabel(i.month)}</td>
                      <td data-label="Total" className="py-2 pr-3 text-right"><Money value={i.total} /></td>
                      <td data-label="Balance" className="py-2 pr-3 text-right"><Money value={i.balance} /></td>
                      <td data-label="Status" className="py-2"><InvoiceStatusBadge status={i.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-semibold">Your payments</h2>
            <a href={`/print/statement/${tenant.id}`} target="_blank" rel="noreferrer" className="text-sm font-medium text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline">
              Print statement
            </a>
          </div>
          {payments.length === 0 ? (
            <p className="text-sm text-slate-500">No payments yet.</p>
          ) : (
              <ul className="divide-y divide-slate-100">
                {payments
                  .filter((p) => (p.status ?? "active") === "active")
                  .map((p) => {
                    const applied = p.allocations.map((a) => (a.month ? monthLabel(a.month) : "")).filter(Boolean).join(", ");
                    return (
                      <li key={p.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                        <div className="min-w-0">
                          <p className="font-medium">{p.receipt_no}</p>
                          <p className="text-xs text-slate-500">
                            {paymentMethodLabel(p.method)}{p.mpesa_code ? `, ${p.mpesa_code}` : ""}
                          </p>
                          <p className="text-xs text-slate-500">
                            {formatDate(p.paid_at)}
                            {p.allocations.length > 0 && (applied ? `, applied to ${applied}` : ", applied")}
                            {p.allocations.length === 0 && ", held as credit"}
                          </p>
                        </div>
                        <Money value={p.amount} className="shrink-0 font-semibold text-brand-600" />
                      </li>
                    );
                  })}
              </ul>
          )}
        </CardBody>
      </Card>

      {showPay && (
        <SelfPayModal
          tenantId={tenant.id}
          phone={tenant.phone}
          balance={netOwed}
          onClose={() => setShowPay(false)}
          onStarted={setTx}
        />
      )}
    </div>
  );
}

function SelfPayModal({ tenantId, phone, balance, onClose, onStarted }: {
  tenantId: string;
  phone: string;
  balance: number;
  onClose: () => void;
  onStarted: (tx: MpesaTransaction) => void;
}) {
  const [amount, setAmount] = useState(String(balance));
  const [number, setNumber] = useState(phone);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pay = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = parseKES(amount);
    const normalized = normalizeKenyanPhone(number);
    if (value === null || value < 1) { setError("Enter a valid amount in KES."); return; }
    if (!normalized) { setError("Enter a valid Safaricom number."); return; }
    setBusy(true);
    setError(null);
    try {
      const { checkoutRequestId } = await stkInitiate({ tenantId, phone: normalized, amount: value });
      onStarted({ checkout_request_id: checkoutRequestId, status: "pending", amount: value } as MpesaTransaction);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Pay via M-Pesa" onClose={onClose}>
      <form onSubmit={pay} className="space-y-4">
        <Field label="Amount (KES)" required hint={`Your balance is ${formatKES(balance)}.`}>
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" required />
        </Field>
        <Field label="Safaricom number" required hint="The prompt goes to this number.">
          <Input value={number} onChange={(e) => setNumber(e.target.value)} inputMode="tel" required />
        </Field>
        {error && <ErrorBanner message={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="mpesa" disabled={busy}>{busy ? "Sending prompt…" : "Send M-Pesa prompt"}</Button>
        </div>
      </form>
    </Modal>
  );
}

export function TenantBadgeCheck() {
  return <Badge tone="slate">tenant</Badge>;
}

/**
 * Paybill self-serve card: shows the tenant exactly what to type in the
 * M-Pesa menu (business number + their account code). Confirmation
 * auto-records — no STK prompt needed, works on any phone.
 */
function PaybillCard({ tenantId, balance, invoiceId }: { tenantId: string; balance: number; invoiceId?: string }) {
  const [info, setInfo] = useState<PaybillInfo | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [qrAmount, setQrAmount] = useState<number | null>(null);
  const [qrBusy, setQrBusy] = useState(false);
  const [qrError, setQrError] = useState<string | null>(null);

  useEffect(() => {
    getPaybillInfo(tenantId).then(setInfo).catch(() => setInfo(null));
  }, [tenantId]);

  // Show a scannable QR for the oldest open invoice once the code exists.
  useEffect(() => {
    if (invoiceId === undefined || info === null || info === undefined || !info.account_code) return;
    let alive = true;
    setQrBusy(true);
    setQrError(null);
    getInvoiceQr(invoiceId)
      .then(async (cached) => {
        if (!alive) return;
        if (cached) {
          setQr(cached.qr_base64);
          setQrAmount(cached.amount);
        } else {
          const fresh = await mintInvoiceQr(invoiceId);
          if (!alive) return;
          setQr(fresh.qr_base64);
          setQrAmount(fresh.amount);
        }
      })
      .catch((e) => {
        if (alive) setQrError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setQrBusy(false);
      });
    return () => { alive = false; };
  }, [invoiceId, info?.account_code]); // eslint-disable-line react-hooks/exhaustive-deps

  if (info === undefined) return null;
  if (info === null) return null;

  const ensureCode = async () => {
    setBusy(true);
    try {
      const code = await ensureMyAccountCode();
      setInfo({ ...info, account_code: code });
    } catch {
      // keep existing state; staff can share the code instead
    } finally {
      setBusy(false);
    }
  };

  // "I have paid" check: reload this tenant's recent payments and see if
  // anything landed in the last 15 minutes (C2B confirms in seconds, but
  // allow for Daraja delays). Refreshes the page data on a hit.
  const checkPaid = async () => {
    setChecking(true);
    setCheckMsg(null);
    try {
      const pay = await listTenantPayments(tenantId);
      const recent = pay.filter(
        (p) =>
          (p.status ?? "active") === "active" &&
          Date.now() - new Date(p.paid_at).getTime() < 15 * 60_000,
      );
      if (recent.length > 0) {
        const total = recent.reduce((s, p) => s + p.amount, 0);
        setCheckMsg(`Found it — ${formatKES(total)} recorded${recent.length > 1 ? ` across ${recent.length} payments` : ""}. Refreshing…`);
        setTimeout(() => window.location.reload(), 1500);
      } else {
        setCheckMsg(
          "Nothing yet — confirmations usually arrive within a minute. Check your M-Pesa SMS for the transaction code, and make sure the account number matches the one above.",
        );
      }
    } catch {
      setCheckMsg("Could not check right now — try refreshing the page.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-brand-100 bg-brand-50 p-4 text-sm print-ink">
      <p className="font-semibold text-brand-800">Or pay from your M-Pesa menu</p>
      {info.registered ? (
        <>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-slate-700">
            <li>M-Pesa → Lipa na M-Pesa → Paybill</li>
            <li>
              Business no:{" "}
              <strong className="font-mono text-base tracking-wide text-slate-900">{info.shortcode}</strong>
            </li>
            <li>
              Account no:{" "}
              {info.account_code ? (
                <strong className="font-mono text-base tracking-wide text-slate-900">{info.account_code}</strong>
              ) : (
                <button onClick={ensureCode} disabled={busy} className="font-medium text-brand-700 underline underline-offset-2 hover:no-underline">
                  {busy ? "…" : "show my account code"}
                </button>
              )}
            </li>
            <li>
              Amount: <strong className="tabular-nums text-slate-900">{formatKES(balance)}</strong> (or what you can) + your PIN — it records automatically.
            </li>
          </ol>
          <p className="mt-2 text-xs text-slate-600">
            Use your account code so the payment lands on your rent straight away.
          </p>
          {qrBusy && qr === null && (
            <p className="mt-2 text-xs text-slate-500">Preparing your payment QR…</p>
          )}
          {qr && qrAmount !== null && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <img
                src={`data:image/png;base64,${qr}`}
                alt="M-Pesa payment QR"
                className="h-40 w-40 rounded-lg border border-brand-100 bg-white"
              />
              <div className="text-xs text-slate-700">
                <p className="font-semibold text-slate-900">Scan to pay {formatKES(qrAmount)}</p>
                <p className="mt-0.5">Opens M-Pesa with this bill pre-filled — no typing.</p>
              </div>
            </div>
          )}
          {qrError && (
            <p className="mt-2 text-xs text-slate-500">{qrError}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={checkPaid} disabled={checking}>
              {checking ? "Checking…" : "I have paid — check now"}
            </Button>
            {checkMsg && <p className="text-xs text-slate-700">{checkMsg}</p>}
          </div>
        </>
      ) : (
        <p className="mt-1 text-slate-600">
          Paybill self-serve is being set up — use the STK prompt above for now.
        </p>
      )}
    </div>
  );
}
