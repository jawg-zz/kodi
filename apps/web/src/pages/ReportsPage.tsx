import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
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
  getAuditTrail,
  getC2bStatus,
  getCollectionSummary,
  getDailyClose,
  getDepositsAndCredits,
  getMpesaHealth,
  getPaymentTimeliness,
  getPaymentsBreakdown,
  getPropertyCollection,
  getRentRoll,
  latestBalance,
  listDarajaJobs,
  listProperties,
  topUpFloat,
} from "../lib/api";
import type {
  ArrearsAging,
  AuditEvent,
  BalanceSnapshot,
  CollectionMonth,
  DailyClose,
  DarajaJob,
  DepositsAndCredits,
  MpesaHealth,
  PaymentTimeliness,
  PaymentsBreakdown,
  Property,
  PropertyCollectionRow,
  RentRoll,
} from "../lib/types";
import { getPlatformCollectionSummary, type PlatformCollectionSummary } from "../lib/api";
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
  const [platform, setPlatform] = useState<PlatformCollectionSummary>(null);
  const [error, setError] = useState<string | null>(null);

  const [preset, setPreset] = useState<Preset>("6");
  const [startMonth, setStartMonth] = useState(() => addMonths(currentMonthKey(), -5));
  const [endMonth, setEndMonth] = useState(() => currentMonthKey());
  const [propertyId, setPropertyId] = useState("all");

  const [properties, setProperties] = useState<Property[]>([]);
  const [collection, setCollection] = useState<CollectionMonth[]>([]);
  const [arrears, setArrears] = useState<ArrearsAging | null>(null);
  const [propCollection, setPropCollection] = useState<PropertyCollectionRow[]>([]);
  const [timeliness, setTimeliness] = useState<PaymentTimeliness | null>(null);
  const [paybillNo, setPaybillNo] = useState("");
  const [payments, setPayments] = useState<PaymentsBreakdown | null>(null);
  const [mpesa, setMpesa] = useState<MpesaHealth | null>(null);
  const [rentRoll, setRentRoll] = useState<RentRoll | null>(null);
  const [deposits, setDeposits] = useState<DepositsAndCredits | null>(null);
  const [dailyClose, setDailyClose] = useState<DailyClose | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [balance, setBalance] = useState<BalanceSnapshot | null>(null);
  const [outJobs, setOutJobs] = useState<DarajaJob[]>([]);

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
      const [props, coll, arr, pay, mpe, roll, dep, close, trail, propCol, timel] = await Promise.all([
        listProperties(org.id),
        getCollectionSummary({ orgId: org.id, startMonth: s, endMonth: e, propertyId: propFilter }),
        getArrearsAging({ orgId: org.id, propertyId: propFilter }),
        getPaymentsBreakdown({ orgId: org.id, ...windowMs, propertyId: propFilter }),
        getMpesaHealth({ orgId: org.id, ...windowMs }),
        getRentRoll({ orgId: org.id, propertyId: propFilter }),
        getDepositsAndCredits({ orgId: org.id, propertyId: propFilter }),
        getDailyClose({ orgId: org.id, ...windowMs }).catch(() => null),
        getAuditTrail(org.id).catch(() => []),
        getPropertyCollection({ orgId: org.id, startMonth: s, endMonth: e }).catch(() => []),
        getPaymentTimeliness({ orgId: org.id, startMonth: s, endMonth: e, propertyId: propFilter }).catch(() => null),
      ]);
      setProperties(props);
      setCollection(coll);
      setArrears(arr);
      setPayments(pay);
      setMpesa(mpe);
      setRentRoll(roll);
      setDeposits(dep);
      setDailyClose(close);
      setAudit(trail);
      setPropCollection(propCol);
      setTimeliness(timel);
      // Shortcode for WhatsApp reminder captions; fail soft — reminders
      // still work, just without the paybill number in the message.
      getC2bStatus()
        .then((s) => setPaybillNo(s.shortcode))
        .catch(() => {});
      try {
        setBalance(await latestBalance(org.id));
      } catch {
        setBalance(null);
      }
      try {
        const [b2c, rev, top] = await Promise.all([
          listDarajaJobs(org.id, "b2c").catch(() => []),
          listDarajaJobs(org.id, "reversal").catch(() => []),
          listDarajaJobs(org.id, "topup").catch(() => []),
        ]);
        setOutJobs([...b2c, ...rev, ...top].slice(0, 20));
      } catch {
        setOutJobs([]);
      }
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

  useEffect(() => {
    if (!org) return;
    getPlatformCollectionSummary(org.id).then(setPlatform).catch(() => setPlatform(null));
  }, [org?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-filled WhatsApp reminder: the arrears list's whole job is turning
  // balances into conversations, and WhatsApp is where those happen.
  const reminderLink = (a: ArrearsAging["rows"][number]): string => {
    const text =
      `Hi ${a.tenant_name}, a friendly reminder that your rent is behind by ` +
      `${new Intl.NumberFormat("en-US").format(a.balance)} KES (oldest: ${monthLabel(a.oldest_month)}). ` +
      `Kindly pay via M-Pesa Paybill${paybillNo ? ` ${paybillNo}` : ""}` +
      `${a.account_code ? `, account ${a.account_code}` : ""}. Thank you.`;
    return `https://wa.me/${a.phone}?text=${encodeURIComponent(text)}`;
  };

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
        ["Tenant", "Phone", "Account", "Property", "Open invoices", "Oldest month", "Bucket", "Balance (KES)", "Last payment"],
        arrears.rows.map((a) => [
          a.tenant_name,
          a.phone,
          a.account_code,
          a.property_name,
          a.open_count,
          monthLabel(a.oldest_month),
          a.bucket,
          a.balance,
          a.last_payment_at ? new Date(a.last_payment_at).toISOString().slice(0, 10) : "never",
        ]),
      ),
    );
  };

  const exportPropertyCsv = () => {
    if (propCollection.length === 0) return;
    downloadCsv(
      `kodi-properties-${rangeSuffix}.csv`,
      toCsv(
        ["Property", "Units", "Occupied", "Billed (KES)", "Collected (KES)", "Outstanding (KES)", "Rate (%)", "Invoices"],
        propCollection.map((p) => [
          p.property_name,
          p.units,
          p.occupied,
          p.expected,
          p.collected,
          p.outstanding,
          p.rate,
          p.invoice_count,
        ]),
      ),
    );
  };

  const exportTimelinessCsv = () => {
    if (!timeliness || timeliness.rows.length === 0) return;
    downloadCsv(
      `kodi-timeliness-${rangeSuffix}.csv`,
      toCsv(
        ["Tenant", "Invoices paid", "On time", "Late", "Avg days late", "Worst days late"],
        timeliness.rows.map((r) => [
          r.tenant_name,
          r.paid_count,
          r.on_time_count,
          r.late_count,
          r.avg_days_late,
          r.worst_days_late,
        ]),
      ),
    );
  };

  const exportPaymentsCsv = () => {
    if (!payments) return;
    downloadCsv(
      `kodi-payments-${rangeSuffix}.csv`,
      toCsv(
        ["Receipt", "Date", "Tenant", "Method", "M-Pesa code", "Amount (KES)", "Status", "Applied to", "Note"],
        payments.rows.map((p) => [
          p.receipt_no,
          fmtDate(p.paid_at),
          p.tenant_name,
          p.method,
          p.mpesa_code ?? "",
          p.amount,
          p.status ?? "active",
          p.allocation_summary ?? "",
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
            <Button variant="secondary" onClick={exportPropertyCsv}>Properties CSV</Button>
            <Button variant="secondary" onClick={exportTimelinessCsv}>Timeliness CSV</Button>
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
            <table className="rtable w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
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
                    <td data-label="Month" className="py-2 pr-3 font-medium">{monthLabel(c.month)}</td>
                    <td data-label="Invoices" className="py-2 pr-3 text-right">{c.invoice_count}</td>
                    <td data-label="Expected" className="py-2 pr-3 text-right"><Money value={c.expected} /></td>
                    <td data-label="Collected" className="py-2 pr-3 text-right"><Money value={c.collected} className="text-brand-600" /></td>
                    <td data-label="Outstanding" className="py-2 pr-3 text-right"><Money value={c.outstanding} className={c.outstanding > 0 ? "text-red-600" : undefined} /></td>
                    <td data-label="Rate" className="py-2 text-right">{c.expected ? `${c.rate}%` : "—"}</td>
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
              <table className="rtable w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                    <th className="py-2 pr-3">Tenant</th>
                    <th className="py-2 pr-3">Property</th>
                    <th className="py-2 pr-3">Account</th>
                    <th className="py-2 pr-3 text-right">Open invoices</th>
                    <th className="py-2 pr-3">Oldest</th>
                    <th className="py-2 pr-3">Last payment</th>
                    <th className="py-2 pr-3">Bucket</th>
                    <th className="py-2 pr-3 text-right">Balance</th>
                    <th className="py-2 text-right">Follow-up</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {arrears.rows.map((a) => (
                    <tr key={a.tenant_id} className="hover:bg-slate-50">
                      <td data-label="Tenant" className="py-2 pr-3 font-medium">
                        <Link to={`/app/tenants/${a.tenant_id}`} className="text-slate-900 underline-offset-2 hover:underline">
                          {a.tenant_name}
                        </Link>
                      </td>
                      <td data-label="Property" className="py-2 pr-3">{a.property_name}</td>
                      <td data-label="Account" className="py-2 pr-3 font-mono text-xs">{a.account_code || "—"}</td>
                      <td data-label="Open invoices" className="py-2 pr-3 text-right">{a.open_count}</td>
                      <td data-label="Oldest" className="py-2 pr-3">{monthLabel(a.oldest_month)}</td>
                      <td data-label="Last payment" className="py-2 pr-3 text-slate-500">
                        {a.last_payment_at ? new Date(a.last_payment_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "never"}
                      </td>
                      <td data-label="Bucket" className="py-2 pr-3"><Badge tone={bucketTone[a.bucket]}>{a.bucket}</Badge></td>
                      <td data-label="Balance" className="py-2 pr-3 text-right"><Money value={a.balance} className="font-semibold text-red-600" /></td>
                      <td data-label="Follow-up" className="py-2 text-right">
                        <a
                          href={reminderLink(a)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs font-medium text-brand-600 hover:underline"
                          title="Opens WhatsApp with a payment reminder pre-filled"
                        >
                          Remind
                        </a>
                      </td>
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
            <h2 className="mb-3 font-semibold">Property performance</h2>
            {propCollection.length === 0 ? (
              <p className="text-sm text-slate-500">No invoices in this range.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="rtable w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                      <th className="py-2 pr-3">Property</th>
                      <th className="py-2 pr-3 text-right">Occupancy</th>
                      <th className="py-2 pr-3 text-right">Billed</th>
                      <th className="py-2 pr-3 text-right">Collected</th>
                      <th className="py-2 pr-3 text-right">Outstanding</th>
                      <th className="py-2 text-right">Rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {propCollection.map((p) => (
                      <tr key={p.property_id ?? "unassigned"} className="hover:bg-slate-50">
                        <td data-label="Property" className="py-2 pr-3 font-medium">{p.property_name}</td>
                        <td data-label="Occupancy" className="py-2 pr-3 text-right text-slate-500">
                          {p.units > 0 ? `${p.occupied}/${p.units}` : "—"}
                        </td>
                        <td data-label="Billed" className="py-2 pr-3 text-right"><Money value={p.expected} /></td>
                        <td data-label="Collected" className="py-2 pr-3 text-right"><Money value={p.collected} className="text-brand-700" /></td>
                        <td data-label="Outstanding" className="py-2 pr-3 text-right"><Money value={p.outstanding} className={p.outstanding > 0 ? "text-red-600" : ""} /></td>
                        <td data-label="Rate" className="py-2 text-right font-medium">{p.expected ? `${p.rate}%` : "—"}</td>
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
            <h2 className="mb-1 font-semibold">Payment timeliness</h2>
            <p className="mb-3 text-sm text-slate-500">
              {timeliness && timeliness.paid_invoices > 0
                ? `${timeliness.on_time_rate}% of invoices were paid on or before the due date; late ones average ${timeliness.avg_days_late} days over.`
                : "No paid invoices in this range yet."}
            </p>
            {!timeliness || timeliness.rows.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing to score yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="rtable w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                      <th className="py-2 pr-3">Tenant</th>
                      <th className="py-2 pr-3 text-right">Paid</th>
                      <th className="py-2 pr-3 text-right">On time</th>
                      <th className="py-2 pr-3 text-right">Late</th>
                      <th className="py-2 pr-3 text-right">Avg late</th>
                      <th className="py-2 text-right">Worst</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {timeliness.rows.slice(0, 10).map((r) => (
                      <tr key={r.tenant_id} className="hover:bg-slate-50">
                        <td data-label="Tenant" className="py-2 pr-3 font-medium">
                          <Link to={`/app/tenants/${r.tenant_id}`} className="text-slate-900 underline-offset-2 hover:underline">
                            {r.tenant_name}
                          </Link>
                        </td>
                        <td data-label="Paid" className="py-2 pr-3 text-right">{r.paid_count}</td>
                        <td data-label="On time" className="py-2 pr-3 text-right text-brand-700">{r.on_time_count}</td>
                        <td data-label="Late" className="py-2 pr-3 text-right">{r.late_count}</td>
                        <td data-label="Avg late" className="py-2 pr-3 text-right">{r.avg_days_late > 0 ? `${r.avg_days_late}d` : "—"}</td>
                        <td data-label="Worst" className="py-2 text-right">
                          {r.worst_days_late > 0 ? (
                            <span className={r.worst_days_late >= 30 ? "font-semibold text-red-600" : ""}>{r.worst_days_late}d</span>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {timeliness.rows.length > 10 && (
                  <p className="mt-2 text-xs text-slate-400">Worst 10 shown, sorted by the longest overdue payment. Export for the full list.</p>
                )}
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardBody>
            <h2 className="mb-3 font-semibold">Payments by method</h2>
            {!payments || payments.count === 0 ? (
              <p className="text-sm text-slate-500">No payments in this range.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="rtable w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                      <th className="py-2 pr-3">Method</th>
                      <th className="py-2 pr-3 text-right">Count</th>
                      <th className="py-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {payments.by_method.map((m) => (
                      <tr key={m.method} className="hover:bg-slate-50">
                        <td data-label="Method" className="py-2 pr-3">{paymentMethodLabel(m.method)}</td>
                        <td data-label="Count" className="py-2 pr-3 text-right">{m.count}</td>
                        <td data-label="Total" className="py-2 text-right"><Money value={m.total} /></td>
                      </tr>
                    ))}
                    <tr className="font-semibold">
                      <td data-label="" className="py-2 pr-3">Total</td>
                      <td data-label="Count" className="py-2 pr-3 text-right">{payments.count}</td>
                      <td data-label="Total" className="py-2 text-right"><Money value={payments.total} /></td>
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
            {(mpesa?.channels ?? []).length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {mpesa!.channels.map((c) => (
                  <Badge key={c.channel} tone={c.count > 0 ? "blue" : "slate"}>
                    {c.channel}: {c.count} · {fmtKES(c.amount)}
                  </Badge>
                ))}
              </div>
            )}
            {!mpesa || mpesa.total === 0 ? (
              <p className="text-sm text-slate-500">No M-Pesa attempts in this range.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="rtable w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3 text-right">Count</th>
                      <th className="py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {mpesa.by_status.map((s) => (
                      <tr key={s.status} className="hover:bg-slate-50">
                        <td data-label="Status" className="py-2 pr-3">
                          <Badge tone={/success|matched/.test(s.status) ? "green" : /pending/.test(s.status) ? "amber" : "red"}>
                            {s.status}
                          </Badge>
                        </td>
                        <td data-label="Count" className="py-2 pr-3 text-right">{s.count}</td>
                        <td data-label="Amount" className="py-2 text-right"><Money value={s.amount} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {org && (
        <PayoutsCard
          orgId={org.id}
          balance={balance}
          jobs={outJobs}
          onChanged={load}
        />
      )}

      <Card className="mt-4">
        <CardBody>
          <h2 className="mb-1 font-semibold">Daily close</h2>
          <p className="mb-3 text-sm text-slate-500">
            Cash received per day with method and recorder split — sign off each day's money.
            {dailyClose && <> Total <Money value={dailyClose.total} className="font-semibold" /> across {dailyClose.count} payments.</>}
          </p>
          {!dailyClose || dailyClose.rows.length === 0 ? (
            <p className="text-sm text-slate-500">No cash received in this range.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="rtable w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                    <th className="py-2 pr-3">Day</th>
                    <th className="py-2 pr-3 text-right">Payments</th>
                    <th className="py-2 pr-3">Methods</th>
                    <th className="py-2 pr-3">Recorded by</th>
                    <th className="py-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {dailyClose.rows.slice(0, 31).map((d) => (
                    <tr key={d.day} className="hover:bg-slate-50">
                      <td data-label="Day" className="py-2 pr-3 font-medium">{d.day}</td>
                      <td data-label="Payments" className="py-2 pr-3 text-right">{d.count}</td>
                      <td data-label="Methods" className="py-2 pr-3 text-xs text-slate-500">
                        {d.by_method.map((m) => `${paymentMethodLabel(m.method)} ${fmtKES(m.total)}`).join(" · ")}
                      </td>
                      <td data-label="Recorded by" className="py-2 pr-3 text-xs text-slate-500">
                        {d.by_recorder.slice(0, 3).map((r) => `${r.recorder === "M-Pesa auto" ? "M-Pesa auto" : `staff ${r.recorder.slice(0, 8)}`} ${fmtKES(r.total)}`).join(" · ")}
                      </td>
                      <td data-label="Total" className="py-2 text-right"><Money value={d.collected} className="font-semibold" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardBody>
          <h2 className="mb-1 font-semibold">Audit trail</h2>
          <p className="mb-3 text-sm text-slate-500">
            Every ledger-touching event: payments, voids, refunds, C2B matches, credit sweeps.
          </p>
          {audit.length === 0 ? (
            <p className="text-sm text-slate-500">No audit events yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="rtable w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                    <th className="py-2 pr-3">When</th>
                    <th className="py-2 pr-3">Action</th>
                    <th className="py-2 pr-3">Entity</th>
                    <th className="py-2">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {audit.slice(0, 50).map((a) => (
                    <tr key={a.id} className="hover:bg-slate-50">
                      <td data-label="When" className="py-2 pr-3 text-xs text-slate-500">
                        {new Date(a.created_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                      </td>
                      <td data-label="Action" className="py-2 pr-3"><Badge tone="slate">{a.action}</Badge></td>
                      <td data-label="Entity" className="py-2 pr-3 text-xs text-slate-500">{a.entity_type}{a.entity_id ? ` ${a.entity_id.slice(0, 8)}` : ""}</td>
                      <td data-label="Detail" className="py-2 text-xs text-slate-500">{a.metadata ? a.metadata.slice(0, 120) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardBody>
          <h2 className="mb-3 font-semibold">Rent roll &amp; occupancy</h2>
          {!rentRoll || rentRoll.rows.length === 0 ? (
            <p className="text-sm text-slate-500">No properties yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="rtable w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
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
                      <td data-label="Property" className="py-2 pr-3 font-medium">{r.property_name}</td>
                      <td data-label="Units" className="py-2 pr-3 text-right">{r.units}</td>
                      <td data-label="Occupied" className="py-2 pr-3 text-right">{r.occupied}</td>
                      <td data-label="Vacant" className="py-2 pr-3 text-right">{r.vacant}</td>
                      <td data-label="Occupancy" className="py-2 pr-3 text-right">{r.occupancy_pct}%</td>
                      <td data-label="Monthly rent" className="py-2 pr-3 text-right"><Money value={r.monthly_rent} /></td>
                      <td data-label="Occupied rent" className="py-2 text-right"><Money value={r.occupied_rent} /></td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td data-label="" className="py-2 pr-3">Total</td>
                    <td data-label="Units" className="py-2 pr-3 text-right">{rentRoll.totals.units}</td>
                    <td data-label="Occupied" className="py-2 pr-3 text-right">{rentRoll.totals.occupied}</td>
                    <td data-label="Vacant" className="py-2 pr-3 text-right">{rentRoll.totals.vacant}</td>
                    <td data-label="Occupancy" className="py-2 pr-3 text-right">{rentRoll.totals.occupancy_pct}%</td>
                    <td data-label="Monthly rent" className="py-2 pr-3 text-right"><Money value={rentRoll.totals.monthly_rent} /></td>
                    <td data-label="Occupied rent" className="py-2 text-right"><Money value={rentRoll.totals.occupied_rent} /></td>
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

      {platform !== null && (
        <Card className="mt-4">
          <CardBody>
            <h2 className="mb-1 font-semibold">Kodi Paybill collections</h2>
            <p className="mb-3 text-sm text-slate-500">
              Money collected into the platform paybill on behalf of each business, awaiting settlement.
            </p>
            {platform.rows.length === 0 ? (
              <p className="text-sm text-slate-500">No platform-paybill collections yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="rtable w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                      <th className="py-2 pr-3">Business</th>
                      <th className="py-2 pr-3 text-right">Payments</th>
                      <th className="py-2 pr-3 text-right">Unsettled</th>
                      <th className="py-2 text-right">Settled</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {platform.rows.map((r) => (
                      <tr key={r.orgId}>
                        <td data-label="Business" className="py-2 pr-3 font-medium">{r.orgName}</td>
                        <td data-label="Payments" className="py-2 pr-3 text-right">{r.count}</td>
                        <td data-label="Unsettled" className="py-2 pr-3 text-right">
                          <Money value={r.unsettled} className={r.unsettled > 0 ? "font-semibold text-red-600" : ""} />
                        </td>
                        <td data-label="Settled" className="py-2 text-right"><Money value={r.settled} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-3 text-xs text-slate-400">
              Total unsettled: {fmtKES(platform.totalUnsettled)}. Settle by paying the business directly, then record the payout from here (coming soon).
            </p>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

/**
 * Payouts & float: latest M-Pesa balance snapshot, MMF→Utility top-up,
 * and recent B2C/reversal/topup job history.
 */
function PayoutsCard({ orgId, balance, jobs, onChanged }: {
  orgId: string;
  balance: BalanceSnapshot | null;
  jobs: DarajaJob[];
  onChanged: () => Promise<void>;
}) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const topUp = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = Math.round(Number(amount));
    if (!Number.isFinite(value) || value <= 0) {
      setError("Enter a top-up amount in KES.");
      return;
    }
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const r = await topUpFloat(orgId, value);
      setAmount("");
      setMsg(`Top-up accepted (${r.conversation_id}) — the result lands on the job row below.`);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-4">
      <CardBody>
        <h2 className="mb-1 font-semibold">Payouts & float</h2>
        <p className="mb-3 text-sm text-slate-500">
          B2C refunds debit the Utility account — keep it funded from MMF. Balance snapshots come from the
          Account Balance query (Settings → Verification, or the nightly job).
        </p>
        {balance && balance.balances.length > 0 ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {balance.balances.map((b) => (
              <Badge key={b.account} tone="blue">
                {b.account}: {fmtKES(b.balance)}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="mb-3 text-sm text-slate-500">No balance snapshot yet — run “Check balance” in Settings → Verification.</p>
        )}
        <form onSubmit={topUp} className="flex max-w-lg flex-wrap items-end gap-2">
          <Field label="Top up float MMF → Utility (KES)">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="numeric"
              placeholder="50000"
              className="w-full max-w-44 rounded-lg border border-slate-200 p-2 text-sm"
            />
          </Field>
          <Button type="submit" variant="secondary" disabled={busy}>{busy ? "Sending…" : "Top up float"}</Button>
        </form>
        {error && <div className="mt-2 max-w-lg"><ErrorBanner message={error} /></div>}
        {msg && <p className="mt-2 text-sm font-medium text-brand-700">{msg}</p>}
        {jobs.length > 0 && (
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {jobs.map((j) => (
              <li key={j.id} className="flex items-center justify-between gap-2 py-1.5">
                <span className="truncate">
                  <Badge tone={j.status === "done" ? "green" : j.status === "failed" ? "red" : "amber"}>{j.status}</Badge>{" "}
                  <span className="ml-1 font-mono text-xs text-slate-500">{j.kind}</span>{" "}
                  <span className="text-slate-600">{j.request_summary ?? j.conversation_id}</span>
                </span>
                <span className="shrink-0 text-xs text-slate-400">{(j.result_desc ?? "").slice(0, 60)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
