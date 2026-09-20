import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { claimInvite, getInvite } from "../lib/api";
import { PublicLayout } from "../components/Layout";
import { Button } from "../components/Button";
import { Card, CardBody, ErrorBanner, Loading } from "../components/ui";

/**
 * Invite-link landing: the invitee signs up (or signs in) first, then
 * claims the token to join the business as manager or tenant.
 */
export function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
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

  if (loading) {
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
                First{" "}
                <Link to="/signup" className="font-medium text-brand-600 hover:underline">
                  create your account
                </Link>{" "}
                or{" "}
                <Link to="/login" className="font-medium text-brand-600 hover:underline">
                  sign in
                </Link>
                , then come back here and accept the invite.
              </p>
              {error && <ErrorBanner message={error} />}
              <Button onClick={claim} disabled={busy} className="mt-4 w-full">
                {busy ? "Joining…" : "Accept invite"}
              </Button>
            </>
          )}
        </CardBody>
      </Card>
    </PublicLayout>
  );
}
