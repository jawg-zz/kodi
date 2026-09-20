import {
  createContext,
  useCallback,
  useContext,
  type ReactNode,
} from "react";
import { useQuery } from "convex/react";
import { useAuthActions, useConvexAuth } from "@convex-dev/auth/react";
import { api } from "../../../../convex/_generated/api";
import type { Org, OrgMember, Profile, Tenant } from "./types";

type Role = "staff" | "tenant" | null;

interface AuthState {
  loading: boolean;
  /** Convex Auth: true when a session exists. Replaces Supabase Session. */
  isAuthenticated: boolean;
  session: { userId: string } | null;
  user: { id: string } | null;
  role: Role;
  profile: Profile | null;
  org: Org | null;
  membership: OrgMember | null;
  /** For tenant portal users: their tenant row (which carries org_id). */
  tenant: Tenant | null;
  signIn: (email: string, password: string) => Promise<string | null>;
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const { signIn: convexSignIn, signOut: convexSignOut } = useAuthActions();
  const myOrg = useQuery(api.orgs.myOrg, isAuthenticated ? {} : "skip");

  const signIn = useCallback(
    async (email: string, password: string) => {
      try {
        await convexSignIn("password", {
          email: email.trim().toLowerCase(),
          password,
          flow: "signIn",
        });
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    [convexSignIn],
  );

  const signUp = useCallback(
    async (
      email: string,
      password: string,
      fullName: string,
      phone: string,
    ) => {
      try {
        await convexSignIn("password", {
          email: email.trim().toLowerCase(),
          password,
          name: fullName,
          phone,
          flow: "signUp",
        });
        // Convex Auth Password has no email-confirmation step by default.
        return { error: null, needsConfirmation: false };
      } catch (e) {
        return {
          error: e instanceof Error ? e.message : String(e),
          needsConfirmation: false,
        };
      }
    },
    [convexSignIn],
  );

  const signOut = useCallback(async () => {
    await convexSignOut();
  }, [convexSignOut]);

  // Reactive query re-runs on writes — nothing to reload manually.
  const refresh = useCallback(async () => {}, []);

  const loading = authLoading || (isAuthenticated && myOrg === undefined);

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
