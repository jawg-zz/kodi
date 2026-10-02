import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { addMonths, currentMonthKey, formatKES, monthLabel } from "@kodi/shared";
import { useAuth } from "../lib/auth";
import { generateInvoices, getInvoice, getInvoiceQr, getPaybillInfo, listInvoices, listTenants, mintInvoiceQr, updateInvoice } from "../lib/api";
import type { InvoiceQr, InvoiceWithRefs, Tenant } from "../lib/types";
import { downloadQr, shareQrImage, whatsappTextLink } from "../lib/share";
import { Button } from "../components/Button";
import { Field, Input } from "../components/Field";
import { Card, EmptyState, ErrorBanner, Loading } from "../components/ui";
import { Modal } from "../components/Modal";
import { InvoiceStatusBadge, LinesBreakdown, Money } from "../components/domain";
import { RecordPaymentFields } from "../components/RecordPaymentForm";
import { MpesaCollectModal } from "../components/MpesaCollectModal";

export function InvoicesPage() {
  const { org } = useAuth();
  const [month, setMonth] = useState(currentMonthKey());
  const [status, setStatus] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<InvoiceWithRefs[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<InvoiceWithRefs | null>(null);
  const [paying, setPaying] = useState<InvoiceWithRefs | null>(null);
  const [collecting, setCollecting] = useState<InvoiceWithRefs | null>(null);

  const load = async () => {
    if (!org) return;
    setLoading(true);
    setError(null);
    try {
      const [inv, t] = await Promise.all([
        listInvoices(org.id, month),
        listTenants(org.id),
      ]);
      setInvoices(inv);
      setTenants(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id, month]);

  const handleGenerate = async () => {
    if (!org) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const n = await generateInvoices(org.id, month);
      setNotice(n === 0 ? "No new invoices — all occupied units already have one for this month." : `Generated ${n} invoice${n === 1 ? "" : "s"}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Loading label="Loading invoices…" />;

  const tenantName = (id: string) => tenants.find((t) => t.id === id)?.full_name ?? "—";
  const shown = invoices.filter((i) => status === "all" || i.status === status);

  const prev = addMonths(month, -1);
  const next = addMonths(month, 1);

  // The band is the filter: each cell shows a slice of the month and
  // clicking it filters the table. Figures always describe the whole
  // month regardless of the active filter.
  const countBy = (st: string) => invoices.filter((i) => i.status === st).length;
  const balanceBy = (st: string) =>
    invoices.filter((i) => i.status === st).reduce((s, i) => s + i.balance, 0);
  const billedTotal = invoices.reduce((s, i) => s + i.total, 0);
  const collectedTotal = invoices.reduce((s, i) => s + (i.total - i.balance), 0);
  const filterCells = [
    { key: "all", label: `${invoices.length} invoice${invoices.length === 1 ? "" : "s"}`, sub: `${formatKES(billedTotal)} billed` },
    { key: "unpaid", label: `${countBy("unpaid")} unpaid`, sub: `${formatKES(balanceBy("unpaid"))} due` },
    { key: "partial", label: `${countBy("partial")} partial`, sub: `${formatKES(balanceBy("partial"))} due` },
    { key: "paid", label: `${countBy("paid")} paid`, sub: `${formatKES(collectedTotal)} collected` },
  ];

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMonth(prev)}
            aria-label="Previous month"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-900"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
              <path fillRule="evenodd" d="M12.79 5.23a.75.75 0 0 1-.02 1.06L8.06 11l4.71 4.71a.75.75 0 1 1-1.06 1.06l-5.24-5.24a.75.75 0 0 1 0-1.06l5.24-5.24a.75.75 0 0 1 1.06 0Z" clipRule="evenodd" />
            </svg>
          </button>
          <h1 className="min-w-[13rem] text-center text-2xl font-bold text-slate-900">{monthLabel(month)}</h1>
          <button
            type="button"
            onClick={() => setMonth(next)}
            aria-label="Next month"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-900"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
              <path fillRule="evenodd" d="M7.21 5.23a.75.75 0 0 1 1.06 0l5.24 5.24a.75.75 0 0 1 0 1.06l-5.24 5.24a.75.75 0 1 1-1.06-1.06L11.94 11 7.23 6.29a.75.75 0 0 1-.02-1.06Z" clipRule="evenodd" />
            </svg>
          </button>
          {month !== currentMonthKey() && (
            <button
              type="button"
              onClick={() => setMonth(currentMonthKey())}
              className="ml-2 text-sm font-medium text-brand-600 hover:underline"
            >
              Back to current
            </button>
          )}
        </div>
        <Button onClick={handleGenerate} disabled={busy}>{busy ? "Generating…" : "Generate invoices"}</Button>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200 sm:grid-cols-4">
        {filterCells.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setStatus(c.key)}
            aria-pressed={status === c.key}
            className={`px-4 py-3 text-left transition-colors ${
              status === c.key
                ? "bg-slate-100 shadow-[inset_0_-2px_0_#0f172a]"
                : "bg-white hover:bg-slate-50"
            }`}
          >
            <span className={`block text-sm ${status === c.key ? "font-semibold text-slate-900" : "font-medium text-slate-700"}`}>
              {c.label}
            </span>
            <span className="mt-0.5 block text-xs tabular-nums text-slate-500">{c.sub}</span>
          </button>
        ))}
      </div>

      {notice && (
        <div className="print-ink mb-4 rounded-xl border border-brand-100 bg-brand-50 p-3 text-sm font-medium text-brand-700">
          {notice}
        </div>
      )}
      {error && <ErrorBanner message={error} onRetry={load} />}

      {shown.length === 0 ? (
        <EmptyState
          title={`No ${status === "all" ? "" : status + " "}invoices for ${monthLabel(month)}`}
          hint="Generate one invoice per occupied unit, or step to another month with the arrows above."
          action={<Button onClick={handleGenerate} disabled={busy}>Generate invoices</Button>}
        />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="rtable w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="px-4 py-3">Tenant</th>
                  <th className="px-4 py-3">Unit</th>
                  <th className="px-4 py-3">Breakdown</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3 text-right">Balance</th>
                  <th className="px-4 py-3">Due</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((i) => (
                  <tr key={i.id} className="hover:bg-slate-50">
                    <td data-label="Tenant" className="px-4 py-3">
                      <Link to={`/app/tenants/${i.tenant_id}`} className="font-medium text-slate-900 underline-offset-2 hover:underline">
                        {i.tenant?.full_name ?? tenantName(i.tenant_id)}
                      </Link>
                    </td>
                    <td data-label="Unit" className="px-4 py-3">{i.unit?.label ?? "—"}</td>
                    <td data-label="Breakdown" className="px-4 py-3"><LinesBreakdown lines={i.lines} /></td>
                    <td data-label="Total" className="px-4 py-3 text-right"><Money value={i.total} /></td>
                    <td data-label="Balance" className="px-4 py-3 text-right">
                      <Money value={i.balance} className={i.balance > 0 ? "font-semibold text-red-600" : ""} />
                    </td>
                    <td data-label="Due" className="px-4 py-3">{i.due_date}</td>
                    <td data-label="" className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <InvoiceStatusBadge status={i.status} />
                        {i.balance > 0 && (
                          <>
                            <button onClick={() => setCollecting(i)} className="text-xs font-semibold text-brand-600 hover:underline">
                              Collect
                            </button>
                            <button onClick={() => setPaying(i)} className="text-xs font-medium text-brand-600 hover:underline">
                              Record
                            </button>
                            <button onClick={() => setEditing(i)} className="text-xs font-medium text-slate-600 hover:underline">
                              Edit
                            </button>
                            <QrButton invoiceId={i.id} />
                          </>
                        )}
                        <Link to={`/print/invoice/${i.id}`} target="_blank" rel="noreferrer" className="text-xs font-medium text-slate-600 hover:underline">
                          Print
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {editing && (
        <EditInvoiceModal
          invoice={editing}
          tenantName={tenantName(editing.tenant_id)}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
        />
      )}

      {paying && org && (
        <PayInvoiceModal
          orgId={org.id}
          invoice={paying}
          tenantName={tenantName(paying.tenant_id)}
          onClose={() => setPaying(null)}
          onRecorded={async () => { setPaying(null); await load(); }}
        />
      )}

      {collecting && (
        <CollectInvoiceModal
          invoice={collecting}
          tenantName={tenantName(collecting.tenant_id)}
          tenantPhone={collecting.tenant?.phone ?? tenants.find((t) => t.id === collecting.tenant_id)?.phone ?? ""}
          onClose={() => setCollecting(null)}
          onRecorded={async () => { setCollecting(null); await load(); }}
        />
      )}
    </div>
  );
}

/** Record a payment pre-targeted at this invoice (remainder still FIFO). */
export function PayInvoiceModal({ orgId, invoice, tenantName, onClose, onRecorded }: {
  orgId: string;
  invoice: InvoiceWithRefs;
  tenantName: string;
  onClose: () => void;
  onRecorded: () => Promise<void>;
}) {
  return (
    <Modal title={`Record payment — ${tenantName} (${invoice.month})`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          Balance <Money value={invoice.balance} className="font-semibold" /> of <Money value={invoice.total} className="font-semibold" /> total — pre-targeted
          below; anything extra settles the oldest invoices first.
        </p>
        <RecordPaymentFields
          orgId={orgId}
          tenantId={invoice.tenant_id}
          suggested={invoice.balance}
          presetTargets={[invoice.id]}
          onDone={onRecorded}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

/** STK push pre-filled with this invoice's balance. */
export function CollectInvoiceModal({ invoice, tenantName, tenantPhone, onClose, onRecorded }: {
  invoice: InvoiceWithRefs;
  tenantName: string;
  tenantPhone: string;
  onClose: () => void;
  onRecorded: () => Promise<void>;
}) {
  return (
    <MpesaCollectModal
      tenantId={invoice.tenant_id}
      tenantName={tenantName}
      defaultPhone={tenantPhone}
      defaultAmount={invoice.balance}
      onClose={onClose}
      onRecorded={onRecorded}
    />
  );
}
export function EditInvoiceModal({ invoice, tenantName, onClose, onSaved }: {
  invoice: InvoiceWithRefs;
  tenantName: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [dueDate, setDueDate] = useState(invoice.due_date);
  const [notes, setNotes] = useState(invoice.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      setError('Due date must be YYYY-MM-DD.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Totals stay system-computed; only the due date and notes are editable
      // so payments already allocated against this invoice keep adding up.
      await updateInvoice(invoice.id, { due_date: dueDate, notes: notes.trim() || null });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={'Edit invoice — ' + tenantName + ' (' + invoice.month + ')'} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <p className="text-sm text-slate-600">
          Total <Money value={invoice.total} className="font-semibold" />, balance <Money value={invoice.balance} className="font-semibold" /> — amounts are
          computed from payments and cannot be edited here.
        </p>
        <Field label="Due date" required>
          <Input value={dueDate} onChange={(e) => setDueDate(e.target.value)} placeholder="YYYY-MM-DD" />
        </Field>
        <Field label="Notes">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Correction reason…" />
        </Field>
        {error && <ErrorBanner message={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** Per-invoice Dynamic QR: tenant scans with the M-Pesa app, no typing. */
function QrButton({ invoiceId }: { invoiceId: string }) {
  const [qr, setQr] = useState<InvoiceQr | null>(null);
  const [paybillNo, setPaybillNo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareState, setShareState] = useState<"idle" | "unsupported" | "failed">("idle");
  const [shared, setShared] = useState(false);

  const show = async () => {
    setBusy(true);
    setError(null);
    setShareState("idle");
    setShared(false);
    try {
      const cached = await getInvoiceQr(invoiceId).catch(() => null);
      if (cached) {
        setQr(cached);
      } else {
        setQr(await mintInvoiceQr(invoiceId));
      }
      // Caption needs the paybill number; fail soft — share still works.
      getInvoice(invoiceId)
        .then((inv) => (inv ? getPaybillInfo(inv.tenant_id) : null))
        .then((pb) => setPaybillNo(pb?.shortcode ?? null))
        .catch(() => setPaybillNo(null));
      setOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const caption = qr
    ? `Rent payment: M-Pesa Paybill${paybillNo ? ` ${paybillNo}` : ""}, account ${qr.ref_no}, amount ${qr.amount.toLocaleString("en-US")} KES. Scan the QR or use these details.`
    : "";

  const doShare = async () => {
    if (!qr) return;
    setShareState("idle");
    const result = await shareQrImage({
      qrBase64: qr.qr_base64,
      fileName: `rent-qr-${qr.ref_no}.png`,
      title: `Rent QR — ${qr.ref_no}`,
      text: caption,
    });
    if (result === "shared") {
      setShared(true);
    } else if (result === "unsupported") {
      setShareState("unsupported");
    } else {
      setShareState("failed");
    }
  };

  return (
    <>
      <button onClick={show} className="text-xs font-medium text-brand-600 hover:underline" title={error ?? undefined}>
        {busy ? "QR…" : "QR"}
      </button>
      {open && qr && (
        <Modal title={`Pay ${qr.ref_no} — ${qr.amount.toLocaleString("en-US")} KES`} onClose={() => setOpen(false)}>
          <div className="space-y-3 text-center">
            <img
              src={`data:image/png;base64,${qr.qr_base64}`}
              alt={`M-Pesa QR for ${qr.ref_no}`}
              className="mx-auto h-64 w-64 rounded-lg border border-slate-200"
            />
            <p className="text-sm text-slate-600">
              Scan with the M-Pesa app — Paybill with account <strong>{qr.ref_no}</strong> for{" "}
              <strong>{qr.amount.toLocaleString("en-US")} KES</strong>.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={doShare}>Share to WhatsApp</Button>
              <Button variant="secondary" onClick={() => downloadQr(qr.qr_base64, `rent-qr-${qr.ref_no}.png`)}>
                Download
              </Button>
              <Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>
            </div>
            {shared && <p className="text-xs font-medium text-brand-700">Shared — the QR image and paybill details went with it.</p>}
            {shareState === "unsupported" && (
              <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
                <p>This browser can't share images directly. Send the caption instead and attach the downloaded QR:</p>
                <div className="mt-2 flex flex-wrap justify-center gap-2">
                  <a
                    href={whatsappTextLink(caption)}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
                  >
                    Open WhatsApp with caption
                  </a>
                  <Button size="sm" variant="secondary" onClick={() => downloadQr(qr.qr_base64, `rent-qr-${qr.ref_no}.png`)}>
                    Download QR
                  </Button>
                </div>
              </div>
            )}
            {shareState === "failed" && (
              <p className="text-xs text-red-700">Share failed — use Download and attach it manually.</p>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
