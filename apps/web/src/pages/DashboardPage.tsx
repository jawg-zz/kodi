import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { currentMonthKey, formatKES, monthLabel } from "@kodi/shared";
import { useAuth } from "../lib/auth";
import { generateInvoices, listInvoices, listPayments, listTenants, listUnits } from "../lib/api";
import { Button } from "../components/Button";
import { Badge, Card, CardBody, EmptyState, ErrorBanner, Loading, PageHeader, Stat } from "../components/ui";
import { InvoiceStatusBadge, Money, UnitStatusBadge } from "../components/domain";
import type { InvoiceWithRefs, PaymentWithRefs, Tenant, UnitWithTenant } from "../lib/types";

export function DashboardPage() {
  const { org } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [units, setUnits] = useState<UnitWithTenant[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [invoices, setInvoices] = useState<InvoiceWithRefs[]>([]);
  const [payments, setPayments] = useState<PaymentWithRefs[]>([]);

  const month = currentMonthKey();

  const load = async () => {
    if (!org) return;
    setLoading(true);
    setError(null);
    try {
      const [u, t, inv, pay] = await Promise.all([
        listUnits(org.id),
        listTenants(org.id),
        listInvoices(org.id, month),
        listPayments(org.id),
      ]);
      setUnits(u);
      setTenants(t);
      setInvoices(inv);
      setPayments(pay.slice(0, 8));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id]);

  const handleGenerate = async () => {
    if (!org) return;
    try {
      await generateInvoices(org.id, month);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (loading) return <Loading label="Loading dashboard…" />;
  if (error) return <ErrorBanner message={error} onRetry={load} />;

  const expected = invoices.reduce((s, i) => s + i.total, 0);
  const outstanding = invoices.reduce((s, i) => s + i.balance, 0);
  const collected = expected - outstanding;
  const occupied = units.filter((u) => u.status !== "vacant").length;
  const occupancy = units.length ? Math.round((occupied / units.length) * 100) : 0;
  const vacancies = units.filter((u) => u.status === "vacant");

  return (
    <div>
      <PageHeader
        title={monthLabel(month)}
        sub={`${org?.name} · ${invoices.length} invoices this month`}
        actions={
          invoices.length === 0 ? (
            <Button onClick={handleGenerate}>Generate {monthLabel(month)} invoices</Button>
          ) : (
            <Link to="/app/invoices">
              <Button variant="secondary">View invoices</Button>
            </Link>
          )
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Expected rent" value={formatKES(expected)} sub={monthLabel(month)} accent="blue" />
        <Stat label="Collected" value={formatKES(collected)} sub={expected ? `${Math.round((collected / expected) * 100)}% of expected` : "—"} accent="green" />
        <Stat label="Outstanding" value={formatKES(outstanding)} sub="across all open invoices" accent={outstanding > 0 ? "red" : undefined} />
        <Stat label="Occupancy" value={`${occupancy}%`} sub={`${occupied}/${units.length} units · ${tenants.length} tenants`} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardBody>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">Recent payments</h2>
              <Link to="/app/payments" className="text-sm font-medium text-brand-600 hover:underline">
                All payments
              </Link>
            </div>
            {payments.length === 0 ? (
              <EmptyState title="No payments yet" hint="Record cash, bank or M-Pesa payments from the Payments page." />
            ) : (
              <ul className="divide-y divide-slate-100">
                {payments.map((p) => (
                  <li key={p.id} className="flex items-center justify-between py-2 text-sm">
                    <div>
                      <p className="font-medium">{p.tenant?.full_name ?? "—"}</p>
                      <p className="text-xs text-slate-500">{p.receipt_no}</p>
                    </div>
                    <Money value={p.amount} className="font-semibold text-brand-600" />
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">Vacant units ({vacancies.length})</h2>
              <Link to="/app/properties" className="text-sm font-medium text-brand-600 hover:underline">
                Manage properties
              </Link>
            </div>
            {vacancies.length === 0 ? (
              <EmptyState title="Fully occupied" hint="Every unit has a tenant assigned." />
            ) : (
              <ul className="divide-y divide-slate-100">
                {vacancies.slice(0, 8).map((u) => (
                  <li key={u.id} className="flex items-center justify-between py-2 text-sm">
                    <span className="font-medium">{u.label}</span>
                    <span className="flex items-center gap-2">
                      <Money value={u.rent_amount} className="text-slate-500" />
                      <UnitStatusBadge status={u.status} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {invoices.length > 0 && (
        <Card className="mt-4">
          <CardBody>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">This month's invoices</h2>
              <Link to="/app/invoices" className="text-sm font-medium text-brand-600 hover:underline">
                Manage
              </Link>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                    <th className="py-2 pr-3">Tenant</th>
                    <th className="py-2 pr-3">Unit</th>
                    <th className="py-2 pr-3 text-right">Total</th>
                    <th className="py-2 pr-3 text-right">Balance</th>
                    <th className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {invoices.slice(0, 10).map((i) => (
                    <tr key={i.id}>
                      <td className="py-2 pr-3 font-medium">{i.tenant?.full_name ?? "—"}</td>
                      <td className="py-2 pr-3">{i.unit?.label ?? "—"}</td>
                      <td className="py-2 pr-3 text-right"><Money value={i.total} /></td>
                      <td className="py-2 pr-3 text-right"><Money value={i.balance} /></td>
                      <td className="py-2"><InvoiceStatusBadge status={i.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(() => {
              const inArrears = invoices.filter((i) => i.balance > 0).length;
              return inArrears > 0 ? (
                <p className="mt-3 text-sm text-slate-500">
                  <Badge tone="red">{inArrears} unpaid</Badge>{" "}
                  <span className="ml-1">invoices outstanding this month.</span>
                </p>
              ) : null;
            })()}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
