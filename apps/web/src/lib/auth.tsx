import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { Org, OrgMember, Profile, Tenant } from "./types";

type Role = "staff" | "tenant" | null;

interface AuthState {
  loading: boolean;
  session: Session | null;
  user: User | null;
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
    phone: string
  ) => Promise<{ error: string | null; needsConfirmation: boolean }>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [membership, setMembership] = useState<OrgMember | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);

  const loadUserData = useCallback(async (userId: string) => {
    // Profile (upsert so first login creates it)
    const existing = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();
    if (existing.data) {
      setProfile(existing.data as Profile);
    } else {
      const created = await supabase
        .from("profiles")
        .insert({ id: userId, full_name: "" })
        .select("*")
        .maybeSingle();
      setProfile((created.data as Profile) ?? null);
    }

    // Staff membership
    const m = await supabase
      .from("org_members")
      .select("*, org:orgs(*)")
      .eq("user_id", userId)
      .maybeSingle();
    if (m.data) {
      setMembership({
        org_id: (m.data as { org_id: string }).org_id,
        user_id: userId,
        role: (m.data as { role: OrgMember["role"] }).role,
      });
      setOrg((m.data as { org: Org }).org);
    } else {
      setMembership(null);
      setOrg(null);
    }

    // Tenant portal link. The embedded tenant may come back as an object
    // (to-one) or a one-element array depending on the PostgREST version —
    // accept both so tenant logins are never misread as "no tenant".
    const t = await supabase
      .from("tenant_users")
      .select("tenant:tenants(*)")
      .eq("user_id", userId)
      .maybeSingle();
    const linked = (t.data as unknown as { tenant?: Tenant | Tenant[] | null } | null)?.tenant;
    setTenant(Array.isArray(linked) ? (linked[0] ?? null) : (linked ?? null));
  }, []);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!alive) return;
      setSession(data.session);
      if (data.session?.user) await loadUserData(data.session.user.id);
      if (alive) setLoading(false);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (!alive) return;
      setSession(newSession);
      if (newSession?.user) void loadUserData(newSession.user.id);
      else {
        setProfile(null);
        setOrg(null);
        setMembership(null);
        setTenant(null);
      }
    });
    return () => {
      alive = false;
      subscription.unsubscribe();
    };
  }, [loadUserData]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error ? error.message : null;
  }, []);

  const signUp = useCallback(
    async (email: string, password: string, fullName: string, phone: string) => {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: fullName, phone },
          // Confirmation links must land on the deployed app, not localhost.
          emailRedirectTo: `${window.location.origin}/login`,
        },
      });
      if (error) return { error: error.message, needsConfirmation: false };
      if (data.user) {
        // Best-effort: RLS may hide the profiles row until a session exists.
        try {
          await supabase
            .from("profiles")
            .upsert({ id: data.user.id, full_name: fullName, phone });
        } catch {
          // create_org_with_owner backfills the profile at onboarding.
        }
        try {
          await loadUserData(data.user.id);
        } catch {
          // Tables are unreadable pre-confirmation; onboarding reloads.
        }
      }
      // If email confirmation is on, session is null until they confirm.
      return { error: null, needsConfirmation: !data.session };
    },
    [loadUserData]
  );

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const refresh = useCallback(async () => {
    if (session?.user) await loadUserData(session.user.id);
  }, [session, loadUserData]);

  const role: Role = membership ? "staff" : tenant ? "tenant" : session ? null : null;

  return (
    <AuthContext.Provider
      value={{
        loading,
        session,
        user: session?.user ?? null,
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
