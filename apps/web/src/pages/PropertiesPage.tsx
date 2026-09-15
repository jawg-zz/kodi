import { useEffect, useState } from "react";
import { planByCode, formatKES, parseKES } from "@kodi/shared";
import { useAuth } from "../lib/auth";
import {
  countUnits,
  createProperty,
  createUnit,
  deleteProperty,
  deleteUnit,
  listProperties,
  listUnits,
  updateProperty,
  updateUnit,
} from "../lib/api";
import type { Property, UnitWithTenant } from "../lib/types";
import type { PropertyType, UnitType } from "@kodi/shared";
import { Button } from "../components/Button";
import { Field, Input, Select, Textarea } from "../components/Field";
import { Card, CardBody, ConfirmDialog, EmptyState, ErrorBanner, Loading, PageHeader } from "../components/ui";
import { Modal } from "../components/Modal";
import { Money, UnitStatusBadge, unitTypeLabel } from "../components/domain";

const propertyTypes = [
  ["apartments", "Apartments"],
  ["bedsitters", "Bedsitters"],
  ["single_rooms", "Single rooms"],
  ["mixed", "Mixed"],
  ["commercial", "Commercial"],
] as const;

const unitTypes = [
  ["bedsitter", "Bedsitter"],
  ["single", "Single room"],
  ["one_br", "1 bedroom"],
  ["two_br", "2 bedroom"],
  ["three_br", "3 bedroom"],
  ["shop", "Shop"],
  ["other", "Other"],
] as const;

