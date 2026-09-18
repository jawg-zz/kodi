import { useEffect, useState } from "react";
import { PLANS, currentMonthKey, formatKES, planByCode } from "@kodi/shared";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import {
  countUnits,
  createProperty,
  createTenant,
  createUnit,
  generateInvoices,
  getMpesaCreds,
  inviteUser,
  listPayments,
  listStaff,
  listTenants,
  recordManualPayment,
  saveMpesaCreds,
  updateOrg,
  type MpesaCredsView,
} from "../lib/api";
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
  const { org, refresh } = useAuth();
  const [name, setName] = useState(org?.name ?? "");
  const [dueDay, setDueDay] = useState(String(org?.invoice_due_day ?? 5));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!org) return;
    const day = Math.min(28, Math.max(1, parseInt(dueDay, 10) || 5));
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await updateOrg(org.id, { name: name.trim(), invoice_due_day: day });
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
      setResult(r.invited
        ? `Manager login created for ${r.email}. Temporary password: ${r.tempPassword} — share it securely.`
        : `Existing account ${r.email} linked as manager.`);
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
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
const DEMO_MONTHS = [0, -1];

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
      const prop = await createProperty(org.id, {
        name: "Baraka Court (Demo)",
        property_type: "apartments",
        location: "Kilimani, Nairobi",
        notes: "Demo data — delete when done exploring.",
      });
      const specs = [
        { label: "A1", rent: 25000, water: 500, garbage: 300, name: "Jane Wanjiku", phone: "254722111111" },
        { label: "A2", rent: 18000, water: 400, garbage: 300, name: "John Otieno", phone: "254733222222" },
        { label: "B1", rent: 12000, water: 300, garbage: 200, name: "Mary Achieng", phone: "254744333333" },
      ];
      for (const s of specs) {
        const unit = await createUnit(org.id, {
          property_id: prop.id,
          label: s.label,
          unit_type: "one_br",
          rent_amount: s.rent,
          water_charge: s.water,
          garbage_charge: s.garbage,
        });
        await createTenant(org.id, {
          full_name: s.name,
          phone: s.phone,
          national_id: "",
          unit_id: unit.id,
          move_in_date: "2026-06-01",
          deposit_held: s.rent,
        });
      }
      for (const back of DEMO_MONTHS) {
        const d = new Date();
        d.setMonth(d.getMonth() + back);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        await generateInvoices(org.id, key);
      }
      // One demo cash payment against the oldest open invoice of the first tenant.
      const tenants = await listTenants(org.id);
      const demo = tenants.find((t) => t.full_name === "Jane Wanjiku");
      if (demo) {
        await recordManualPayment({
          orgId: org.id,
          tenantId: demo.id,
          amount: 10000,
          method: "cash",
          mpesaCode: null,
          paidAt: new Date().toISOString(),
          note: "Demo payment",
        });
      }
      setMsg("Demo data loaded: 1 property, 3 units, 3 tenants, invoices for this and last month, plus one payment.");
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
      const tables = ["properties", "units", "tenants", "invoices", "payments", "deposit_settlements", "mpesa_transactions"] as const;
      const dump: Record<string, unknown> = { org, exportedAt: new Date().toISOString() };
      for (const t of tables) {
        const { data, error: e } = await supabase.from(t).select("*").eq("org_id", org.id);
        if (e) throw new Error(`${t}: ${e.message}`);
        dump[t] = data;
      }
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
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
