import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { claimInvite, getInvite } from "../lib/api";
import { useAuth } from "../lib/auth";
import { stashReturnTo } from "../lib/logto";
import { PublicLayout } from "../components/Layout";
import { Button } from "../components/Button";
import { Card, CardBody, ErrorBanner, Loading } from "../components/ui";

/**
 * Invite-link landing: the invitee registers via Logto with the invited
 * email first, then claims the token to join the business as manager or
 * tenant. The token survives the OIDC round-trip via returnTo storage.
 */
export function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { isAuthenticated, loading: authLoading, signIn } = useAuth();
  const [invite, setInvite] = useState<{
    email: string;
    fullName: string;
    kind: "tenant" | "manager";
    expired: boolean;
    claimed: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    getInvite(token)
      .then(setInvite)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setLoading(false));
  }, [token]);

  const claim = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await claimInvite(token);
      navigate("/", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const goSignIn = async () => {
    if (token) stashReturnTo(`/invite/${token}`);
    await signIn();
  };

  if (loading || authLoading) {
    return (
      <PublicLayout>
        <Loading label="Checking invite…" />
      </PublicLayout>
    );
  }

  return (
    <PublicLayout>
      <Card>
        <CardBody>
          <h1 className="text-xl font-bold">Join your rental business</h1>
          {!invite || error ? (
            <ErrorBanner message={error ?? "Invite not found."} />
          ) : invite.expired ? (
            <ErrorBanner message="This invite has expired. Ask the business owner for a new one." />
          ) : invite.claimed ? (
            <ErrorBanner message="This invite was already used. Sign in to continue." />
          ) : (
            <>
              <p className="mt-1 text-sm text-slate-500">
                {invite.fullName} ({invite.email}) — invited as{" "}
                {invite.kind === "manager" ? "manager" : "tenant"}.
              </p>
              <p className="mt-3 text-sm text-slate-600">
                Register with the invited email address, then come back here
                and accept the invite.
              </p>
              {error && <ErrorBanner message={error} />}
              {isAuthenticated ? (
                <Button onClick={claim} disabled={busy} className="mt-4 w-full">
                  {busy ? "Joining…" : "Accept invite"}
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
