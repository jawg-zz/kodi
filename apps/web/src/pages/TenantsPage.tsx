import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatKES, isValidKenyanPhone, maskPhone, normalizeKenyanPhone, parseKES } from "@kodi/shared";
import { useAuth } from "../lib/auth";
import {
  backfillAccountCodes,
  createTenant,
  deleteTenant,
  inviteUser,
  listTenants,
  listUnits,
  updateTenant,
} from "../lib/api";
import type { Tenant, Unit } from "../lib/types";
import type { TenantStatus } from "@kodi/shared";
import { Button } from "../components/Button";
import { Field, Input, Select, Textarea } from "../components/Field";
import { Badge, Card, ConfirmDialog, EmptyState, ErrorBanner, Loading, PageHeader } from "../components/ui";
import { Modal } from "../components/Modal";
import { Money } from "../components/domain";

const statusTone: Record<string, "green" | "amber" | "slate"> = {
  active: "green",
  notice: "amber",
  moved_out: "slate",
};

export function TenantsPage() {
  const { org } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Tenant | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Tenant | null>(null);
  const [q, setQ] = useState("");
  const [backfillMsg, setBackfillMsg] = useState<string | null>(null);
  const [backfillBusy, setBackfillBusy] = useState(false);

  const load = async () => {
    if (!org) return;
    setLoading(true);
    setError(null);
    try {
      const [t, u] = await Promise.all([listTenants(org.id), listUnits(org.id)]);
      setTenants(t);
      setUnits(u);
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

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      await deleteTenant(confirmDelete.id);
      setConfirmDelete(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConfirmDelete(null);
    }
  };

  const KD_RE = /^[A-Z2-9]{6}$/;
  const missingCodes = tenants.filter((t) => !t.account_code || !KD_RE.test(t.account_code)).length;

  const handleBackfill = async () => {
    if (!org) return;
    setBackfillBusy(true);
    setBackfillMsg(null);
    try {
      const res = await backfillAccountCodes(org.id);
      setBackfillMsg(
        res.minted > 0
          ? `Re-issued ${res.minted} Paybill code${res.minted === 1 ? "" : "s"} in the new 6-character format. Tell affected tenants their new code.`
          : "Every tenant already has a new-format Paybill code.",
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBackfillBusy(false);
    }
  };

  if (loading) return <Loading label="Loading tenants…" />;
  if (error) return <ErrorBanner message={error} onRetry={load} />;

  const unitLabel = (id: string | null) => {
    if (!id) return "—";
    const u = units.find((x) => x.id === id) as (Unit & { property_id?: string }) | undefined;
    return u ? u.label : "—";
  };

  const filtered = tenants.filter(
    (t) =>
      !q ||
      t.full_name.toLowerCase().includes(q.toLowerCase()) ||
      t.phone.includes(q)
  );

  return (
    <div>
      <PageHeader
        title="Tenants"
        sub={`${tenants.length} tenant${tenants.length === 1 ? "" : "s"}`}
        actions={
          <div className="flex gap-2">
            {missingCodes > 0 && (
              <Button variant="secondary" onClick={handleBackfill} disabled={backfillBusy}>
                {backfillBusy ? "Re-issuing…" : `Re-issue codes (${missingCodes})`}
              </Button>
            )}
            <Button onClick={() => { setEditing(null); setShowModal(true); }}>Add tenant</Button>
          </div>
        }
      />
      {backfillMsg && (
        <p className="mb-4 text-sm font-medium text-brand-700">{backfillMsg}</p>
      )}
      {missingCodes > 0 && !backfillMsg && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          {missingCodes} tenant{missingCodes === 1 ? " has" : "s have"} an old-format Paybill
          code — re-issue to the 6-character format so payments auto-match.{" "}
          <button
            onClick={handleBackfill}
            disabled={backfillBusy}
            className="font-medium underline hover:no-underline"
          >
            {backfillBusy ? "Re-issuing…" : "Re-issue now"}
          </button>
        </div>
      )}

      <div className="mb-4 max-w-sm">
        <Input placeholder="Search by name or phone…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={tenants.length === 0 ? "No tenants yet" : "No matches"}
          hint="Add a tenant and assign them to a unit. Tenancy updates the unit status automatically."
          action={tenants.length === 0 ? <Button onClick={() => { setEditing(null); setShowModal(true); }}>Add tenant</Button> : undefined}
        />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="rtable w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Unit</th>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3">Paybill acct</th>
                  <th className="px-4 py-3 text-right">Deposit held</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-50">
                    <td data-label="Name" className="px-4 py-3">
                      <Link to={`/app/tenants/${t.id}`} className="font-medium text-slate-900 underline-offset-2 hover:underline">
                        {t.full_name}
                      </Link>
                    </td>
                    <td data-label="Unit" className="px-4 py-3">{unitLabel(t.unit_id)}</td>
                    <td data-label="Phone" className="px-4 py-3">{maskPhone(t.phone)}</td>
                    <td data-label="Paybill acct" className="px-4 py-3 font-mono text-xs">{t.account_code ?? <span className="text-slate-400">—</span>}</td>
                    <td data-label="Deposit held" className="px-4 py-3 text-right"><Money value={t.deposit_held} /></td>
                    <td data-label="Status" className="px-4 py-3">
                      <Badge tone={statusTone[t.status] ?? "slate"}>{t.status.replace("_", " ")}</Badge>
                    </td>
                    <td data-label="Actions" className="px-4 py-3 text-right">
                      <span className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => { setEditing(t); setShowModal(true); }}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50" onClick={() => setConfirmDelete(t)}>
                          Delete
                        </Button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {showModal && (
        <TenantModal
          orgId={org!.id}
          tenant={editing}
          units={units}
          onClose={() => { setShowModal(false); setEditing(null); }}
          onSaved={load}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete tenant"
          message={`Delete ${confirmDelete.full_name}? Past invoices and payments stay on record, but the unit becomes vacant.`}
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

export function TenantModal({ orgId, tenant, units, onClose, onSaved }: {
  orgId: string;
  tenant: Tenant | null;
  units: Unit[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(tenant?.full_name ?? "");
  const [phone, setPhone] = useState(tenant?.phone ?? "");
  const [nationalId, setNationalId] = useState(tenant?.national_id ?? "");
  const [unitId, setUnitId] = useState(tenant?.unit_id ?? "");
  const [moveIn, setMoveIn] = useState(tenant?.move_in_date ?? "");
  const [deposit, setDeposit] = useState(tenant ? String(tenant.deposit_held) : "");
  const [status, setStatus] = useState<Tenant["status"]>(tenant?.status ?? "active");
  const [notes, setNotes] = useState(tenant?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizeKenyanPhone(phone);
    if (!name.trim()) { setError("Full name is required."); return; }
    if (!normalized) { setError("Enter a valid Kenyan mobile number."); return; }
    const dep = deposit.trim() === "" ? 0 : parseKES(deposit);
    if (dep === null) { setError("Deposit must be a valid amount."); return; }
    setBusy(true);
    setError(null);
    try {
      const values = {
        full_name: name.trim(),
        phone: normalized,
        national_id: nationalId.trim(),
        unit_id: unitId || null,
        move_in_date: moveIn || null,
        deposit_held: dep,
        status,
        notes: notes.trim() || undefined,
      };
      if (tenant) await updateTenant(tenant.id, { ...values, notes: values.notes ?? null });
      else await createTenant(orgId, values);
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // occupied-by-someone-else units are still listed (a move can be recorded),
  // but the select flags clearly.
  return (
    <Modal title={tenant ? "Edit tenant" : "Add tenant"} onClose={onClose} wide>
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Phone (Safaricom)" required hint="Used for M-Pesa prompts.">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" required placeholder="0712 345 678" />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="National ID">
            <Input value={nationalId} onChange={(e) => setNationalId(e.target.value)} placeholder="Optional" />
          </Field>
          <Field label="Unit">
            <Select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              <option value="">— Unassigned —</option>
              {units.map((u) => {
                const taken = u.status !== 'vacant' && u.current_tenant_id !== tenant?.id;
                return (
                  <option key={u.id} value={u.id} disabled={taken}>
                    {u.label} ({formatKES(u.rent_amount)}){taken ? ' — occupied' : ''}
                  </option>
                );
              })}
            </Select>
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Move-in date">
            <Input type="date" value={moveIn} onChange={(e) => setMoveIn(e.target.value)} />
          </Field>
          <Field label="Deposit held (KES)" hint="Defaults to one month's rent.">
            <Input value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as TenantStatus)}>
              <option value="active">Active</option>
              <option value="notice">On notice</option>
              <option value="moved_out">Moved out</option>
            </Select>
          </Field>
        </div>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </Field>
        {!isValidKenyanPhone(phone) && phone.trim() !== "" && (
          <p className="text-xs text-amber-600">That number doesn't look like a Kenyan mobile — it will be rejected on save.</p>
        )}
        {error && <ErrorBanner message={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        </div>
      </form>
    </Modal>
  );
}

export function InviteTenantButton({ tenant }: { tenant: Tenant }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [resultEmail, setResultEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [showForm, setShowForm] = useState(false);

  const send = async () => {
    if (!email.trim()) { setError("Enter the tenant's email address."); return; }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await inviteUser({
        email: email.trim(),
        fullName: tenant.full_name,
        phone: tenant.phone,
        kind: "tenant",
        tenantId: tenant.id,
      });
      setResult(
        `${window.location.origin}/invite/${r.inviteToken}`,
      );
      setResultEmail(r.email);
      setShowForm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!showForm && !result) {
    return <Button size="sm" variant="secondary" onClick={() => setShowForm(true)}>Invite to portal</Button>;
  }

  const waText = result
    ? `Hi ${tenant.full_name}, view your rent and pay by M-Pesa here: ${result} (expires in 7 days)`
    : "";
  const waHref = `https://wa.me/${tenant.phone.replace(/\D/g, "")}?text=${encodeURIComponent(waText)}`;

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      {result ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-brand-700">
            Portal invite created{resultEmail ? ` for ${resultEmail}` : ""}.
          </p>
          <p className="break-all font-mono text-xs text-slate-600">{result}</p>
          <div className="flex flex-wrap gap-2">
            <a
              href={waHref}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
            >
              Share on WhatsApp
            </a>
            <Button size="sm" variant="secondary" onClick={() => { void navigator.clipboard?.writeText(result ?? ""); }}>
              Copy link
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <Field label="Tenant email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tenant@example.com" />
          </Field>
          {error && <ErrorBanner message={error} />}
          <div className="flex gap-2">
            <Button size="sm" onClick={send} disabled={busy}>{busy ? "Inviting…" : "Create portal login"}</Button>
            <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