export function PropertiesPage() {
  const { org } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [properties, setProperties] = useState<Property[]>([]);
  const [units, setUnits] = useState<UnitWithTenant[]>([]);
  const [unitCount, setUnitCount] = useState(0);
  const [showPropertyModal, setShowPropertyModal] = useState(false);
  const [editingProperty, setEditingProperty] = useState<Property | null>(null);
  const [showUnitModal, setShowUnitModal] = useState<Property | null>(null);
  const [editingUnit, setEditingUnit] = useState<UnitWithTenant | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ kind: "property" | "unit"; id: string; name: string } | null>(null);

  const plan = planByCode(org?.plan_code ?? "starter");

  const load = async () => {
    if (!org) return;
    setLoading(true);
    setError(null);
    try {
      const [p, u, c] = await Promise.all([
        listProperties(org.id),
        listUnits(org.id),
        countUnits(org.id),
      ]);
      setProperties(p);
      setUnits(u);
      setUnitCount(c);
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
      if (confirmDelete.kind === "property") await deleteProperty(confirmDelete.id);
      else await deleteUnit(confirmDelete.id);
      setConfirmDelete(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConfirmDelete(null);
    }
  };

  if (loading) return <Loading label="Loading properties…" />;
  if (error) return <ErrorBanner message={error} onRetry={load} />;

  const unitsFor = (propertyId: string) => units.filter((u) => u.property_id === propertyId);
  const atLimit = unitCount >= plan.maxUnits;

  return (
    <div>
      <PageHeader
        title="Properties"
        sub={`${properties.length} properties · ${unitCount}/${plan.maxUnits} units on ${plan.name}`}
        actions={
          <Button onClick={() => { setEditingProperty(null); setShowPropertyModal(true); }}>
            Add property
          </Button>
        }
      />

      {atLimit && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          You've reached the {plan.maxUnits}-unit limit on {plan.name}. Upgrade in Settings to add more units.
        </div>
      )}

      {properties.length === 0 ? (
        <EmptyState
          title="No properties yet"
          hint="Add your first plot or building, then add its units with their monthly rent."
          action={<Button onClick={() => { setEditingProperty(null); setShowPropertyModal(true); }}>Add property</Button>}
        />
      ) : (
        <div className="space-y-4">
          {properties.map((p) => {
            const pu = unitsFor(p.id);
            return (
              <Card key={p.id}>
                <CardBody>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h2 className="text-lg font-semibold">{p.name}</h2>
                      <p className="text-sm text-slate-500">
                        {p.location || "No location"} · {pu.length} units
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={atLimit}
                        title={atLimit ? `Unit limit reached (${plan.maxUnits})` : undefined}
                        onClick={() => { setEditingUnit(null); setShowUnitModal(p); }}
                      >
                        Add unit
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => { setEditingProperty(p); setShowPropertyModal(true); }}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete({ kind: "property", id: p.id, name: p.name })}>
                        Delete
                      </Button>
                    </div>
                  </div>

                  {pu.length === 0 ? (
                    <p className="mt-3 text-sm text-slate-400">No units yet.</p>
                  ) : (
                    <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {pu.map((u) => (
                        <div key={u.id} className="rounded-lg border border-slate-200 p-3">
                          <div className="flex items-center justify-between">
                            <span className="font-semibold">{u.label}</span>
                            <UnitStatusBadge status={u.status} />
                          </div>
                          <p className="mt-1 text-xs text-slate-500">{unitTypeLabel(u.unit_type)}</p>
                          <p className="mt-1 text-sm">
                            <Money value={u.rent_amount} className="font-semibold" />
                            {(u.water_charge > 0 || u.garbage_charge > 0) && (
                              <span className="text-xs text-slate-500">
                                {" "}+ {formatKES(u.water_charge + u.garbage_charge)} utilities
                              </span>
                            )}
                          </p>
                          {u.tenant && (
                            <p className="mt-1 truncate text-xs text-slate-500">
                              {u.tenant.full_name}
                            </p>
                          )}
                          <div className="mt-2 flex gap-1">
                            <Button size="sm" variant="ghost" onClick={() => { setEditingUnit(u); setShowUnitModal(p); }}>
                              Edit
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete({ kind: "unit", id: u.id, name: `${p.name} ${u.label}` })}>
                              Delete
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      {showPropertyModal && (
        <PropertyModal
          orgId={org!.id}
          property={editingProperty}
          onClose={() => { setShowPropertyModal(false); setEditingProperty(null); }}
          onSaved={load}
        />
      )}

      {showUnitModal && (
        <UnitModal
          orgId={org!.id}
          property={showUnitModal}
          unit={editingUnit}
          onClose={() => { setShowUnitModal(null); setEditingUnit(null); }}
          onSaved={load}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${confirmDelete.kind}`}
          message={`Delete "${confirmDelete.name}"? ${confirmDelete.kind === "property" ? "All its units will be removed too." : ""} Tenants linked to it become unassigned.`}
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

function PropertyModal({ orgId, property, onClose, onSaved }: {
  orgId: string;
  property: Property | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(property?.name ?? "");
  const [type, setType] = useState<Property["property_type"]>(property?.property_type ?? "apartments");
  const [location, setLocation] = useState(property?.location ?? "");
  const [notes, setNotes] = useState(property?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Property name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (property) {
        await updateProperty(property.id, {
          name: name.trim(),
          property_type: type,
          location: location.trim(),
          notes: notes.trim() || null,
        });
      } else {
        await createProperty(orgId, {
          name: name.trim(),
          property_type: type,
          location: location.trim(),
          notes: notes.trim() || null,
        });
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={property ? "Edit property" : "Add property"} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <Field label="Property name" required hint='e.g. "Baraka Court", "Muthurwa Block C"'>
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value as PropertyType)}>
              {propertyTypes.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Location" hint='e.g. "Kilimani, Nairobi"'>
            <Input value={location} onChange={(e) => setLocation(e.target.value)} />
          </Field>
        </div>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </Field>
        {error && <ErrorBanner message={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        </div>
      </form>
    </Modal>
  );
}

function UnitModal({ orgId, property, unit, onClose, onSaved }: {
  orgId: string;
  property: Property;
  unit: UnitWithTenant | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [label, setLabel] = useState(unit?.label ?? "");
  const [type, setType] = useState<UnitWithTenant["unit_type"]>(unit?.unit_type ?? "bedsitter");
  const [rent, setRent] = useState(unit ? String(unit.rent_amount) : "");
  const [water, setWater] = useState(unit ? String(unit.water_charge) : "0");
  const [garbage, setGarbage] = useState(unit ? String(unit.garbage_charge) : "0");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const rentV = parseKES(rent);
    const waterV = parseKES(water);
    const garbageV = parseKES(garbage);
    if (!label.trim()) { setError("Unit label is required."); return; }
    if (rentV === null) { setError("Enter a valid monthly rent in KES."); return; }
    if (waterV === null || garbageV === null) { setError("Water and garbage charges must be valid amounts."); return; }
    setBusy(true);
    setError(null);
    try {
      const values = {
        label: label.trim(),
        unit_type: type,
        rent_amount: rentV,
        water_charge: waterV,
        garbage_charge: garbageV,
        property_id: property.id,
      };
      if (unit) await updateUnit(unit.id, values);
      else await createUnit(orgId, values);
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={unit ? `Edit unit ${unit.label}` : `Add unit to ${property.name}`} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Unit label" required hint='e.g. "A1", "B4"'>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} required />
          </Field>
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value as UnitType)}>
              {unitTypes.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Rent (KES)" required>
            <Input value={rent} onChange={(e) => setRent(e.target.value)} inputMode="numeric" required />
          </Field>
          <Field label="Water (KES)">
            <Input value={water} onChange={(e) => setWater(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Garbage (KES)">
            <Input value={garbage} onChange={(e) => setGarbage(e.target.value)} inputMode="numeric" />
          </Field>
        </div>
        {error && <ErrorBanner message={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        </div>
      </form>
    </Modal>
  );
}
