import { useEffect, useRef, useState } from "react";
import { PLANS, currentMonthKey, formatKES, planByCode } from "@kodi/shared";
import { useAuth } from "../lib/auth";
import {
  clearDemoData,
  clearDarajaToken,
  countUnits,
  createProperty,
  createTenant,
  createUnit,
  demoStatus,
  exportOrgBackup,
  generateInvoices,
  getBillManagerState,
  getCollectionMode,
  getC2bStatus,
  getInitiatorStatus,
  getMpesaCreds,
  inviteUser,
  listDarajaJobs,
  listPayments,
  listStaff,
  listTenants,
  mirrorInvoicesToBillManager,
  optInBillManager,
  pullC2bWindow,
  queryAccountBalance,
  queryTransactionStatus,
  recordManualPayment,
  registerC2bUrls,
  registerPull,
  saveBongaCreds,
  saveInitiatorCreds,
  saveMpesaCreds,
  setValidationMode,
  simulateC2b,
  updateOrg,
  verifyShortcodeOwner,
  type MpesaCredsView,
} from "../lib/api";
import type {
  BillManagerState,
  DarajaJob,
  InitiatorStatusView,
} from "../lib/types";
import { Money } from "../components/domain";
import { Button } from "../components/Button";
import { clearOrgLogo, getOrgLogo, uploadOrgLogo } from "../lib/api";
import { Field, Input, Select } from "../components/Field";
import { Badge, Card, CardBody, ErrorBanner, Loading, PageHeader } from "../components/ui";
import { useToast } from "../components/Toast";

