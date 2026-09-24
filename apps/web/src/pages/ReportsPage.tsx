import { useEffect, useMemo, useState } from "react";
import {
  addMonths,
  currentMonthKey,
  downloadCsv,
  monthLabel,
  monthRangeList,
  monthStartMs,
  toCsv,
} from "@kodi/shared";
import { useAuth } from "../lib/auth";
import {
  getArrearsAging,
  getCollectionSummary,
  getDepositsAndCredits,
  getMpesaHealth,
  getPaymentsBreakdown,
  getRentRoll,
  listProperties,
} from "../lib/api";
import type {
  ArrearsAging,
  CollectionMonth,
  DepositsAndCredits,
  MpesaHealth,
  PaymentsBreakdown,
  Property,
  RentRoll,
} from "../lib/types";
import { Button } from "../components/Button";
import { Field, Select } from "../components/Field";
import { Badge, Card, CardBody, ErrorBanner, Loading, PageHeader, Stat } from "../components/ui";
import { Money, paymentMethodLabel } from "../components/domain";

type Preset = "3" | "6" | "12" | "ytd" | "custom";

const PRESET_LABELS: Record<Preset, string> = {
  "3": "Last 3 months",
  "6": "Last 6 months",
  "12": "Last 12 months",
  ytd: "Year to date",
  custom: "Custom range",
};

function monthsForPreset(preset: Preset, start: string, end: string): [string, string] {
  const now = currentMonthKey();
  if (preset === "custom") return [start, end];
  if (preset === "ytd") return [`${now.slice(0, 4)}-01`, now];
  return [addMonths(now, -(Number(preset) - 1)), now];
}

const fmtInt = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(n));
const fmtKES = (n: number) => `${fmtInt(n)} KES`;
const fmtDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

const bucketTone: Record<string, "green" | "amber" | "red" | "blue"> = {
  Current: "green",
  "30+": "blue",
  "60+": "amber",
  "90+": "red",
};

