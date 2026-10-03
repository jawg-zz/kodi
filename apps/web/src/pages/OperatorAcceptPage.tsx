import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { convex } from "../lib/convex";
import { api } from "../../../../convex/_generated/api";
import { stashReturnTo } from "../lib/logto";
import { PublicLayout } from "../components/Layout";
import { Button } from "../components/Button";
import { Card, CardBody, ErrorBanner, Loading } from "../components/ui";

/**
 * Operator onboarding: /operator/accept?token=… for invited operators,
 * or bare /operator/accept for first-claim (empty allowlist).
 * The invitee signs in with the invited email, then accepts — their OIDC
 * subject joins platformAdmins. No CLI, no subject-copying.
 */
export function OperatorAcceptPage() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const navigate = useNavigate();
  const { isAuthenticated, loading: authLoading, signIn } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // First-claim needs no preview fetch — the mutation is the check.
  }, []);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      if (token) {
        await convex.mutation((api as any).operator.acceptOperatorInvite, { token });
      } else {
        await convex.mutation((api as any).operator.claimFirstAdmin, {});
      }
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const goSignIn = async () => {
    stashReturnTo(token ? `/operator/accept?token=${token}` : "/operator/accept");
    await signIn();
  };

  if (authLoading) {
    return (
      <PublicLayout>
        <Loading label="Checking your session…" />
      </PublicLayout>
    );
  }

  return (
    <PublicLayout>
      <Card>
        <CardBody>
          <h1 className="text-xl font-bold">Become a platform operator</h1>
          {done ? (
            <>
              <p className="mt-1 text-sm text-slate-600">
                You're an operator now. The console is open to you.
              </p>
              <Button onClick={() => navigate("/operator", { replace: true })} className="mt-4 w-full">
                Open operator console
              </Button>
            </>
          ) : (
            <>
              <p className="mt-1 text-sm text-slate-500">
                {token
                  ? "You've been invited to operate the Kodi platform. Sign in with the invited email address, then accept."
                  : "No operators exist yet — the first signed-in user to accept becomes the platform operator."}
              </p>
              {error && <div className="mt-3"><ErrorBanner message={error} /></div>}
              {isAuthenticated ? (
                <Button onClick={accept} disabled={busy} className="mt-4 w-full">
                  {busy ? "Accepting…" : token ? "Accept operator invite" : "Claim operator access"}
                </Button>
              ) : (
                <Button onClick={goSignIn} className="mt-4 w-full">
                  Sign in to accept
                </Button>
              )}
            </>
          )}
        </CardBody>
      </Card>
    </PublicLayout>
  );
}