/** Anchor jump list for the long settings page. */
const SECTIONS = [
  ["profile", "Business profile"],
  ["plan", "Plan"],
  ["staff", "Managers"],
  ["daraja", "M-Pesa"],
  ["initiator", "Initiator & payouts"],
  ["verify", "Verification"],
  ["billmanager", "Bill Manager"],
  ["collect", "Smart collections"],
  ["bonga", "Lipa na Bonga"],
  ["data", "Data"],
] as const;

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
      <nav
        aria-label="Settings sections"
        className="no-print sticky top-[68px] z-30 -mx-4 overflow-x-auto bg-slate-100/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 lg:top-2"
      >
        <ul className="flex gap-2 text-sm">
          {SECTIONS.map(([id, label]) => (
            <li key={id} className="shrink-0">
              <a
                href={`#${id}`}
                className="block rounded-full border border-slate-200 bg-white px-3 py-1.5 font-medium text-slate-600 hover:border-slate-400 hover:text-slate-900"
              >
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {error && <ErrorBanner message={error} />}
      <OrgProfileSection />
      <PlanSection />
      <StaffSection staff={staff} isOwner={membership?.role === "owner"} />
      <DarajaSection />
      <InitiatorSection />
      <VerifySection />
      <BillManagerSection />
      <SmartCollectSection />
      <BongaSection />
      <DataSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
function OrgProfileSection() {
  const { org, membership, refresh } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(org?.name ?? "");
  const [dueDay, setDueDay] = useState(String(org?.invoice_due_day ?? 5));
  const [reversalLimit, setReversalLimit] = useState(
    String(org?.reversal_limit ?? 50000),
  );
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!org) return;
    getOrgLogo(org.id).then(setLogoUrl).catch(() => setLogoUrl(null));
  }, [org?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickLogo = async (file: File | undefined) => {
    if (!org || !file) return;
    setLogoBusy(true);
    setError(null);
    try {
      await uploadOrgLogo(org.id, file);
      setLogoUrl(await getOrgLogo(org.id).catch(() => null));
      await refresh();
      toast("Logo updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLogoBusy(false);
    }
  };

  const removeLogo = async () => {
    if (!org) return;
    setLogoBusy(true);
    setError(null);
    try {
      await clearOrgLogo(org.id);
      setLogoUrl(await getOrgLogo(org.id).catch(() => null));
      await refresh();
      toast("Logo removed — using the platform logo.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLogoBusy(false);
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!org) return;
    const day = Math.min(28, Math.max(1, parseInt(dueDay, 10) || 5));
    const limit = Math.max(0, Math.min(10_000_000, parseInt(reversalLimit, 10) || 0));
    setBusy(true);
    setError(null);
    try {
      await updateOrg(org.id, {
        name: name.trim(),
        invoice_due_day: day,
        ...(membership?.role === "owner" ? { reversal_limit: limit } : {}),
      });
      await refresh();
      toast("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card id="profile" className="scroll-mt-[84px] lg:scroll-mt-4">
      <CardBody>
        <h2 className="mb-3 font-semibold">Business profile</h2>
        <form onSubmit={save} className="grid max-w-lg gap-4">
          <div>
            <span className="mb-1 block text-sm font-medium text-slate-700">Logo</span>
            <div className="flex items-center gap-3">
              {logoUrl ? (
                <img
                  src={logoUrl}
                  alt={`${org?.name ?? "Business"} logo`}
                  className="h-12 w-auto rounded-lg bg-slate-900 px-2 py-1"
                />
              ) : (
                <div className="flex h-12 w-24 items-center justify-center rounded-lg bg-slate-100 text-xs text-slate-400">
                  No logo
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => { void pickLogo(e.target.files?.[0]); e.target.value = ""; }}
                />
                <Button type="button" variant="secondary" size="sm" disabled={logoBusy} onClick={() => fileRef.current?.click()}>
                  {logoBusy ? "Uploading…" : logoUrl ? "Replace" : "Upload"}
                </Button>
                {logoUrl && org?.logoStorageId && (
                  <Button type="button" variant="ghost" size="sm" disabled={logoBusy} onClick={removeLogo}>
                    Remove
                  </Button>
                )}
              </div>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              PNG, JPEG, or WebP under 5MB. Shows in the sidebar, portal, and on invoices. Empty uses the platform logo.
            </p>
          </div>
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
    <Card id="plan" className="scroll-mt-[84px] lg:scroll-mt-4">
      <CardBody>
        <h2 className="mb-1 font-semibold">Plan & subscription</h2>
        <p className="mb-1 text-sm text-slate-500">
          Current: <Badge tone="blue">{current.name}</Badge>{" "}
          <span className="ml-1">
            {unitCount !== null ? `${unitCount}/${current.maxUnits} units used` : ""}
          </span>
        </p>
        <p className="mb-3 text-sm text-slate-500">
          Status: <Badge tone={org.subscription_status === "active" ? "green" : org.subscription_status === "past_due" ? "red" : "amber"}>{org.subscription_status}</Badge>
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          {PLANS.map((p) => (
            <div key={p.code} className={`rounded-lg border p-3 ${p.code === org.plan_code ? "border-slate-900 ring-2 ring-slate-900/10" : "border-slate-200"}`}>
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
        {msg && <p className="mt-2 text-sm font-medium text-brand-700">{msg}</p>}
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
    <Card id="staff" className="scroll-mt-[84px] lg:scroll-mt-4">
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
            {result && <p className="text-sm font-medium text-brand-700">{result}</p>}
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
  const { org } = useAuth();
  const [creds, setCreds] = useState<MpesaCredsView | null>(null);
  const [collection, setCollection] = useState<{ mode: "own" | "platform" | "none"; shortcode?: string }>({ mode: "none" });
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

  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!org) return;
    getCollectionMode(org.id)
      .then(setCollection)
      .catch(() => {});
  }, [org?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
    <Card id="daraja" className="scroll-mt-[84px] lg:scroll-mt-4">
      <CardBody>
        <h2 className="mb-1 font-semibold">M-Pesa (Daraja API)</h2>
        <p className="mb-3 text-sm text-slate-500">
          {loading ? "Checking…" : creds?.configured
            ? <>Connected: {creds.environment}, shortcode <strong className="font-mono">{creds.shortcode}</strong> <Badge tone="green">configured</Badge></>
            : <>Not configured — STK Push is disabled until you save credentials. <Badge tone="amber">manual payments still work</Badge></>}
        </p>
        {!loading && error && error.includes("Could not reach") && (
          <div className="mb-3">
            <Button variant="secondary" onClick={load}>Retry connection</Button>
          </div>
        )}
        {!loading && collection.mode === "platform" && !creds?.configured && (
          <div className="print-ink mb-3 rounded-lg border border-brand-100 bg-brand-50 p-3 text-sm text-brand-700">
            This business collects through the <strong>Kodi Paybill ({collection.shortcode})</strong> —
            tenants pay with their own account code and payments record themselves. No setup needed.
            Save your own Daraja credentials below to switch to your own paybill instead.
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
          {msg && <p className="text-sm font-medium text-brand-700">{msg}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save credentials"}</Button>
            {creds?.configured && (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  setMsg(null);
                  try {
                    await clearDarajaToken();
                    setMsg("Cached token cleared — the next Daraja call mints fresh. Retry the failing action now.");
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Refresh access token
              </Button>
            )}
          </div>
          <p className="text-xs text-slate-400">
            Saving credentials now clears the cached token automatically. Use Refresh only when Daraja rejects calls with 401 after a key change or portal test.
          </p>
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
      {msg && <p className="mt-2 text-sm font-medium text-brand-700">{msg}</p>}
      <div className="mt-3">
        <Button variant="secondary" onClick={register} disabled={busy}>
          {busy ? "Registering…" : status.registered ? "Re-register Paybill URLs" : "Register Paybill URLs"}
        </Button>
      </div>
      <ValidationModeRow />
      <SimulatorSection />
    </div>
  );
}

/**
 * Validation strictness: accept-all (money-safe default — typos park in
 * review) vs strict (unknown account numbers bounce at the handset with
 * the reason). Needs Safaricom-side validation activation via apisupport.
 */
function ValidationModeRow() {
  const { org } = useAuth();
  const [mode, setMode] = useState<"accept_all" | "strict">("accept_all");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!org) return null;

  const save = async () => {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await setValidationMode(org.id, mode);
      setMsg(mode === "strict"
        ? "Strict validation on — unknown account numbers bounce at the phone with the reason."
        : "Accept-all on — every structural hit forwards to confirmation and matching.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 max-w-lg rounded-lg border border-slate-200 p-3">
      <p className="text-sm font-medium">Paybill validation at the handset</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Select value={mode} onChange={(e) => setMode(e.target.value as "accept_all" | "strict")} className="max-w-64">
          <option value="accept_all">Accept all (typos park in review)</option>
          <option value="strict">Strict (bounce unknown accounts)</option>
        </Select>
        <Button variant="secondary" size="sm" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Apply"}
        </Button>
      </div>
      {error && <div className="mt-2"><ErrorBanner message={error} /></div>}
      {msg && <p className="mt-2 text-sm font-medium text-brand-700">{msg}</p>}
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

/**
 * Initiator operator (SecurityCredential): unlocks Transaction Status,
 * Balance, Reversals, B2C/B2B, Tax. Owner pastes the org-portal API
 * operator name + password + X.509 cert PEM; the cert parses before
 * storage so a bad paste fails fast.
 */
function InitiatorSection() {
  const [status, setStatus] = useState<InitiatorStatusView | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [cert, setCert] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    getInitiatorStatus()
      .then(setStatus)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !password || !cert.trim()) {
      setError("Initiator name, password and certificate PEM are all required.");
      return;
    }
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const r = await saveInitiatorCreds({
        initiatorName: name.trim(),
        initiatorPassword: password,
        initiatorCertPem: cert.trim(),
      });
      setName("");
      setPassword("");
      setCert("");
      setMsg(`Initiator saved — cert ${r.cert_subject} (valid to ${r.cert_valid_to.slice(0, 10)}, ${r.cert_key_bits}-bit).`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card id="initiator" className="scroll-mt-[84px] lg:scroll-mt-4">
      <CardBody>
        <h2 className="mb-1 font-semibold">Initiator & payouts</h2>
        <p className="mb-3 text-sm text-slate-500">
          {status?.configured
            ? <>Operator <strong>{status.initiator_name}</strong>, cert {status.cert_subject ?? "—"}{" "}
              {status.cert_expired ? <Badge tone="red">cert expired</Badge> : <Badge tone="green">cert ok</Badge>}</>
            : <>Not set — verification, reversals, refunds and balance checks stay disabled. <Badge tone="amber">optional</Badge></>}
        </p>
        <form onSubmit={save} className="grid max-w-lg gap-3">
          <Field label="Initiator name" required hint="API operator created by the Business Admin on org.ke.m-pesa.com">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="apiop1" />
          </Field>
          <Field label="Initiator password" required hint="Set by the Business Manager; avoid @ and . (M-Pesa rejects them)">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="X.509 certificate PEM" required hint="M-Pesa public cert from the Daraja portal (Sandbox cert for sandbox)">
            <textarea
              className="min-h-28 w-full rounded-lg border border-slate-200 p-2 font-mono text-xs"
              value={cert}
              onChange={(e) => setCert(e.target.value)}
              placeholder="-----BEGIN CERTIFICATE----- …"
            />
          </Field>
          {error && <ErrorBanner message={error} />}
          {msg && <p className="text-sm font-medium text-brand-700">{msg}</p>}
          <div><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save initiator"}</Button></div>
        </form>
      </CardBody>
    </Card>
  );
}

/**
 * Verification & reconciliation: Transaction Status lookups, Account
 * Balance snapshots, Pull registration + 48h windows, job history.
 */
function VerifySection() {
  const { org } = useAuth();
  const [jobs, setJobs] = useState<DarajaJob[]>([]);
  const [lookup, setLookup] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    if (!org) return;
    listDarajaJobs(org.id).then(setJobs).catch(() => setJobs([]));
  };

  useEffect(() => { load(); }, [org?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    setMsg(null);
    try {
      await fn();
      setMsg(`${label} accepted — the result lands on the job row below.`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (!org) return null;

  return (
    <Card id="verify" className="scroll-mt-[84px] lg:scroll-mt-4">
      <CardBody>
        <h2 className="mb-1 font-semibold">Verification & reconciliation</h2>
        <p className="mb-3 text-sm text-slate-500">
          Needs the initiator above. Status checks verify queued receipts; balance diffs catch diversion;
          pull windows heal webhook misses with full phone numbers.
        </p>
        <div className="flex max-w-lg flex-wrap gap-2">
          <Input
            value={lookup}
            onChange={(e) => setLookup(e.target.value)}
            placeholder="Receipt / TransID to verify"
            className="max-w-56"
          />
          <Button
            variant="secondary"
            disabled={busy !== null || !lookup.trim()}
            onClick={() => run("Status check", () => queryTransactionStatus({ orgId: org.id, transactionId: lookup.trim() }))}
          >
            {busy === "Status check" ? "Asking…" : "Verify receipt"}
          </Button>
          <Button variant="secondary" disabled={busy !== null} onClick={() => run("Balance query", () => queryAccountBalance(org.id))}>
            {busy === "Balance query" ? "Asking…" : "Check balance"}
          </Button>
          <Button variant="secondary" disabled={busy !== null} onClick={() => run("Pull register", () => registerPull(org.id))}>
            {busy === "Pull register" ? "Registering…" : "Register pull"}
          </Button>
          <Button
            variant="secondary"
            disabled={busy !== null}
            onClick={() => run("Pull 48h", async () => {
              const r = await pullC2bWindow({ orgId: org.id });
              setMsg(`Pulled ${r.pulled} rows — ${r.ingested} new (${r.matched} matched, ${r.queued} queued).`);
            })}
          >
            {busy === "Pull 48h" ? "Pulling…" : "Pull last 48h"}
          </Button>
        </div>
        {error && <div className="mt-2 max-w-lg"><ErrorBanner message={error} /></div>}
        {msg && <p className="mt-2 text-sm font-medium text-brand-700">{msg}</p>}
        {jobs.length > 0 && (
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {jobs.slice(0, 15).map((j) => (
              <li key={j.id} className="flex items-center justify-between gap-2 py-1.5">
                <span className="truncate">
                  <Badge tone={j.status === "done" ? "green" : j.status === "failed" ? "red" : "amber"}>{j.status}</Badge>{" "}
                  <span className="ml-1 font-mono text-xs text-slate-500">{j.kind}</span>{" "}
                  <span className="text-slate-600">{j.request_summary ?? j.conversation_id}</span>
                </span>
                <span className="shrink-0 text-xs text-slate-400" title={j.result_desc ?? undefined}>
                  {(j.result_desc ?? "").slice(0, 60)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/** Bill Manager: opt-in, mirror, cancel state. */
function BillManagerSection() {
  const { org } = useAuth();
  const [state, setState] = useState<BillManagerState | null>(null);
  const [email, setEmail] = useState("");
  const [contact, setContact] = useState("");
  const [reminders, setReminders] = useState(true);
  const [month, setMonth] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    if (!org) return;
    getBillManagerState(org.id).then(setState).catch(() => setState(null));
  };

  useEffect(() => { load(); }, [org?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!org) return null;

  const optIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("optin");
    setError(null);
    setMsg(null);
    try {
      await optInBillManager({ orgId: org.id, email: email.trim(), officialContact: contact.trim(), sendReminders: reminders });
      setMsg("Opted in — Safaricom now accepts invoices for this shortcode.");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const mirror = async () => {
    setBusy("mirror");
    setError(null);
    setMsg(null);
    try {
      const r = await mirrorInvoicesToBillManager({ orgId: org.id, month: month.trim() || undefined });
      setMsg(`Mirrored ${r.mirrored} invoices${r.failed > 0 ? `, ${r.failed} rejected — see webhook log` : ""}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card id="billmanager" className="scroll-mt-[84px] lg:scroll-mt-4">
      <CardBody>
        <h2 className="mb-1 font-semibold">Bill Manager (Safaricom e-invoicing)</h2>
        <p className="mb-3 text-sm text-slate-500">
          {state?.opted_in
            ? <>Opted in{state.email ? `, ${state.email}` : ""}{state.last_mirrored_at ? `, last mirror ${state.last_mirrored_at.slice(0, 10)}` : ""} <Badge tone="green">live</Badge></>
            : <>Outsources invoice SMS, 7/3/0-day reminders and e-receipts to Safaricom. <Badge tone="amber">not opted in</Badge></>}
        </p>
        {!state?.opted_in ? (
          <form onSubmit={optIn} className="grid max-w-lg gap-3">
            <Field label="Notification email" required><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
            <Field label="Official contact" required><Input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="0712 345 678" required /></Field>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={reminders} onChange={(e) => setReminders(e.target.checked)} />
              Safaricom sends 7/3/0-day SMS reminders
            </label>
            {error && <ErrorBanner message={error} />}
            {msg && <p className="text-sm font-medium text-brand-700">{msg}</p>}
            <div><Button type="submit" disabled={busy !== null}>{busy === "optin" ? "Opting in…" : "Opt in"}</Button></div>
          </form>
        ) : (
          <div className="grid max-w-lg gap-3">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Month (blank = all unpaid)">
                <Input value={month} onChange={(e) => setMonth(e.target.value)} placeholder="2026-09" className="max-w-40" />
              </Field>
              <Button variant="secondary" onClick={mirror} disabled={busy !== null}>
                {busy === "mirror" ? "Mirroring…" : "Mirror invoices"}
              </Button>
            </div>
            {error && <ErrorBanner message={error} />}
            {msg && <p className="text-sm font-medium text-brand-700">{msg}</p>}
            <p className="text-xs text-slate-400">
              Payments arrive on the Bill Manager callback with the full phone number and reconcile like Paybill hits.
              Cancel a mirrored invoice from the invoice row while unpaid.
            </p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/** Dynamic QR + shortcode guard: typo killers for invoices and setup. */
function SmartCollectSection() {
  const { org } = useAuth();
  const [shortcode, setShortcode] = useState("");
  const [check, setCheck] = useState<{ org_name?: string | null; tariff?: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!org) return null;

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCheck(null);
    try {
      const r = await verifyShortcodeOwner({ orgId: org.id, shortcode: shortcode.trim() || undefined });
      setCheck({ org_name: r.org_name, tariff: r.tariff });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card id="collect" className="scroll-mt-[84px] lg:scroll-mt-4">
      <CardBody>
        <h2 className="mb-1 font-semibold">Smart collections</h2>
        <p className="mb-3 text-sm text-slate-500">
          Per-invoice QR codes print from the invoice page. Below: verify a shortcode belongs to your org before money moves.
        </p>
        <form onSubmit={verify} className="flex max-w-lg flex-wrap items-end gap-2">
          <Field label="Shortcode to verify">
            <Input value={shortcode} onChange={(e) => setShortcode(e.target.value)} placeholder="615395" className="max-w-40" />
          </Field>
          <Button variant="secondary" type="submit" disabled={busy}>{busy ? "Checking…" : "Verify owner"}</Button>
        </form>
        {error && <div className="mt-2 max-w-lg"><ErrorBanner message={error} /></div>}
        {check && (
          <p className="mt-2 text-sm text-slate-600">
            Owner: <strong>{check.org_name ?? "unknown"}</strong>, tariff {check.tariff ?? "unknown"}
          </p>
        )}
      </CardBody>
    </Card>
  );
}

/** Lipa na Bonga operator creds (separate SHA256 user/pass scheme). */
function BongaSection() {
  const { org } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!org) return null;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await saveBongaCreds({ orgId: org.id, username: username.trim(), password });
      setUsername("");
      setPassword("");
      setMsg("Bonga operator saved — quote points from the Payments page.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card id="bonga" className="scroll-mt-[84px] lg:scroll-mt-4">
      <CardBody>
        <h2 className="mb-1 font-semibold">Lipa na Bonga (points part-payments)</h2>
        <p className="mb-3 text-sm text-slate-500">
          Tenants part-pay rent with loyalty points (0.2 KES each). Funds land on the Paybill and record via the normal path.
        </p>
        <form onSubmit={save} className="grid max-w-lg gap-3">
          <Field label="Bonga username" required><Input value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
          <Field label="Bonga password" required><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {error && <ErrorBanner message={error} />}
          {msg && <p className="text-sm font-medium text-brand-700">{msg}</p>}
          <div><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save Bonga operator"}</Button></div>
        </form>
      </CardBody>
    </Card>
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
      // Ideal-fix proof: every tenant is born with its code — verify all
      // 20 carry one and say so in the summary. Legacy rows (pre-invariant)
      // are healed by the Tenants backfill, not here.
      const fresh = await listTenants(org.id);
      const coded = fresh.filter((t) => t.account_code).length;
      setMsg(
        `Demo data loaded: 2 properties, 20 units, 20 tenants, 3 months of invoices — ${paid} paid in full, ${partial} partial, 2 in arrears, 1 holding credit. Paybill codes on ${coded}/20 tenants.`,
      );
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
    <Card id="data" className="scroll-mt-[84px] lg:scroll-mt-4">
      <CardBody>
        <h2 className="mb-3 font-semibold">Data</h2>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={seedDemo} disabled={busy}>{busy ? "Working…" : "Load demo data"}</Button>
          <Button variant="secondary" onClick={exportJson} disabled={busy}>Export backup (JSON)</Button>
          <Button variant="secondary" onClick={() => listPayments(org!.id).then(() => setMsg("Data looks reachable."))} disabled={busy}>Test connection</Button>
        </div>
        <DemoClearSection onDone={(m) => setMsg(m)} onError={(m) => setError(m)} />
        {error && <div className="mt-2 max-w-lg"><ErrorBanner message={error} /></div>}
        {msg && <p className="mt-2 text-sm font-medium text-brand-700">{msg}</p>}
        <p className="mt-2 max-w-lg text-xs text-slate-400">
          Demo data creates a sample property with tenants and invoices so you can explore. Export downloads
          everything for this business as JSON — keep regular copies.
        </p>
      </CardBody>
    </Card>
  );
}

/**
 * One-click demo removal: shows what "(Demo)" data exists, confirms, then
 * clears in dependency order (payments voided first). Real rows untouched.
 */
function DemoClearSection({ onDone, onError }: {
  onDone: (m: string) => void;
  onError: (m: string) => void;
}) {
  const [status, setStatus] = useState<{ tenants: number; properties: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    demoStatus()
      .then((s) => setStatus({ tenants: s.tenants, properties: s.properties }))
      .catch(() => setStatus(null));
  }, []);

  if (status === null || status.tenants === 0) return null;

  const clear = async () => {
    setBusy(true);
    try {
      const r = await clearDemoData();
      setConfirming(false);
      setStatus({ tenants: 0, properties: 0 });
      onDone(
        `Demo data removed: ${r.properties} properties, ${r.units} units, ${r.tenants} tenants, ${r.invoices} invoices, ${r.paymentsVoided} payments voided.`,
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 max-w-lg rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
      {confirming ? (
        <>
          <p className="font-semibold">
            Remove all demo data? {status.tenants} tenants in {status.properties} demo properties, plus their invoices and payments.
          </p>
          <p className="mt-1 text-xs">Payments are voided first (audited), then everything demo is deleted. Real data is never touched. This cannot be undone — export a backup first if unsure.</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setConfirming(false)} disabled={busy}>Keep demo data</Button>
            <Button size="sm" onClick={clear} disabled={busy}>{busy ? "Removing…" : "Yes, remove demo data"}</Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p>
            Demo data present: {status.tenants} tenants in {status.properties} properties.
          </p>
          <Button size="sm" variant="secondary" onClick={() => setConfirming(true)}>Remove demo data…</Button>
        </div>
      )}
    </div>
  );
}
