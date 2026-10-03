import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth";
import { convex } from "../lib/convex";
import { api } from "../../../../convex/_generated/api";
import { formatKES } from "@kodi/shared";
import { Badge, Card, CardBody, ErrorBanner, Loading, PageHeader } from "../components/ui";
import { Button } from "../components/Button";
import { Field, Input, Select } from "../components/Field";

type OrgRow = {
  orgId: string;
  name: string;
  plan: string;
  status: string;
  units: number;
  tenants: number;
  collection: "own" | "platform" | "none";
  unsettled: number;
  lastPaymentAt?: number;
};

type LedgerRow = {
  at: number;
  orgName: string;
  amount: number;
  fee?: number;
  kind: "manual" | "auto" | null;
  payoutRef?: string;
  pending: boolean;
};

const STATUS_TONE: Record<string, "green" | "amber" | "red" | "slate" | "blue" | "purple"> = {
  active: "green",
  trialing: "blue",
  past_due: "amber",
  suspended: "red",
};

const PLANS = ["starter", "growth", "pro"] as const;
const STATUSES = ["trialing", "active", "past_due", "suspended"] as const;

export function OperatorPage() {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [fee, setFee] = useState<{ feePct: number; feeCapKes: number } | null>(null);
  const [feeForm, setFeeForm] = useState({ feePct: "1.5", feeCapKes: "3000" });
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [operators, setOperators] = useState<{ userId: string; createdAt: number }[]>([]);
  const [pendingInvites, setPendingInvites] = useState<{ email: string; expiresAt: number }[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const { loading: authLoading } = useAuth();

  const load = async () => {
    setError(null);
    try {
      const admin = (await convex.query((api as any).operator.amPlatformAdmin, {})) as boolean;
      setIsAdmin(admin);
      if (!admin) return;
      const [rows, feeRow, ledgerRows] = await Promise.all([
        convex.query((api as any).operator.orgOverview, {}) as Promise<OrgRow[]>,
        convex.query((api as any).operator.getFeeSettings, {}) as Promise<{
          feePct: number;
          feeCapKes: number;
        } | null>,
        convex.query((api as any).operator.forwardLedger, { take: 30 }) as Promise<LedgerRow[]>,
      ]);
      setOrgs(rows);
      setLedger(ledgerRows);
      try {
        const ops = (await convex.query((api as any).operator.listOperators, {})) as {
          admins: { userId: string; createdAt: number }[];
          pending: { email: string; expiresAt: number }[];
        };
        setOperators(ops.admins);
        setPendingInvites(ops.pending);
      } catch {
        // listOperators fails for non-admins — page already guards.
      }
      setFee(feeRow);
      if (feeRow) {
        setFeeForm({ feePct: String(feeRow.feePct), feeCapKes: String(feeRow.feeCapKes) });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (!authLoading) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading]);

  if (authLoading || isAdmin === null) return <Loading label="Checking operator access…" />;
  if (!isAdmin) {
    return <ErrorBanner message="This page is for platform operators only." />;
  }

  const saveFee = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await convex.mutation((api as any).operator.setFeeSettings, {
        feePct: Number(feeForm.feePct),
        feeCapKes: Number(feeForm.feeCapKes),
      });
      setMsg("Fee saved — applies to platform collections from now on.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Operator console"
        sub={`${orgs.length} orgs${orgs.length === 1 ? "" : "s"} on the platform`}
      />
      {error && <ErrorBanner message={error} />}
      {msg && <p className="mb-4 text-sm font-medium text-brand-700">{msg}</p>}

      <OperatorsCard
        operators={operators}
        pending={pendingInvites}
        inviteEmail={inviteEmail}
        setInviteEmail={setInviteEmail}
        inviteLink={inviteLink}
        setInviteLink={setInviteLink}
        onChanged={load}
      />

      <Card className="mb-4">
        <CardBody>
          <h2 className="mb-1 font-semibold">Platform fee (managed-paybill collections)</h2>
          <p className="mb-3 text-sm text-slate-500">
            Deducted at settlement — {fee ? `${fee.feePct}% capped at ${formatKES(fee.feeCapKes)} per business per month` : "not set yet"}.
          </p>
          <form onSubmit={saveFee} className="flex max-w-lg flex-wrap items-end gap-2">
            <Field label="Fee percent">
              <Input
                value={feeForm.feePct}
                onChange={(e) => setFeeForm({ ...feeForm, feePct: e.target.value })}
                inputMode="decimal"
                className="max-w-24"
              />
            </Field>
            <Field label="Monthly cap (KES)">
              <Input
                value={feeForm.feeCapKes}
                onChange={(e) => setFeeForm({ ...feeForm, feeCapKes: e.target.value })}
                inputMode="numeric"
                className="max-w-32"
              />
            </Field>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save fee"}</Button>
          </form>
        </CardBody>
      </Card>

      <div className="overflow-x-auto">
        <table className="rtable w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
              <th className="py-2 pr-3">Business</th>
              <th className="py-2 pr-3">Plan</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2 pr-3 text-right">Units</th>
              <th className="py-2 pr-3 text-right">Tenants</th>
              <th className="py-2 pr-3">Collects via</th>
              <th className="py-2 pr-3 text-right">Owed</th>
              <th className="py-2 pr-3">Last activity</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {orgs.map((o) => (
              <OrgRowEditor key={o.orgId} row={o} onChanged={load} />
            ))}
          </tbody>
        </table>
      </div>

      <Card className="mt-4">
        <CardBody>
          <h2 className="mb-1 font-semibold">Forward ledger</h2>
          <p className="mb-3 text-sm text-slate-500">
            What the platform collected, forwarded, and earned — newest first.
          </p>
          {ledger.length === 0 ? (
            <p className="text-sm text-slate-500">No collections yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="rtable w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                    <th className="py-2 pr-3">When</th>
                    <th className="py-2 pr-3">Business</th>
                    <th className="py-2 pr-3 text-right">Amount</th>
                    <th className="py-2 pr-3 text-right">Fee</th>
                    <th className="py-2 pr-3">Settled by</th>
                    <th className="py-2 pr-3">Ref</th>
                    <th className="py-2">State</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {ledger.map((r, i) => (
                    <tr key={`${r.at}-${i}`}>
                      <td data-label="When" className="py-2 pr-3 text-xs text-slate-500">
                        {new Date(r.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                      </td>
                      <td data-label="Business" className="py-2 pr-3 font-medium">{r.orgName}</td>
                      <td data-label="Amount" className="py-2 pr-3 text-right">{formatKES(r.amount)}</td>
                      <td data-label="Fee" className="py-2 pr-3 text-right text-brand-600">
                        {r.fee !== undefined ? formatKES(r.fee) : "—"}
                      </td>
                      <td data-label="Settled by" className="py-2 pr-3">
                        {r.kind === "auto" ? <Badge tone="green">auto</Badge> : r.kind === "manual" ? <Badge tone="slate">manual</Badge> : <Badge tone="amber">pending</Badge>}
                      </td>
                      <td data-label="Ref" className="py-2 pr-3 font-mono text-xs">{r.payoutRef ?? "—"}</td>
                      <td data-label="State" className="py-2 text-xs text-slate-500">
                        {r.pending ? "owing" : "forwarded"}
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
  );
}

function OrgRowEditor({ row, onChanged }: { row: OrgRow; onChanged: () => Promise<void> }) {
  const [plan, setPlan] = useState(row.plan);
  const [status, setStatus] = useState(row.status);
  const [settleAmt, setSettleAmt] = useState("");
  const [settleRef, setSettleRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      await convex.mutation((api as any).operator.setOrgPlanStatus, {
        orgId: row.orgId,
        plan,
        status,
      });
      setOk("Saved.");
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const settle = async () => {
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const res = (await convex.mutation((api as any).operator.recordSettlement, {
        orgId: row.orgId,
        amount: Number(settleAmt),
        payoutRef: settleRef,
      })) as { rows: number; settled: number };
      setOk(`Settled ${formatKES(res.settled)} across ${res.rows} row${res.rows === 1 ? "" : "s"}.`);
      setSettleAmt("");
      setSettleRef("");
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className={row.status === "suspended" ? "bg-red-50/40" : undefined}>
      <td data-label="Business" className="py-2 pr-3 font-medium">{row.name}</td>
      <td data-label="Plan" className="py-2 pr-3">
        <Select value={plan} onChange={(e) => setPlan(e.target.value)} className="max-w-28">
          {PLANS.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </Select>
      </td>
      <td data-label="Status" className="py-2 pr-3">
        <span className="flex items-center gap-2">
          <Badge tone={STATUS_TONE[row.status] ?? "slate"}>{row.status}</Badge>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="max-w-32">
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </Select>
        </span>
      </td>
      <td data-label="Units" className="py-2 pr-3 text-right">{row.units}</td>
      <td data-label="Tenants" className="py-2 pr-3 text-right">{row.tenants}</td>
      <td data-label="Collects via" className="py-2 pr-3">
        <Badge tone={row.collection === "own" ? "blue" : row.collection === "platform" ? "green" : "slate"}>
          {row.collection}
        </Badge>
      </td>
      <td data-label="Owed" className="py-2 pr-3 text-right">
        <span className={row.unsettled > 0 ? "font-semibold text-red-600" : ""}>
          {formatKES(row.unsettled)}
        </span>
      </td>
      <td data-label="Last activity" className="py-2 pr-3 text-xs text-slate-500">
        {row.lastPaymentAt ? new Date(row.lastPaymentAt).toLocaleDateString("en-GB") : "—"}
      </td>
      <td data-label="Actions" className="py-2">
        <div className="flex flex-wrap items-center gap-1">
          <Button size="sm" variant="secondary" onClick={save} disabled={busy}>Save</Button>
          {row.unsettled > 0 && (
            <>
              <Input
                value={settleAmt}
                onChange={(e) => setSettleAmt(e.target.value)}
                inputMode="numeric"
                placeholder="KES"
                className="max-w-24"
              />
              <Input
                value={settleRef}
                onChange={(e) => setSettleRef(e.target.value)}
                placeholder="M-Pesa ref"
                className="max-w-32"
              />
              <Button size="sm" variant="secondary" onClick={settle} disabled={busy}>
                Settle
              </Button>
            </>
          )}
        </div>
        {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
        {ok && <p className="mt-1 text-xs font-medium text-brand-700">{ok}</p>}
      </td>
    </tr>
  );
}

function OperatorsCard({ operators, pending, inviteEmail, setInviteEmail, inviteLink, setInviteLink, onChanged }: {
  operators: { userId: string; createdAt: number }[];
  pending: { email: string; expiresAt: number }[];
  inviteEmail: string;
  setInviteEmail: (v: string) => void;
  inviteLink: string | null;
  setInviteLink: (v: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setBusy(true);
    setError(null);
    setInviteLink(null);
    try {
      const r = (await convex.mutation((api as any).operator.inviteOperator, {
        email: inviteEmail.trim(),
      })) as { email: string; inviteToken: string };
      setInviteLink(`${window.location.origin}/operator/accept?token=${r.inviteToken}`);
      setInviteEmail("");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (userId: string) => {
    setBusy(true);
    setError(null);
    try {
      await convex.mutation((api as any).operator.removeOperator, { userId });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mb-4">
      <CardBody>
        <h2 className="mb-1 font-semibold">Operators</h2>
        <p className="mb-3 text-sm text-slate-500">
          People who can open this console, settle money, and change plans.
        </p>
        <ul className="mb-3 divide-y divide-slate-100 text-sm">
          {operators.map((o) => (
            <li key={o.userId} className="flex items-center justify-between gap-2 py-2">
              <span>
                <span className="font-mono text-xs">{o.userId.slice(0, 18)}…</span>
                <span className="ml-2 text-xs text-slate-500">
                  since {new Date(o.createdAt).toLocaleDateString("en-GB")}
                </span>
              </span>
              {operators.length > 1 && (
                <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50" onClick={() => remove(o.userId)} disabled={busy}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
        {pending.length > 0 && (
          <p className="mb-3 text-xs text-slate-500">
            Pending: {pending.map((p) => p.email).join(", ")}
          </p>
        )}
        <form onSubmit={invite} className="flex max-w-lg flex-wrap items-end gap-2">
          <Field label="Invite operator by email">
            <Input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="ops@example.com"
              className="max-w-64"
            />
          </Field>
          <Button type="submit" variant="secondary" disabled={busy}>
            {busy ? "Inviting…" : "Invite operator"}
          </Button>
        </form>
        {error && <div className="mt-2"><ErrorBanner message={error} /></div>}
        {inviteLink && (
          <div className="mt-3 space-y-2 rounded-lg border border-slate-200 p-3">
            <p className="break-all font-mono text-xs text-slate-600">{inviteLink}</p>
            <div className="flex flex-wrap gap-2">
              <a
                href={`https://wa.me/?text=${encodeURIComponent(`Kodi platform operator invite (expires in 7 days): ${inviteLink}`)}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
              >
                Share on WhatsApp
              </a>
              <Button size="sm" variant="secondary" onClick={() => { void navigator.clipboard?.writeText(inviteLink); }}>
                Copy link
              </Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
