import { useEffect, useMemo, useState } from "react";
import { addMonths, currentMonthKey, downloadCsv, monthLabel, toCsv } from "@kodi/shared";
import { useAuth } from "../lib/auth";
import { listInvoices, listPayments, listProperties, listTenants, listUnits } from "../lib/api";
import type { InvoiceWithRefs, PaymentWithRefs, Property, Tenant, Unit } from "../lib/types";
import { Button } from "../components/Button";
import { Field, Select } from "../components/Field";
import { Card, CardBody, ErrorBanner, Loading, PageHeader, Stat } from "../components/ui";
import { Money } from "../components/domain";

const MONTHS_BACK = 6;

export function ReportsPage() {
  const { org } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<InvoiceWithRefs[]>([]);
  const [payments, setPayments] = useState<PaymentWithRefs[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [propertyId, setPropertyId] = useState("all");

  useEffect(() => {
    if (!org) return;
    Promise.all([
      listInvoices(org.id),
      listPayments(org.id),
      listTenants(org.id),
      listProperties(org.id),
      listUnits(org.id),
    ])
      .then(([inv, pay, t, p, u]) => {
        setInvoices(inv);
        setPayments(pay);
        setTenants(t);
        setProperties(p);
        setUnits(u);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [org?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const months = useMemo(() => {
    const out: string[] = [];
    for (let i = 0; i < MONTHS_BACK; i++) out.push(addMonths(currentMonthKey(), -i));
    return out.reverse();
  }, []);

  if (loading) return <Loading label="Loading reports…" />;
  if (error) return <ErrorBanner message={error} />;

  const tenantById = new Map(tenants.map((t) => [t.id, t]));

  const collection = months.map((m) => {
    const inv = invoices.filter((i) => i.month === m);
    const expected = inv.reduce((s, i) => s + i.total, 0);
    const outstanding = inv.reduce((s, i) => s + i.balance, 0);
    return { month: m, expected, collected: expected - outstanding, outstanding, count: inv.length };
  });

  const totalOutstanding = invoices.reduce((s, i) => s + i.balance, 0);
  const totalCollected30 = payments
    .filter((p) => Date.now() - new Date(p.paid_at).getTime() < 30 * 86400_000)
    .reduce((s, p) => s + p.amount, 0);

  // Arrears per tenant (open balances), optionally filtered by property
  // via the tenant's current unit -> property mapping.
  const unitById = new Map(units.map((u) => [u.id, u]));
  const arrears = tenants
    .map((t) => {
      const open = invoices.filter((i) => i.tenant_id === t.id && i.balance > 0);
      const balance = open.reduce((s, i) => s + i.balance, 0);
      const oldest = open.length ? open.map((i) => i.month).sort()[0] : null;
      return { tenant: t, balance, count: open.length, oldest };
    })
    .filter((a) => a.balance > 0)
    .filter((a) => {
      if (propertyId === "all") return true;
      const unit = a.tenant.unit_id ? unitById.get(a.tenant.unit_id) : undefined;
      return unit?.property_id === propertyId;
    })
    .sort((a, b) => b.balance - a.balance);

  const maxBar = Math.max(1, ...collection.map((c) => c.expected));

  const exportCollectionCsv = () => {
    downloadCsv(
      `kodi-collection-${currentMonthKey()}.csv`,
      toCsv(
        ["Month", "Invoices", "Expected (KES)", "Collected (KES)", "Outstanding (KES)"],
        collection.map((c) => [monthLabel(c.month), c.count, c.expected, c.collected, c.outstanding])
      )
    );
  };

  const exportArrearsCsv = () => {
    downloadCsv(
      `kodi-arrears-${currentMonthKey()}.csv`,
      toCsv(
        ["Tenant", "Phone", "Open invoices", "Oldest month", "Balance (KES)"],
        arrears.map((a) => [
          a.tenant.full_name,
          a.tenant.phone,
          a.count,
          a.oldest ? monthLabel(a.oldest) : "",
          a.balance,
        ])
      )
    );
  };

  const exportPaymentsCsv = () => {
    downloadCsv(
      `kodi-payments-${currentMonthKey()}.csv`,
      toCsv(
        ["Receipt", "Date", "Tenant", "Method", "M-Pesa code", "Amount (KES)", "Note"],
        payments.map((p) => [
          p.receipt_no,
          new Date(p.paid_at).toISOString().slice(0, 10),
          p.tenant?.full_name ?? tenantById.get(p.tenant_id)?.full_name ?? "",
          p.method,
          p.mpesa_code ?? "",
          p.amount,
          p.note ?? "",
        ])
      )
    );
  };

  return (
    <div>
      <PageHeader
        title="Reports"
        sub="Collection performance, arrears, and CSV exports"
        actions={
          <>
            <Button variant="secondary" onClick={exportCollectionCsv}>Collection CSV</Button>
            <Button variant="secondary" onClick={exportArrearsCsv}>Arrears CSV</Button>
            <Button variant="secondary" onClick={exportPaymentsCsv}>Payments CSV</Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Outstanding (all time)" value={new Intl.NumberFormat("en-US").format(totalOutstanding) + " KES"} accent={totalOutstanding > 0 ? "red" : "green"} />
        <Stat label="Collected (last 30 days)" value={new Intl.NumberFormat("en-US").format(totalCollected30) + " KES"} accent="green" />
        <Stat label="Tenants in arrears" value={String(arrears.length)} sub={`${tenants.length} tenants total`} accent={arrears.length ? "amber" : undefined} />
      </div>

      <Card className="mt-4">
        <CardBody>
          <h2 className="mb-3 font-semibold">Collection by month (last {MONTHS_BACK} months)</h2>
          <div className="space-y-2">
            {collection.map((c) => (
              <div key={c.month} className="grid grid-cols-[110px_1fr_90px] items-center gap-3 text-sm">
                <span className="font-medium">{monthLabel(c.month)}</span>
                <div className="h-5 overflow-hidden rounded bg-slate-100">
                  <div
                    className="h-full rounded bg-brand-500"
                    style={{ width: `${c.expected ? Math.round((c.collected / Math.max(1, c.expected)) * 100) : 0}%`, maxWidth: "100%" }}
                    title={`Collected ${c.collected} of ${c.expected}`}
                  />
                </div>
                <span className="text-right text-xs text-slate-500">
                  {c.expected ? `${Math.round((c.collected / c.expected) * 100)}%` : "—"}
                </span>
                <span className="sr-only">{c.month}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-400">Bar width cap reference: {maxBar.toLocaleString()} KES max expected.</p>
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardBody>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <h2 className="font-semibold">Arrears aging ({arrears.length})</h2>
            <div className="w-52">
              <Field label="Property">
                <Select value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
                  <option value="all">All properties</option>
                  {properties.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </Select>
              </Field>
            </div>
          </div>
          {arrears.length === 0 ? (
            <p className="text-sm text-slate-500">No outstanding balances. Well done!</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                    <th className="py-2 pr-3">Tenant</th>
                    <th className="py-2 pr-3 text-right">Open invoices</th>
                    <th className="py-2 pr-3">Oldest</th>
                    <th className="py-2 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {arrears.map((a) => (
                    <tr key={a.tenant.id}>
                      <td className="py-2 pr-3 font-medium">{a.tenant.full_name}</td>
                      <td className="py-2 pr-3 text-right">{a.count}</td>
                      <td className="py-2 pr-3">{a.oldest ? monthLabel(a.oldest) : "—"}</td>
                      <td className="py-2 text-right"><Money value={a.balance} className="font-semibold text-red-600" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
