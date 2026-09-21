import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { PublicLayout } from "../components/Layout";
import { Button } from "../components/Button";
import { Field, Input } from "../components/Field";
import { Card, CardBody, ErrorBanner } from "../components/ui";

export function LoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCheckEmail, setShowCheckEmail] = useState(
    searchParams.get("check-email") === "1"
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const err = await signIn(email.trim(), password);
    setBusy(false);
    if (err) setError(err);
    else navigate("/", { replace: true });
  };

  return (
    <PublicLayout>
      <Card>
        <CardBody>
          <h1 className="text-xl font-bold">Sign in</h1>
          <p className="mt-1 text-sm text-slate-500">
            Landlords, managers and tenants use the same sign in.
          </p>
          {showCheckEmail && (
            <div
              className="mt-4 rounded-xl border border-brand-100 bg-brand-50 p-4 text-sm text-brand-700"
              role="status"
            >
              <p className="font-medium">Account created — check your email</p>
              <p className="mt-1">
                We sent a confirmation link to your inbox. Click it, then sign
                in here.
              </p>
              <button
                onClick={() => {
                  setShowCheckEmail(false);
                  setSearchParams({}, { replace: true });
                }}
                className="mt-2 font-medium underline hover:no-underline"
              >
                Dismiss
              </button>
            </div>
          )}
          <form onSubmit={submit} className="mt-4 space-y-4">
            <Field label="Email" required>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
            </Field>
            <Field label="Password" required>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
            </Field>
            {error && <ErrorBanner message={error} />}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-slate-500">
            Landlord and new here?{" "}
            <Link to="/signup" className="font-medium text-brand-600 hover:underline">
              Create an account
            </Link>
          </p>
          <p className="mt-1 text-center text-xs text-slate-400">
            Tenants: your landlord invites you — then sign in here.
          </p>
        </CardBody>
      </Card>
    </PublicLayout>
  );
}

export function SignupPage() {
  const { signUp } = useAuth();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error: err, needsConfirmation } = await signUp(
      email.trim(),
      password,
      fullName.trim(),
      phone.trim()
    );
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    if (needsConfirmation) {
      navigate("/login?check-email=1", { replace: true });
    } else {
      navigate("/onboarding", { replace: true });
    }
  };

  return (
    <PublicLayout>
      <Card>
        <CardBody>
          <h1 className="text-xl font-bold">Create your landlord account</h1>
          <p className="mt-1 text-sm text-slate-500">
            Start a free trial — no card required.
          </p>
          <form onSubmit={submit} className="mt-4 space-y-4">
            <Field label="Full name" required>
              <Input value={fullName} onChange={(e) => setFullName(e.target.value)} required autoComplete="name" />
            </Field>
            <Field label="Phone (M-Pesa number)" required hint="Used for account recovery.">
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} required inputMode="tel" placeholder="0712 345 678" />
            </Field>
            <Field label="Email" required>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
            </Field>
            <Field label="Password" required hint="At least 8 characters.">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
            </Field>
            {error && <ErrorBanner message={error} />}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Creating account…" : "Create account"}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-slate-500">
            Already have an account?{" "}
            <Link to="/login" className="font-medium text-brand-600 hover:underline">
              Sign in
            </Link>
          </p>
        </CardBody>
      </Card>
    </PublicLayout>
  );
}
