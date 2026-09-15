import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { planByCode, PLANS, formatKES } from "@kodi/shared";
import { useAuth } from "../lib/auth";
import { createOrg } from "../lib/api";
import { PublicLayout } from "../components/Layout";
import { Button } from "../components/Button";
import { Field, Input } from "../components/Field";
import { Badge, Card, CardBody, ErrorBanner } from "../components/ui";

export function OnboardingPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [orgName, setOrgName] = useState("");
  const [plan, setPlan] = useState("starter");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgName.trim()) {
      setError("Give your rental business a name.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await createOrg(orgName.trim(), plan);
      await refresh();
      navigate("/app", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PublicLayout>
      <Card>
        <CardBody>
          <h1 className="text-xl font-bold">Set up your rental business</h1>
          <p className="mt-1 text-sm text-slate-500">
            You can change the name and plan later in Settings.
          </p>
          <form onSubmit={submit} className="mt-4 space-y-4">
            <Field label="Business name" required hint='e.g. "Baraka Court", "Wanjiku Rentals"'>
              <Input value={orgName} onChange={(e) => setOrgName(e.target.value)} required placeholder="Baraka Court" />
            </Field>
            <div>
              <span className="mb-2 block text-sm font-medium text-slate-700">Plan</span>
              <div className="space-y-2">
                {PLANS.map((p) => (
                  <label
                    key={p.code}
                    className={`flex cursor-pointer items-center justify-between rounded-lg border px-4 py-3 transition ${
                      plan === p.code ? "border-brand-600 ring-2 ring-brand-100" : "border-slate-300 hover:border-slate-400"
                    }`}
                  >
                    <span className="flex items-center gap-3">
                      <input
                        type="radio"
                        name="plan"
                        value={p.code}
                        checked={plan === p.code}
                        onChange={() => setPlan(p.code)}
                        className="accent-brand-600"
                      />
                      <span>
                        <span className="font-medium">{p.name}</span>
                        <span className="ml-2 text-sm text-slate-500">
                          up to {p.maxUnits} units
                        </span>
                      </span>
                    </span>
                    <Badge tone={p.priceKes === 0 ? "green" : "blue"}>
                      {p.priceKes === 0 ? "Free" : `${formatKES(p.priceKes)}/mo`}
                    </Badge>
                  </label>
                ))}
              </div>
            </div>
            {error && <ErrorBanner message={error} />}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Setting up…" : `Start with ${planByCode(plan).name}`}
            </Button>
          </form>
        </CardBody>
      </Card>
    </PublicLayout>
  );
}
