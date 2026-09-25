import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { PublicLayout } from "../components/Layout";
import { Button } from "../components/Button";
import { Card, CardBody, Loading } from "../components/ui";

/**
 * Sign-in lives on Logto-hosted pages. These screens explain the handoff
 * and preserve invite links across the round-trip. An already-signed-in
 * user landing here (back button, stale link) goes home — HomeRedirect
 * sorts out onboarding / app / portal.
 */
export function LoginPage() {
  const { signIn, loading, isAuthenticated } = useAuth();
  const navigate = useNavigate();

  if (!loading && isAuthenticated) return <Navigate to="/" replace />;
  if (loading) {
    return (
      <PublicLayout>
        <Loading label="Checking your session…" />
      </PublicLayout>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await signIn();
  };

  return (
    <PublicLayout>
      <Card>
        <CardBody>
          <h1 className="text-xl font-bold">Sign in</h1>
          <p className="mt-1 text-sm text-slate-500">
            Landlords, managers and tenants use the same sign in.
          </p>
          <form onSubmit={submit} className="mt-4 space-y-4">
            <Button type="submit" className="w-full">
              Continue to secure sign in
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-slate-500">
            Landlord and new here?{" "}
            <button
              type="button"
              onClick={() => navigate("/signup")}
              className="font-medium text-brand-600 hover:underline"
            >
              Create an account
            </button>
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
  const { signUp, loading, isAuthenticated } = useAuth();

  if (!loading && isAuthenticated) return <Navigate to="/" replace />;
  if (loading) {
    return (
      <PublicLayout>
        <Loading label="Checking your session…" />
      </PublicLayout>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await signUp("", "", "", "");
  };

  return (
    <PublicLayout>
      <Card>
        <CardBody>
          <h1 className="text-xl font-bold">Create your landlord account</h1>
          <p className="mt-1 text-sm text-slate-500">
            Start a free trial — no card required. You&apos;ll set up your
            business name and M-Pesa number after signing up.
          </p>
          <form onSubmit={submit} className="mt-4 space-y-4">
            <Button type="submit" className="w-full">
              Create account
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-slate-500">
            Already have an account?{" "}
            <Link
              to="/login"
              className="font-medium text-brand-600 hover:underline"
            >
              Sign in
            </Link>
          </p>
        </CardBody>
      </Card>
    </PublicLayout>
  );
}
