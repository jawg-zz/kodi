import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { addMonths, currentMonthKey, monthLabel } from "@kodi/shared";
import { useAuth } from "../lib/auth";
import { generateInvoices, listInvoices, listTenants } from "../lib/api";
import type { InvoiceWithRefs, Tenant } from "../lib/types";
import { Button } from "../components/Button";
import { Field, Select } from "../components/Field";
import { Card, EmptyState, ErrorBanner, Loading, PageHeader } from "../components/ui";
import { InvoiceStatusBadge, LinesBreakdown, Money } from "../components/domain";

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
  const totalOutstanding = shown.reduce((s, i) => s + i.balance, 0);

  const prev = addMonths(month, -1);
  const next = addMonths(month, 1);

  return (
    <div>
      <PageHeader
        title="Invoices"
        sub={monthLabel(month)}
        actions={<Button onClick={handleGenerate} disabled={busy}>{busy ? "Generating…" : "Generate this month"}</Button>}
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => setMonth(prev)}>← {monthLabel(prev)}</Button>
          <Button variant="secondary" size="sm" onClick={() => setMonth(currentMonthKey())}>This month</Button>
          <Button variant="secondary" size="sm" onClick={() => setMonth(next)}>{monthLabel(next)} →</Button>
        </div>
        <div className="w-44">
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">All</option>
              <option value="unpaid">Unpaid</option>
              <option value="partial">Partial</option>
              <option value="paid">Paid</option>
            </Select>
          </Field>
        </div>
      </div>

      {notice && (
        <div className="mb-4 rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          {notice}
        </div>
      )}
      {error && <ErrorBanner message={error} onRetry={load} />}

      {shown.length === 0 ? (
        <EmptyState
          title={`No ${status === "all" ? "" : status + " "}invoices for ${monthLabel(month)}`}
          hint="Generate this month's invoices from the occupied units, or pick another month."
          action={<Button onClick={handleGenerate} disabled={busy}>Generate invoices</Button>}
        />
      ) : (
        <Card>
          <div className="border-b border-slate-200 px-4 py-3 text-sm text-slate-600">
            {shown.length} invoices · <Money value={shown.reduce((s, i) => s + i.total, 0)} className="font-semibold" /> billed ·{" "}
            <Money value={totalOutstanding} className={`font-semibold ${totalOutstanding > 0 ? "text-red-600" : "text-brand-600"}`} /> outstanding
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
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
                    <td className="px-4 py-3">
                      <Link to={`/app/tenants/${i.tenant_id}`} className="font-medium text-brand-600 hover:underline">
                        {i.tenant?.full_name ?? tenantName(i.tenant_id)}
                      </Link>
                    </td>
                    <td className="px-4 py-3">{i.unit?.label ?? "—"}</td>
                    <td className="px-4 py-3"><LinesBreakdown lines={i.lines} /></td>
                    <td className="px-4 py-3 text-right"><Money value={i.total} /></td>
                    <td className="px-4 py-3 text-right">
                      <Money value={i.balance} className={i.balance > 0 ? "font-semibold text-red-600" : ""} />
                    </td>
                    <td className="px-4 py-3">{i.due_date}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <InvoiceStatusBadge status={i.status} />
                        <Link to={`/print/invoice/${i.id}`} target="_blank" rel="noreferrer" className="text-xs font-medium text-brand-600 hover:underline">
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
    </div>
  );
}
