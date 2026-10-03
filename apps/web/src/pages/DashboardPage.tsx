import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { currentMonthKey, formatDate, formatKES, monthLabel } from "@kodi/shared";
import { useAuth } from "../lib/auth";
import {
  generateInvoices,
  getCollectionMode,
  getMonthCashSnapshot,
  listInvoices,
  listPayments,
  listTenants,
  listUnits,
} from "../lib/api";
import { Button } from "../components/Button";
import { Badge, Card, CardBody, EmptyState, ErrorBanner, PageHeader, Skeleton, Stat, TextLink } from "../components/ui";
import { useToast } from "../components/Toast";
import { InvoiceStatusBadge, Money, UnitStatusBadge } from "../components/domain";
import type { InvoiceWithRefs, PaymentWithRefs, Tenant, UnitWithTenant } from "../lib/types";

function DashboardSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div className="w-48 space-y-2">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-4 w-32" />
        </div>
        <Skeleton className="h-10 w-40" />
      </div>
      <Card>
        <CardBody>
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-2 h-12 w-40" />
          <Skeleton className="mt-4 h-2.5 w-full" />
        </CardBody>
      </Card>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i}>
            <CardBody className="space-y-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-7 w-28" />
              <Skeleton className="h-3 w-24" />
            </CardBody>
          </Card>
        ))}
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardBody className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardBody className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function CheckCircle({ done, n }: { done: boolean; n: number }) {
  return (
    <span
      className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
        done ? "bg-slate-900 text-white" : "border border-slate-300 text-slate-500"
      }`}
    >
      {done ? (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 8.5l3.5 3.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        n
      )}
    </span>
  );
}

/** First-run screen: the three steps between signup and the first invoice. */
function GettingStarted({ hasUnits, hasTenant, collection }: {
  hasUnits: boolean;
  hasTenant: boolean;
  collection: { mode: "own" | "platform" | "none"; shortcode?: string };
}) {
  const navigate = useNavigate();
  const mpesaReady = collection.mode !== "none";
  const mpesaDesc =
    collection.mode === "platform"
      ? `Tenants pay to Kodi Paybill ${collection.shortcode} with their own code — prompts and Paybill both record themselves.`
      : "Tenants get an STK prompt or a Paybill QR, and payments record themselves.";
  const steps: { done: boolean; optional?: boolean; title: string; desc: string; cta: string; to: string }[] = [
    {
      done: hasUnits,
      title: "Add a property",
      desc: "Your building or plot, and its units with monthly rent.",
      cta: "Add property",
      to: "/app/properties",
    },
    {
      done: hasTenant,
      title: "Add your first tenant",
      desc: "Assign them to a unit — rent tracking starts from move-in.",
      cta: "Add tenant",
      to: "/app/tenants",
    },
    {
      done: mpesaReady,
      optional: !mpesaReady,
      title: mpesaReady ? "M-Pesa is ready" : "Connect M-Pesa",
      desc: mpesaReady ? mpesaDesc : "Connect your own paybill, or collect through the Kodi Paybill once it's switched on.",
      cta: "Open settings",
      to: "/app/settings",
    },
  ];
  const nextIdx = steps.findIndex((s) => !s.done);

  return (
    <Card>
      <CardBody>
        <h2 className="font-semibold">Set up in three steps</h2>
        <ol className="mt-4 space-y-4">
          {steps.map((s, i) => (
            <li key={s.title} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <div className="flex min-w-0 items-start gap-3">
                <CheckCircle done={s.done} n={i + 1} />
                <div className="min-w-0">
                  <p className={`text-sm font-medium ${s.done ? "text-slate-400" : "text-slate-900"}`}>
                    {s.title}
                    {s.optional && <span className="ml-2 align-middle"><Badge tone="slate">optional</Badge></span>}
                  </p>
                  <p className={`mt-0.5 text-sm ${s.done ? "text-slate-400" : "text-slate-500"}`}>{s.desc}</p>
                </div>
              </div>
              {!s.done && (
                <Button
                  size="sm"
                  variant={i === nextIdx && !s.optional ? "primary" : "secondary"}
                  onClick={() => navigate(s.to)}
                >
                  {s.cta}
                </Button>
              )}
            </li>
          ))}
        </ol>
      </CardBody>
    </Card>
  );
}

export function DashboardPage() {
  const { org } = useAuth();
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [units, setUnits] = useState<UnitWithTenant[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [invoices, setInvoices] = useState<InvoiceWithRefs[]>([]);
  const [payments, setPayments] = useState<PaymentWithRefs[]>([]);
  const [collection, setCollection] = useState<{ mode: "own" | "platform" | "none"; shortcode?: string }>({ mode: "none" });
  const [cash, setCash] = useState<{ collected: number; expected: number; outstanding: number } | null>(null);

  const month = currentMonthKey();

  const load = async () => {
    if (!org) return;
    setLoading(true);
    setError(null);
    try {
      const [u, t, inv, pay, snapshot, mp] = await Promise.all([
        listUnits(org.id),
        listTenants(org.id),
        listInvoices(org.id, month),
        listPayments(org.id),
        getMonthCashSnapshot(org.id, month).catch(() => null),
        getCollectionMode(org.id).catch(() => null),
      ]);
      setUnits(u);
      setTenants(t);
      setInvoices(inv);
      setPayments(pay.slice(0, 8));
      if (mp !== null) setCollection(mp);
      setCash(snapshot);
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
      const n = await generateInvoices(org.id, month);
      toast(
        n === 0
          ? "No occupied units to invoice yet — add tenants to their units first."
          : `Generated ${n} invoice${n === 1 ? "" : "s"}.`,
        n === 0 ? "info" : "success",
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (loading) return <DashboardSkeleton />;
  if (error) return <ErrorBanner message={error} onRetry={load} />;

  // A brand-new org sees a checklist instead of a screen of zeros.
  // Units (not properties) count: a tenant needs an actual unit to move into.
  const hasUnits = units.length > 0;
  const hasTenant = tenants.length > 0;
  const setupDone = hasUnits && hasTenant;
  const suspended = org?.subscription_status === "suspended";

  if (!setupDone) {
    return (
      <div>
        {suspended && <SuspendedBanner />}
        <PageHeader
          title={org?.name ?? "Welcome"}
          sub="Let's set up your rent collection — three quick steps."
        />
        <GettingStarted hasUnits={hasUnits} hasTenant={hasTenant} collection={collection} />
        <p className="mt-4 text-xs text-slate-400">
          You can change the business name, plan and M-Pesa details any time in Settings.
        </p>
      </div>
    );
  }

function SuspendedBanner() {
  return (
    <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      <p className="font-semibold">This business is suspended.</p>
      <p className="mt-1">
        New invoices and M-Pesa collection are paused — your data is safe and exportable.
        Contact Kodi support to reactivate billing.
      </p>
    </div>
  );
}

  // Set up but nothing billed yet: one clear action instead of a 0% report.
  if (invoices.length === 0) {
    const occupied = units.filter((u) => u.status !== "vacant").length;
    return (
      <div>
        {suspended && <SuspendedBanner />}
        <PageHeader title={monthLabel(month)} sub="Everything is set up" />
        <Card>
          <CardBody>
            <h2 className="text-lg font-semibold">Ready to collect</h2>
            <p className="mt-1 max-w-xl text-sm text-slate-500">
              {occupied > 0
                ? `${occupied} occupied unit${occupied === 1 ? "" : "s"} ready to bill. Generate ${monthLabel(month)} invoices and tenants can pay by M-Pesa — or you record cash as it comes.`
                : `No occupied units yet. Assign a tenant to a unit, then generate ${monthLabel(month)} invoices to start collecting.`}
            </p>
            {occupied > 0 && (
              <Button className="mt-4" onClick={handleGenerate}>
                Generate {monthLabel(month)} invoices
              </Button>
            )}
          </CardBody>
        </Card>
      </div>
    );
  }

  const expected = cash?.expected ?? invoices.reduce((s, i) => s + i.total, 0);
  const outstanding = cash?.outstanding ?? invoices.reduce((s, i) => s + i.balance, 0);
  // Same cash definition as Reports: actual money received in the month
  // (paidAt window, active rows), never expected-minus-outstanding.
  const collected = cash?.collected ?? (expected - outstanding);
  const rate = expected ? Math.min(100, Math.round((collected / expected) * 100)) : 0;
  const occupied = units.filter((u) => u.status !== "vacant").length;
  const occupancy = units.length ? Math.round((occupied / units.length) * 100) : 0;
  const vacancies = units.filter((u) => u.status === "vacant");

  return (
    <div>
      {suspended && <SuspendedBanner />}
      <PageHeader
        title={monthLabel(month)}
        sub={`${invoices.length} invoice${invoices.length === 1 ? "" : "s"} this month`}
        actions={<TextLink to="/app/invoices" className="self-center">View invoices</TextLink>}
      />

      {/* The month's headline: how much of the rent due has actually landed. */}
      <Card>
        <CardBody>
          <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
            <div>
              <p className="text-sm text-slate-500">Collected so far</p>
              <p className="mt-1 text-5xl font-bold tabular-nums text-brand-600">{rate}%</p>
              <p className="mt-1 text-sm text-slate-500">
                {formatKES(collected)} received of {formatKES(expected)} expected
              </p>
            </div>
          </div>
          <div
            className="mt-4 h-2.5 overflow-hidden rounded-full bg-slate-100"
            role="progressbar"
            aria-valuenow={rate}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${rate}% of expected rent collected`}
          >
            <div className="h-full rounded-full bg-brand-500 transition-[width] duration-500" style={{ width: `${rate}%` }} />
          </div>
        </CardBody>
      </Card>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Outstanding" value={formatKES(outstanding)} sub="across all open invoices" accent={outstanding > 0 ? "red" : undefined} />
        <Stat label="Expected rent" value={formatKES(expected)} sub={monthLabel(month)} />
        <Stat label="Collected" value={formatKES(collected)} sub={expected ? `${Math.round((collected / expected) * 100)}% of expected` : "—"} accent="green" />
        <Stat label="Occupancy" value={`${occupancy}%`} sub={`${occupied}/${units.length} units, ${tenants.length} tenants`} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardBody>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">Recent payments</h2>
              <TextLink to="/app/payments">All payments</TextLink>
            </div>
            {payments.length === 0 ? (
              <EmptyState title="No payments yet" hint="Record cash, bank or M-Pesa payments from the Payments page." />
            ) : (
              <ul className="divide-y divide-slate-100">
                {payments.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{p.tenant?.full_name ?? "—"}</p>
                      <p className="text-xs text-slate-500">{p.receipt_no}</p>
                      <p className="text-xs text-slate-500">{formatDate(p.paid_at)}</p>
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
              <TextLink to="/app/properties">Manage properties</TextLink>
            </div>
            {vacancies.length === 0 ? (
              <EmptyState title="Fully occupied" hint="Every unit has a tenant assigned." />
            ) : (
              <ul className="divide-y divide-slate-100">
                {vacancies.slice(0, 8).map((u) => (
                  <li key={u.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="truncate font-medium">{u.label}</span>
                    <span className="flex shrink-0 items-center gap-2">
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
              <TextLink to="/app/invoices">Manage</TextLink>
            </div>
            <div className="overflow-x-auto">
              <table className="rtable w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
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
                      <td data-label="Tenant" className="py-2 pr-3 font-medium">{i.tenant?.full_name ?? "—"}</td>
                      <td data-label="Unit" className="py-2 pr-3">{i.unit?.label ?? "—"}</td>
                      <td data-label="Total" className="py-2 pr-3 text-right"><Money value={i.total} /></td>
                      <td data-label="Balance" className="py-2 pr-3 text-right"><Money value={i.balance} /></td>
                      <td data-label="Status" className="py-2"><InvoiceStatusBadge status={i.status} /></td>
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