export function ReportsPage() {
  const { org } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [preset, setPreset] = useState<Preset>("6");
  const [startMonth, setStartMonth] = useState(() => addMonths(currentMonthKey(), -5));
  const [endMonth, setEndMonth] = useState(() => currentMonthKey());
  const [propertyId, setPropertyId] = useState("all");

  const [properties, setProperties] = useState<Property[]>([]);
  const [collection, setCollection] = useState<CollectionMonth[]>([]);
  const [arrears, setArrears] = useState<ArrearsAging | null>(null);
  const [payments, setPayments] = useState<PaymentsBreakdown | null>(null);
  const [mpesa, setMpesa] = useState<MpesaHealth | null>(null);
  const [rentRoll, setRentRoll] = useState<RentRoll | null>(null);
  const [deposits, setDeposits] = useState<DepositsAndCredits | null>(null);

  const [start, end] = monthsForPreset(preset, startMonth, endMonth);
  const propFilter = propertyId === "all" ? undefined : propertyId;
  const propSuffix = propertyId === "all" ? "" : `-${properties.find((p) => p.id === propertyId)?.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") ?? "prop"}`;
  const rangeSuffix = `${start.replace("-", "")}-to-${end.replace("-", "")}${propSuffix}`;

  const load = async () => {
    if (!org) return;
    setLoading(true);
    setError(null);
    try {
      const [s, e] = monthsForPreset(preset, startMonth, endMonth);
      const months = monthRangeList(s, e);
      const windowMs = {
        startMs: monthStartMs(months[0]),
        endMs: monthStartMs(addMonths(months[months.length - 1], 1)),
      };
      const [props, coll, arr, pay, mpe, roll, dep] = await Promise.all([
        listProperties(org.id),
        getCollectionSummary({ orgId: org.id, startMonth: s, endMonth: e, propertyId: propFilter }),
        getArrearsAging({ orgId: org.id, propertyId: propFilter }),
        getPaymentsBreakdown({ orgId: org.id, ...windowMs, propertyId: propFilter }),
        getMpesaHealth({ orgId: org.id, ...windowMs }),
        getRentRoll({ orgId: org.id, propertyId: propFilter }),
        getDepositsAndCredits({ orgId: org.id, propertyId: propFilter }),
      ]);
      setProperties(props);
      setCollection(coll);
      setArrears(arr);
      setPayments(pay);
      setMpesa(mpe);
      setRentRoll(roll);
      setDeposits(dep);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!org) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id, preset, startMonth, endMonth, propertyId]);

  const totals = useMemo(() => {
    const expected = collection.reduce((s, c) => s + c.expected, 0);
    const collected = collection.reduce((s, c) => s + c.collected, 0);
    return {
      expected,
      collected,
      rate: expected > 0 ? Math.round((collected / expected) * 1000) / 10 : 0,
    };
  }, [collection]);

  if (loading) return <Loading label="Loading reports…" />;
  if (error) return <ErrorBanner message={error} onRetry={load} />;

  const exportCollectionCsv = () => {
    downloadCsv(
      `kodi-collection-${rangeSuffix}.csv`,
      toCsv(
        ["Month", "Invoices", "Expected (KES)", "Collected (KES)", "Outstanding (KES)", "Rate (%)"],
        collection.map((c) => [monthLabel(c.month), c.invoice_count, c.expected, c.collected, c.outstanding, c.rate]),
      ),
    );
  };

  const exportArrearsCsv = () => {
    if (!arrears) return;
    downloadCsv(
      `kodi-arrears-${rangeSuffix}.csv`,
      toCsv(
        ["Tenant", "Phone", "Property", "Open invoices", "Oldest month", "Bucket", "Balance (KES)"],
        arrears.rows.map((a) => [
          a.tenant_name,
          a.phone,
          a.property_name,
          a.open_count,
          monthLabel(a.oldest_month),
          a.bucket,
          a.balance,
        ]),
      ),
    );
  };

  const exportPaymentsCsv = () => {
    if (!payments) return;
    downloadCsv(
      `kodi-payments-${rangeSuffix}.csv`,
      toCsv(
        ["Receipt", "Date", "Tenant", "Method", "M-Pesa code", "Amount (KES)", "Note"],
        payments.rows.map((p) => [
          p.receipt_no,
          fmtDate(p.paid_at),
          p.tenant_name,
          p.method,
          p.mpesa_code ?? "",
          p.amount,
          p.note ?? "",
        ]),
      ),
    );
  };

  const exportRentRollCsv = () => {
    if (!rentRoll) return;
    downloadCsv(
      `kodi-rent-roll-${rangeSuffix}.csv`,
      toCsv(
        ["Property", "Units", "Occupied", "Vacant", "On notice", "Occupancy (%)", "Monthly rent (KES)", "Occupied rent (KES)"],
        rentRoll.rows.map((r) => [
          r.property_name,
          r.units,
          r.occupied,
          r.vacant,
          r.notice,
          r.occupancy_pct,
          r.monthly_rent,
          r.occupied_rent,
        ]),
      ),
    );
  };

  const maxBar = Math.max(1, ...collection.map((c) => c.expected));

  return (
    <div>
      <PageHeader
        title="Reports"
        sub="Collection performance, arrears, occupancy, and exports"
        actions={
          <>
            <Button variant="secondary" onClick={exportCollectionCsv}>Collection CSV</Button>
            <Button variant="secondary" onClick={exportArrearsCsv}>Arrears CSV</Button>
            <Button variant="secondary" onClick={exportPaymentsCsv}>
              Payments CSV{payments?.truncated ? " (capped at 5,000)" : ""}
            </Button>
            <Button variant="secondary" onClick={exportRentRollCsv}>Rent roll CSV</Button>
          </>
        }
      />

      <Card className="mb-4">
        <CardBody>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-44">
              <Field label="Range">
                <Select value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
                  {(Object.keys(PRESET_LABELS) as Preset[]).map((p) => (
                    <option key={p} value={p}>{PRESET_LABELS[p]}</option>
                  ))}
                </Select>
              </Field>
            </div>
            {preset === "custom" && (
              <>
                <div className="w-40">
                  <Field label="Start month">
                    <Select value={startMonth} onChange={(e) => setStartMonth(e.target.value)}>
                      {monthRangeList(addMonths(currentMonthKey(), -36), currentMonthKey()).map((m) => (
                        <option key={m} value={m}>{monthLabel(m)}</option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <div className="w-40">
                  <Field label="End month">
                    <Select value={endMonth} onChange={(e) => setEndMonth(e.target.value)}>
                      {monthRangeList(addMonths(currentMonthKey(), -36), currentMonthKey()).map((m) => (
                        <option key={m} value={m}>{monthLabel(m)}</option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </>
            )}
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
            <p className="pb-2 text-xs text-slate-400">
              {monthLabel(start)} – {monthLabel(end)}
              {payments?.truncated && " · payment rows capped at 5,000 in exports"}
            </p>
          </div>
        </CardBody>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Outstanding (all time)" value={fmtKES(arrears?.total_balance ?? 0)} accent={(arrears?.total_balance ?? 0) > 0 ? "red" : "green"} />
        <Stat label={`Collected (${monthLabel(start)} – ${monthLabel(end)})`} value={fmtKES(totals.collected)} sub={`${totals.rate}% collection rate`} accent="green" />
        <Stat label="Tenants in arrears" value={String(arrears?.tenants_in_arrears ?? 0)} accent={(arrears?.tenants_in_arrears ?? 0) ? "amber" : undefined} />
        <Stat
          label="Occupancy"
          value={`${rentRoll?.totals.occupancy_pct ?? 0}%`}
          sub={`${rentRoll?.totals.occupied ?? 0} of ${rentRoll?.totals.units ?? 0} units occupied`}
        />
      </div>

      <Card className="mt-4">
        <CardBody>
          <h2 className="mb-3 font-semibold">Collection by month (actual cash received)</h2>
          <div className="space-y-2">
            {collection.map((c) => (
              <div key={c.month} className="grid grid-cols-[110px_1fr_90px] items-center gap-3 text-sm">
                <span className="font-medium">{monthLabel(c.month)}</span>
                <div className="h-5 overflow-hidden rounded bg-slate-100">
                  <div
                    className="h-full rounded bg-brand-500"
                    style={{ width: `${c.expected ? Math.round((c.collected / Math.max(1, c.expected)) * 100) : 0}%`, maxWidth: "100%" }}
                    title={`Collected ${fmtKES(c.collected)} of ${fmtKES(c.expected)} expected · ${fmtKES(c.outstanding)} outstanding`}
                  />
                </div>
                <span className="text-right text-xs text-slate-500">
                  {c.expected ? `${c.rate}%` : "—"}
                </span>
                <span className="sr-only">{c.month}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                  <th className="py-2 pr-3">Month</th>
                  <th className="py-2 pr-3 text-right">Invoices</th>
                  <th className="py-2 pr-3 text-right">Expected</th>
                  <th className="py-2 pr-3 text-right">Collected</th>
                  <th className="py-2 pr-3 text-right">Outstanding</th>
                  <th className="py-2 text-right">Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {collection.map((c) => (
                  <tr key={c.month} className="hover:bg-slate-50">
                    <td className="py-2 pr-3 font-medium">{monthLabel(c.month)}</td>
                    <td className="py-2 pr-3 text-right">{c.invoice_count}</td>
                    <td className="py-2 pr-3 text-right"><Money value={c.expected} /></td>
                    <td className="py-2 pr-3 text-right"><Money value={c.collected} className="text-brand-600" /></td>
                    <td className="py-2 pr-3 text-right"><Money value={c.outstanding} className={c.outstanding > 0 ? "text-red-600" : undefined} /></td>
                    <td className="py-2 text-right">{c.expected ? `${c.rate}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-slate-400">Collected is actual cash received in the month (payment date), not expected minus outstanding. Bar scale: {fmtKES(maxBar)} max expected.</p>
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardBody>
          <h2 className="mb-3 font-semibold">Arrears aging ({arrears?.tenants_in_arrears ?? 0})</h2>
          <div className="mb-3 flex flex-wrap gap-2">
            {(arrears?.buckets ?? []).map((b) => (
              <Badge key={b.bucket} tone={bucketTone[b.bucket]}>
                {b.bucket}: {fmtKES(b.balance)} · {b.count}
              </Badge>
            ))}
          </div>
          {!arrears || arrears.rows.length === 0 ? (
            <p className="text-sm text-slate-500">No outstanding balances. Well done!</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                    <th className="py-2 pr-3">Tenant</th>
                    <th className="py-2 pr-3">Property</th>
                    <th className="py-2 pr-3 text-right">Open invoices</th>
                    <th className="py-2 pr-3">Oldest</th>
                    <th className="py-2 pr-3">Bucket</th>
                    <th className="py-2 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {arrears.rows.map((a) => (
                    <tr key={a.tenant_id} className="hover:bg-slate-50">
                      <td className="py-2 pr-3 font-medium">{a.tenant_name}</td>
                      <td className="py-2 pr-3">{a.property_name}</td>
                      <td className="py-2 pr-3 text-right">{a.open_count}</td>
                      <td className="py-2 pr-3">{monthLabel(a.oldest_month)}</td>
                      <td className="py-2 pr-3"><Badge tone={bucketTone[a.bucket]}>{a.bucket}</Badge></td>
                      <td className="py-2 text-right"><Money value={a.balance} className="font-semibold text-red-600" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardBody>
            <h2 className="mb-3 font-semibold">Payments by method</h2>
            {!payments || payments.count === 0 ? (
              <p className="text-sm text-slate-500">No payments in this range.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                      <th className="py-2 pr-3">Method</th>
                      <th className="py-2 pr-3 text-right">Count</th>
                      <th className="py-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {payments.by_method.map((m) => (
                      <tr key={m.method} className="hover:bg-slate-50">
                        <td className="py-2 pr-3">{paymentMethodLabel(m.method)}</td>
                        <td className="py-2 pr-3 text-right">{m.count}</td>
                        <td className="py-2 text-right"><Money value={m.total} /></td>
                      </tr>
                    ))}
                    <tr className="font-semibold">
                      <td className="py-2 pr-3">Total</td>
                      <td className="py-2 pr-3 text-right">{payments.count}</td>
                      <td className="py-2 text-right"><Money value={payments.total} /></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <h2 className="mb-3 font-semibold">
              M-Pesa health{" "}
              <span className="text-sm font-normal text-slate-500">
                ({mpesa?.success_rate ?? 0}% success)
              </span>
            </h2>
            {!mpesa || mpesa.total === 0 ? (
              <p className="text-sm text-slate-500">No M-Pesa attempts in this range.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3 text-right">Count</th>
                      <th className="py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {mpesa.by_status.map((s) => (
                      <tr key={s.status} className="hover:bg-slate-50">
                        <td className="py-2 pr-3">
                          <Badge tone={s.status === "success" ? "green" : s.status === "pending" ? "amber" : "red"}>
                            {s.status}
                          </Badge>
                        </td>
                        <td className="py-2 pr-3 text-right">{s.count}</td>
                        <td className="py-2 text-right"><Money value={s.amount} /></td>
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
          <h2 className="mb-3 font-semibold">Rent roll &amp; occupancy</h2>
          {!rentRoll || rentRoll.rows.length === 0 ? (
            <p className="text-sm text-slate-500">No properties yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                    <th className="py-2 pr-3">Property</th>
                    <th className="py-2 pr-3 text-right">Units</th>
                    <th className="py-2 pr-3 text-right">Occupied</th>
                    <th className="py-2 pr-3 text-right">Vacant</th>
                    <th className="py-2 pr-3 text-right">Occupancy</th>
                    <th className="py-2 pr-3 text-right">Monthly rent</th>
                    <th className="py-2 text-right">Occupied rent</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rentRoll.rows.map((r) => (
                    <tr key={r.property_id} className="hover:bg-slate-50">
                      <td className="py-2 pr-3 font-medium">{r.property_name}</td>
                      <td className="py-2 pr-3 text-right">{r.units}</td>
                      <td className="py-2 pr-3 text-right">{r.occupied}</td>
                      <td className="py-2 pr-3 text-right">{r.vacant}</td>
                      <td className="py-2 pr-3 text-right">{r.occupancy_pct}%</td>
                      <td className="py-2 pr-3 text-right"><Money value={r.monthly_rent} /></td>
                      <td className="py-2 text-right"><Money value={r.occupied_rent} /></td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td className="py-2 pr-3">Total</td>
                    <td className="py-2 pr-3 text-right">{rentRoll.totals.units}</td>
                    <td className="py-2 pr-3 text-right">{rentRoll.totals.occupied}</td>
                    <td className="py-2 pr-3 text-right">{rentRoll.totals.vacant}</td>
                    <td className="py-2 pr-3 text-right">{rentRoll.totals.occupancy_pct}%</td>
                    <td className="py-2 pr-3 text-right"><Money value={rentRoll.totals.monthly_rent} /></td>
                    <td className="py-2 text-right"><Money value={rentRoll.totals.occupied_rent} /></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardBody>
          <h2 className="mb-3 font-semibold">Deposits &amp; credits</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <p className="text-sm text-slate-500">Deposits held</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{fmtKES(deposits?.deposit_held_total ?? 0)}</p>
              <p className="mt-1 text-xs text-slate-500">{deposits?.tenants_holding_deposit ?? 0} tenants</p>
            </div>
            <div>
              <p className="text-sm text-slate-500">Settled ({deposits?.settlements_count ?? 0})</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{fmtKES(deposits?.settled_refunds ?? 0)}</p>
              <p className="mt-1 text-xs text-slate-500">{fmtKES(deposits?.settled_deductions ?? 0)} deducted</p>
            </div>
            <div>
              <p className="text-sm text-slate-500">Credit carryover</p>
              <p className="mt-1 text-2xl font-bold text-brand-600">{fmtKES(deposits?.credit_balance_total ?? 0)}</p>
              <p className="mt-1 text-xs text-slate-500">{deposits?.tenants_with_credit ?? 0} tenants</p>
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
