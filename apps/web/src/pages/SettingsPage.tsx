import { useEffect, useState } from "react";
import { PLANS, currentMonthKey, formatKES, planByCode } from "@kodi/shared";
import { useAuth } from "../lib/auth";
import {
  backfillAccountCodes,
  countUnits,
  createProperty,
  createTenant,
  createUnit,
  exportOrgBackup,
  generateInvoices,
  getC2bStatus,
  getMpesaCreds,
  inviteUser,
  listPayments,
  listStaff,
  recordManualPayment,
  registerC2bUrls,
  saveMpesaCreds,
  simulateC2b,
  updateOrg,
  type MpesaCredsView,
} from "../lib/api";
import { Money } from "../components/domain";
import { Button } from "../components/Button";
import { Field, Input, Select } from "../components/Field";
import { Badge, Card, CardBody, ErrorBanner, Loading, PageHeader } from "../components/ui";

export function SettingsPage() {
  const { org, membership } = useAuth();
  const [staff, setStaff] = useState<{ user_id: string; role: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!org) return;
    let cancelled = false;
    listStaff(org.id)
      .then((s) => { if (!cancelled) setStaff(s); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [org?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <Loading label="Loading settings…" />;
  if (!org) return <ErrorBanner message="No organization found." />;

  return (
    <div className="space-y-4">
      <PageHeader title="Settings" sub={org.name} />
      {error && <ErrorBanner message={error} />}
      <OrgProfileSection />
      <PlanSection />
      <StaffSection staff={staff} isOwner={membership?.role === "owner"} />
      <DarajaSection />
      <DataSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
function OrgProfileSection() {
  const { org, membership, refresh } = useAuth();
  const [name, setName] = useState(org?.name ?? "");
  const [dueDay, setDueDay] = useState(String(org?.invoice_due_day ?? 5));
  const [reversalLimit, setReversalLimit] = useState(
    String(org?.reversal_limit ?? 50000),
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!org) return;
    const day = Math.min(28, Math.max(1, parseInt(dueDay, 10) || 5));
    const limit = Math.max(0, Math.min(10_000_000, parseInt(reversalLimit, 10) || 0));
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await updateOrg(org.id, {
        name: name.trim(),
        invoice_due_day: day,
        ...(membership?.role === "owner" ? { reversal_limit: limit } : {}),
      });
      await refresh();
      setMsg("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardBody>
        <h2 className="mb-3 font-semibold">Business profile</h2>
        <form onSubmit={save} className="grid max-w-lg gap-4">
          <Field label="Business name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Invoice due day" hint="Day of the month rent is due (1–28). Used for new invoices.">
            <Input type="number" min={1} max={28} value={dueDay} onChange={(e) => setDueDay(e.target.value)} />
          </Field>
          <Field
            label="Reversal limit (KES)"
            hint="Voids/refunds at or above this need the owner. 0 disables the gate. Owner-only."
          >
            <Input
              type="number"
              min={0}
              max={10000000}
              value={reversalLimit}
              onChange={(e) => setReversalLimit(e.target.value)}
              disabled={membership?.role !== "owner"}
            />
          </Field>
          {error && <ErrorBanner message={error} />}
          {msg && <p className="text-sm text-green-700">{msg}</p>}
          <div><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button></div>
        </form>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
function PlanSection() {
  const { org, refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unitCount, setUnitCount] = useState<number | null>(null);

  useEffect(() => {
    if (org) countUnits(org.id).then(setUnitCount).catch(() => setUnitCount(null));
  }, [org?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!org) return null;
  const current = planByCode(org.plan_code);

  const choose = async (code: string) => {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await updateOrg(org.id, { plan_code: code as typeof org.plan_code });
      await refresh();
      setMsg(`Plan changed to ${planByCode(code).name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardBody>
        <h2 className="mb-1 font-semibold">Plan & subscription</h2>
        <p className="mb-3 text-sm text-slate-500">
          Current: <Badge tone="blue">{current.name}</Badge>{" "}
          <span className="ml-1">
            {unitCount !== null ? `${unitCount}/${current.maxUnits} units used` : ""}
          </span>{" "}
          · Status: <Badge tone={org.subscription_status === "active" ? "green" : org.subscription_status === "past_due" ? "red" : "amber"}>{org.subscription_status}</Badge>
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          {PLANS.map((p) => (
            <div key={p.code} className={`rounded-lg border p-3 ${p.code === org.plan_code ? "border-brand-600 ring-2 ring-brand-100" : "border-slate-200"}`}>
              <p className="font-semibold">{p.name}</p>
              <p className="text-sm text-slate-500">Up to {p.maxUnits} units</p>
              <p className="mt-1 text-sm font-semibold">{p.priceKes === 0 ? "Free" : `${formatKES(p.priceKes)}/mo`}</p>
              {p.code !== org.plan_code && (
                <Button size="sm" variant="secondary" className="mt-2" disabled={busy} onClick={() => choose(p.code)}>
                  Switch
                </Button>
              )}
            </div>
          ))}
        </div>
        {error && <div className="mt-2"><ErrorBanner message={error} /></div>}
        {msg && <p className="mt-2 text-sm text-green-700">{msg}</p>}
        <p className="mt-3 text-xs text-slate-400">
          Paid plans are collected manually for now: after switching, our team contacts you to arrange M-Pesa payment and activates your subscription.
        </p>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
function StaffSection({ staff, isOwner }: { staff: { user_id: string; role: string; name: string }[]; isOwner: boolean }) {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await inviteUser({ email: email.trim(), fullName: fullName.trim(), phone: phone.trim(), kind: "manager" });
      setResult(
        `Invite created for ${r.email}. Share this link: ${window.location.origin}/invite/${r.inviteToken} — it expires in 7 days.`,
      );
      setEmail("");
      setFullName("");
      setPhone("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardBody>
        <h2 className="mb-3 font-semibold">Managers & caretakers</h2>
        <ul className="mb-4 divide-y divide-slate-100 text-sm">
          {staff.map((s) => (
            <li key={s.user_id} className="flex items-center justify-between py-2">
              <span className="font-medium">{s.name}</span>
              <Badge tone={s.role === "owner" ? "purple" : "slate"}>{s.role}</Badge>
            </li>
          ))}
        </ul>
        {isOwner ? (
          <form onSubmit={send} className="grid max-w-lg gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Full name" required><Input value={fullName} onChange={(e) => setFullName(e.target.value)} required /></Field>
              <Field label="Email" required><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
            </div>
            <Field label="Phone"><Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0712 345 678" /></Field>
            {error && <ErrorBanner message={error} />}
            {result && <p className="text-sm text-green-700">{result}</p>}
            <div><Button type="submit" disabled={busy}>{busy ? "Inviting…" : "Invite manager"}</Button></div>
          </form>
        ) : (
          <p className="text-sm text-slate-500">Only the owner can invite managers.</p>
        )}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
function DarajaSection() {
  const [creds, setCreds] = useState<MpesaCredsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [env, setEnv] = useState<"sandbox" | "production">("sandbox");
  const [consumerKey, setConsumerKey] = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");
  const [shortcode, setShortcode] = useState("");
  const [passkey, setPasskey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    getMpesaCreds()
      .then((c) => {
        setCreds(c);
        setEnv(c.environment);
        setShortcode(c.shortcode);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!consumerKey.trim() || !consumerSecret.trim() || !shortcode.trim() || !passkey.trim()) {
      setError("All four fields are required. Leave them blank-looking? Re-enter every field when updating.");
      return;
    }
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await saveMpesaCreds({ environment: env, consumerKey: consumerKey.trim(), consumerSecret: consumerSecret.trim(), shortcode: shortcode.trim(), passkey: passkey.trim() });
      setConsumerKey("");
      setConsumerSecret("");
      setPasskey("");
      setMsg("M-Pesa credentials saved (stored encrypted).");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardBody>
        <h2 className="mb-1 font-semibold">M-Pesa (Daraja API)</h2>
        <p className="mb-3 text-sm text-slate-500">
          {loading ? "Checking…" : creds?.configured
            ? <>Connected: {creds.environment} · shortcode {creds.shortcode} <Badge tone="green">configured</Badge></>
            : <>Not configured — STK Push is disabled until you save credentials. <Badge tone="amber">manual payments still work</Badge></>}
        </p>
        {!loading && error && error.includes("Could not reach") && (
          <div className="mb-3">
            <Button variant="secondary" onClick={load}>Retry connection</Button>
          </div>
        )}
        <form onSubmit={save} className="grid max-w-lg gap-3">
          <Field label="Environment">
            <Select value={env} onChange={(e) => setEnv(e.target.value as "sandbox" | "production")}>
              <option value="sandbox">Sandbox (test keys from developer.safaricom.co.ke)</option>
              <option value="production">Production (requires Safaricom go-live approval)</option>
            </Select>
          </Field>
          <Field label="Consumer key" required><Input value={consumerKey} onChange={(e) => setConsumerKey(e.target.value)} placeholder={creds?.configured ? "•••• (re-enter to change)" : ""} /></Field>
          <Field label="Consumer secret" required><Input type="password" value={consumerSecret} onChange={(e) => setConsumerSecret(e.target.value)} placeholder={creds?.configured ? "•••• (re-enter to change)" : ""} /></Field>
          <Field label="Shortcode (paybill / till)" required hint="Sandbox default: 174379"><Input value={shortcode} onChange={(e) => setShortcode(e.target.value)} /></Field>
          <Field label="Passkey" required><Input type="password" value={passkey} onChange={(e) => setPasskey(e.target.value)} placeholder={creds?.configured ? "•••• (re-enter to change)" : ""} /></Field>
          {error && <ErrorBanner message={error} />}
          {msg && <p className="text-sm text-green-700">{msg}</p>}
          <div><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save credentials"}</Button></div>
        </form>
        <C2bSection />
      </CardBody>
    </Card>
  );
}

/**
 * Paybill (C2B) wiring: one-time URL registration per shortcode so tenants
 * can pay from the M-Pesa menu and Kodi auto-records the confirmation.
 * Owner-only (Daraja credentials live here); re-register after changing
 * shortcode or environment.
 */
function C2bSection() {
  const [status, setStatus] = useState<{ configured: boolean; shortcode: string; registered: boolean; registered_at: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    getC2bStatus()
      .then(setStatus)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const register = async () => {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await registerC2bUrls();
      setMsg("Paybill URLs registered — tenants can now pay from the M-Pesa menu. Share each tenant's account code from their detail page.");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!status?.configured) return null;

  return (
    <div className="mt-6 border-t border-slate-100 pt-4">
      <h3 className="font-semibold">Paybill (tenant self-serve)</h3>
      <p className="mt-1 text-sm text-slate-500">
        {status.registered
          ? <>Paybill {status.shortcode} is live — confirmations auto-record. <Badge tone="green">registered</Badge></>
          : <>Registers this shortcode's M-Pesa menu payments with Kodi. <Badge tone="amber">not registered</Badge></>}
      </p>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-600">
        <li>Register the URLs below (once per shortcode).</li>
        <li>Each tenant pays via M-Pesa → Lipa na M-Pesa → Paybill {status.shortcode}, account = their code (shown in the portal).</li>
        <li>Matched payments record automatically; anything unmatched waits in Payments → Paybill review.</li>
      </ol>
      <p className="mt-2 max-w-lg text-xs text-slate-500">
        Paybill shortcodes only: till numbers have no account-number field, so Kodi
        cannot tell tenants apart on a till — keep collections on the Paybill number
        above, and record any till payments by hand with the transaction code.
      </p>
      {error && <div className="mt-2 max-w-lg"><ErrorBanner message={error} /></div>}
      {msg && <p className="mt-2 text-sm text-green-700">{msg}</p>}
      <div className="mt-3">
        <Button variant="secondary" onClick={register} disabled={busy}>
          {busy ? "Registering…" : status.registered ? "Re-register Paybill URLs" : "Register Paybill URLs"}
        </Button>
      </div>
      <SimulatorSection />
    </div>
  );
}

/**
 * Paybill sandbox: dry-run a confirmation against the real matching and
 * allocation logic. Nothing is written — new staff learn what typos,
 * unknown phones, and overpayments do before touching live money.
 */
function SimulatorSection() {
  const { org } = useAuth();
  const [billRef, setBillRef] = useState("");
  const [msisdn, setMsisdn] = useState("");
  const [amount, setAmount] = useState("");
  const [result, setResult] = useState<{
    match: { tenant_name: string; reason: string } | null;
    preview: { month: string; balance: number; applied: number }[];
    leftover: number;
    suggestions: { tenant_name: string; score: number; signals: string[] }[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!org) return;
    const value = Math.round(Number(amount));
    if (!Number.isFinite(value) || value < 1) {
      setError("Enter a simulation amount in KES.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await simulateC2b({
        orgId: org.id,
        billRef: billRef.trim() || undefined,
        msisdn: msisdn.trim(),
        amount: value,
      });
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 border-t border-slate-100 pt-4">
      <h3 className="font-semibold">Paybill simulator (no money moves)</h3>
      <p className="mt-1 text-sm text-slate-500">
        Pretend a tenant paid from the M-Pesa menu — see who would match and how the cash would split.
      </p>
      <form onSubmit={run} className="mt-3 grid max-w-lg gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Account typed">
            <Input value={billRef} onChange={(e) => setBillRef(e.target.value.toUpperCase())} placeholder="GC-A1" />
          </Field>
          <Field label="Sender phone" required>
            <Input value={msisdn} onChange={(e) => setMsisdn(e.target.value)} placeholder="0712 345 678" inputMode="tel" required />
          </Field>
        </div>
        <Field label="Amount (KES)" required>
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" placeholder="15000" required />
        </Field>
        {error && <ErrorBanner message={error} />}
        {result && (
          <div className="rounded-lg bg-slate-50 p-3 text-sm">
            {result.match ? (
              <>
                <p>Would match <strong>{result.match.tenant_name}</strong> ({result.match.reason}).</p>
                <ul className="mt-1 space-y-0.5 text-slate-600">
                  {result.preview.map((p) => (
                    <li key={p.month} className="flex justify-between">
                      <span>{p.month}</span><Money value={p.applied} />
                    </li>
                  ))}
                  {result.leftover > 0 && (
                    <li className="flex justify-between text-brand-700">
                      <span>Prepaid credit</span><Money value={result.leftover} className="font-semibold" />
                    </li>
                  )}
                  {result.preview.length === 0 && <li className="text-slate-500">No open invoices — all held as credit.</li>}
                </ul>
              </>
            ) : (
              <>
                <p className="font-medium">Would park in Paybill review — no match.</p>
                {result.suggestions.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-slate-600">
                    {result.suggestions.map((s) => (
                      <li key={s.tenant_name}>Maybe {s.tenant_name} ({s.signals.join(" · ")})</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
        <div><Button type="submit" variant="secondary" disabled={busy}>{busy ? "Simulating…" : "Simulate payment"}</Button></div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
const DEMO_MONTHS = [0, -1, -2];

const DEMO_FIRST = [
  "Jane", "John", "Mary", "Peter", "Grace", "David", "Sarah", "Michael",
  "Faith", "James", "Lucy", "Daniel", "Ann", "Paul", "Esther", "Samuel",
  "Ruth", "Stephen", "Beatrice", "Francis",
];
const DEMO_LAST = [
  "Wanjiku", "Otieno", "Achieng", "Kamau", "Njeri", "Mwangi", "Atieno",
  "Ochieng", "Nyambura", "Kiptoo", "Cherono", "Mutiso", "Wafula",
  "Ouma", "Waithera", "Kariuki", "Moraa", "Onyango", "Wambui", "Maina",
];

/** Deterministic demo phone per index (2547XXXXXXXX, valid Safaricom range). */
function demoPhone(i: number): string {
  return `2547${String(220000000 + i * 137913).slice(0, 9)}`;
}

function DataSection() {
  const { org } = useAuth();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const seedDemo = async () => {
    if (!org) return;
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      // Two demo properties, 20 tenants total: mixed rents, one bedsitter
      // block + one apartment block, so reports/filters have shape.
      const specs = [
        {
          name: "Baraka Court (Demo)",
          property_type: "apartments" as const,
          location: "Kilimani, Nairobi",
          units: Array.from({ length: 12 }, (_, i) => ({
            label: `A${i + 1}`,
            rent: [25000, 25000, 22000, 22000, 20000, 20000, 18000, 18000, 28000, 28000, 24000, 24000][i],
            water: 500,
            garbage: 300,
          })),
        },
        {
          name: "Maweni Bedsitters (Demo)",
          property_type: "bedsitters" as const,
          location: "Kasarani, Nairobi",
          units: Array.from({ length: 8 }, (_, i) => ({
            label: `B${i + 1}`,
            rent: [12000, 12000, 10500, 10500, 13500, 13500, 11000, 11000][i],
            water: 300,
            garbage: 200,
          })),
        },
      ];
      let tenantIdx = 0;
      const created: { id: string; rent: number }[] = [];
      for (const p of specs) {
        const prop = await createProperty(org.id, {
          name: p.name,
          property_type: p.property_type,
          location: p.location,
          notes: "Demo data — delete when done exploring.",
        });
        for (const u of p.units) {
          const unit = await createUnit(org.id, {
            property_id: prop.id,
            label: u.label,
            unit_type: p.property_type === "bedsitters" ? "bedsitter" : "one_br",
            rent_amount: u.rent,
            water_charge: u.water,
            garbage_charge: u.garbage,
          });
          const i = tenantIdx++;
          const tenant = await createTenant(org.id, {
            full_name: `${DEMO_FIRST[i]} ${DEMO_LAST[i]}`,
            phone: demoPhone(i),
            national_id: String(20000000 + i * 73111),
            unit_id: unit.id,
            move_in_date: "2026-04-01",
            deposit_held: u.rent,
          });
          created.push({ id: tenant.id, rent: u.rent + u.water + u.garbage });
        }
      }
      for (const back of DEMO_MONTHS) {
        const d = new Date();
        d.setMonth(d.getMonth() + back);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        await generateInvoices(org.id, key);
      }
      // Realistic payment spread: most pay in full, a few partial, a few
      // late, one overpays into credit, two pay nothing (arrears showcase).
      const nowIso = new Date().toISOString();
      let paid = 0;
      let partial = 0;
      for (let i = 0; i < created.length; i++) {
        const c = created[i];
        if (i >= 18) continue; // last two: unpaid, drive arrears aging
        if (i % 7 === 3) {
          // Partial payer: half of one month's rent.
          await recordManualPayment({
            orgId: org.id,
            tenantId: c.id,
            amount: Math.round(c.rent / 2),
            method: "cash",
            mpesaCode: null,
            paidAt: nowIso,
            note: "Demo partial payment",
          });
          partial += 1;
          continue;
        }
        const method = i % 3 === 0 ? "mpesa_manual" : i % 3 === 1 ? "cash" : "bank";
        await recordManualPayment({
          orgId: org.id,
          tenantId: c.id,
          // First tenant overpays two months + 2,000 to showcase credit.
          amount: i === 0 ? c.rent * 2 + 2000 : c.rent * 2,
          method: method as "mpesa_manual" | "cash" | "bank",
          mpesaCode: method === "mpesa_manual" ? `DEMO${String(100000 + i)}` : null,
          paidAt: nowIso,
          note: "Demo payment",
        });
        paid += 1;
      }
      setMsg(
        `Demo data loaded: 2 properties, 20 units, 20 tenants, 3 months of invoices — ${paid} paid in full, ${partial} partial, 2 in arrears, 1 holding credit.`,
      );
      // Belt-and-suspenders: tenants created through createTenant already
      // carry codes, but older demo rows predate the feature — backfill.
      try {
        await backfillAccountCodes(org.id);
      } catch {
        // Non-fatal: staff can assign from Tenants.
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const exportJson = async () => {
    if (!org) return;
    setBusy(true);
    setError(null);
    try {
      const dump = await exportOrgBackup(org.id);
      const blob = new Blob([JSON.stringify({ org, ...dump }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `kodi-backup-${org.id.slice(0, 8)}-${currentMonthKey()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg("Backup downloaded.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardBody>
        <h2 className="mb-3 font-semibold">Data</h2>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={seedDemo} disabled={busy}>{busy ? "Working…" : "Load demo data"}</Button>
          <Button variant="secondary" onClick={exportJson} disabled={busy}>Export backup (JSON)</Button>
          <Button variant="secondary" onClick={() => listPayments(org!.id).then(() => setMsg("Data looks reachable."))} disabled={busy}>Test connection</Button>
        </div>
        {error && <div className="mt-2 max-w-lg"><ErrorBanner message={error} /></div>}
        {msg && <p className="mt-2 text-sm text-green-700">{msg}</p>}
        <p className="mt-2 max-w-lg text-xs text-slate-400">
          Demo data creates a sample property with tenants and invoices so you can explore. Export downloads
          everything for this business as JSON — keep regular copies.
        </p>
      </CardBody>
    </Card>
  );
}
