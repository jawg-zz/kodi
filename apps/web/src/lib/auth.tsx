import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "convex/react";
import type { User } from "oidc-client-ts";
import { api } from "../../../../convex/_generated/api";
import {
  getAccessToken,
  signInRedirect,
  signUpRedirect,
  userManager,
  zitadelConfigured,
} from "./zitadel";
import type { Org, OrgMember, Profile, Tenant } from "./types";

type Role = "staff" | "tenant" | null;

interface AuthState {
  loading: boolean;
  /** True when a non-expired Zitadel session exists. */
  isAuthenticated: boolean;
  session: { userId: string } | null;
  user: { id: string } | null;
  role: Role;
  profile: Profile | null;
  org: Org | null;
  membership: OrgMember | null;
  /** For tenant portal users: their tenant row (which carries org_id). */
  tenant: Tenant | null;
  signIn: () => Promise<void>;
  signUp: (
    email: string,
    password: string,
    fullName: string,
    phone: string,
  ) => Promise<{ error: string | null; needsConfirmation: boolean }>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

async function loadStoredUser(): Promise<User | null> {
  try {
    // Drop unreadable/corrupt entries so a bad session can't wedge login.
    const u = await userManager.getUser().catch(() => null);
    if (!u || u.expired) return null;
    return u;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [oidcUser, setOidcUser] = useState<User | null>(null);
  const [oidcLoading, setOidcLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    loadStoredUser()
      .then((u) => {
        if (!cancelled) setOidcUser(u);
      })
      .finally(() => {
        if (!cancelled) setOidcLoading(false);
      });
    const onLoaded = (u: User) => setOidcUser(u && !u.expired ? u : null);
    const onUnloaded = () => setOidcUser(null);
    userManager.events.addUserLoaded(onLoaded);
    userManager.events.addUserUnloaded(onUnloaded);
    userManager.events.addAccessTokenExpired(() => setOidcUser(null));
    return () => {
      cancelled = true;
      userManager.events.removeUserLoaded(onLoaded);
      userManager.events.removeUserUnloaded(onUnloaded);
    };
  }, []);

  const isAuthenticated = oidcUser !== null;
  const myOrg = useQuery(api.orgs.myOrg, isAuthenticated ? {} : "skip");

  const signIn = useCallback(async () => {
    // Clear any stale local session first: a logged-out Zitadel SSO cookie
    // plus a leftover local user replays the old session and bounces
    // straight back to /login in a reload loop.
    await userManager.removeUser().catch(() => {});
    setOidcUser(null);
    await signInRedirect(window.location.pathname);
  }, []);

  // Kept for AuthPages' signature: name/phone are collected at onboarding
  // (createOrg args), not at Zitadel registration.
  const signUp = useCallback(async () => {
    await signUpRedirect();
    return { error: null, needsConfirmation: false };
  }, []);

  const signOut = useCallback(async () => {
    // Clear local state FIRST so the app can never render authenticated
    // from a stale session while the Zitadel redirect is in flight.
    await userManager.removeUser().catch(() => {});
    setOidcUser(null);
    try {
      await userManager.signoutRedirect();
    } catch {
      window.location.assign("/");
    }
  }, []);

  // Reactive query re-runs on writes — nothing to reload manually.
  const refresh = useCallback(async () => {}, []);

  const loading =
    !zitadelConfigured ||
    oidcLoading ||
    (isAuthenticated && myOrg === undefined);

  const org: Org | null =
    myOrg?.org === undefined || myOrg?.org === null
      ? null
      : {
          id: myOrg.org._id,
          name: myOrg.org.name,
          plan_code: myOrg.org.plan_code as Org["plan_code"],
          subscription_status: myOrg.org.subscription_status,
          subscription_period_end:
            myOrg.org.subscription_period_end ?? null,
          invoice_due_day: myOrg.org.invoice_due_day,
          created_at: new Date(myOrg.org._creationTime).toISOString(),
        };

  const membership: OrgMember | null =
    myOrg && myOrg.role !== "tenant"
      ? { org_id: myOrg.org._id, user_id: "", role: myOrg.role }
      : null;

  const profile: Profile | null =
    myOrg?.profile === undefined || myOrg?.profile === null
      ? null
      : {
          id: "",
          full_name: myOrg.profile.full_name,
          phone: myOrg.profile.phone ?? null,
        };

  const tenant: Tenant | null =
    myOrg?.tenant === undefined || myOrg?.tenant === null
      ? null
      : {
          id: myOrg.tenant._id,
          org_id: myOrg.tenant.orgId,
          full_name: myOrg.tenant.full_name,
          phone: myOrg.tenant.phone,
          national_id: myOrg.tenant.national_id,
          unit_id: myOrg.tenant.unitId ?? null,
          move_in_date: myOrg.tenant.move_in_date ?? null,
          deposit_held: myOrg.tenant.deposit_held,
          status: myOrg.tenant.status,
          notes: myOrg.tenant.notes ?? null,
        };

  const role: Role = membership
    ? "staff"
    : tenant
      ? "tenant"
      : null;

  return (
    <AuthContext.Provider
      value={{
        loading,
        isAuthenticated,
        session: isAuthenticated ? { userId: "" } : null,
        user: isAuthenticated ? { id: "" } : null,
        role,
        profile,
        org,
        membership,
        tenant,
        signIn,
        signUp,
        signOut,
        refresh,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/** Exposed for convex.setAuth wiring in main.tsx. */
export { getAccessToken };
