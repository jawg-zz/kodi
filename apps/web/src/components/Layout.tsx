import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Button } from "./Button";
import { convex } from "../lib/convex";
import { api } from "../../../../convex/_generated/api";

const links = [
  { to: "/app", end: true, label: "Dashboard" },
  { to: "/app/properties", label: "Properties" },
  { to: "/app/tenants", label: "Tenants" },
  { to: "/app/invoices", label: "Invoices" },
  { to: "/app/payments", label: "Payments" },
  { to: "/app/reports", label: "Reports" },
  { to: "/app/settings", label: "Settings" },
];

function useIsOperator() {
  const [isOp, setIsOp] = useState(false);
  useEffect(() => {
    convex
      .query((api as any).operator.amPlatformAdmin, {})
      .then((v) => setIsOp(v as boolean))
      .catch(() => setIsOp(false));
  }, []);
  return isOp;
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `block rounded-lg px-3 py-2 text-sm font-medium transition ${
    isActive ? "bg-slate-800 text-white" : "text-slate-300 hover:bg-slate-800 hover:text-white"
  }`;

/** Multi-org staff: switch between businesses (property managers). */
function OrgSwitcher({ compact = false }: { compact?: boolean }) {
  const { org, myOrgs, setActiveOrgId } = useAuth();
  if (myOrgs.length < 2 || !org) return null;
  return (
    <select
      aria-label="Switch business"
      value={org.id}
      onChange={(e) => {
        setActiveOrgId(e.target.value);
        window.location.assign("/app");
      }}
      className={
        compact
          ? "w-full rounded-lg bg-slate-800 px-2 py-1.5 text-xs text-slate-200"
          : "mt-1 w-full rounded-lg bg-slate-800 px-2 py-1.5 text-xs text-slate-200"
      }
    >
      {myOrgs.map((o) => (
        <option key={o.orgId} value={o.orgId}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

export function AppLayout() {
  const { org, membership, signOut, profile } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const isOperator = useIsOperator();

  const handleSignOut = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  return (
    <div className="no-print min-h-screen lg:flex">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col bg-slate-900 text-slate-200 lg:flex">
        <div className="border-b border-slate-700 px-5 py-5">
          <p className="text-xl font-bold text-white">Kodi</p>
          <p className="mt-0.5 truncate text-xs text-slate-400">{org?.name ?? "Rent Manager"}</p>
          <OrgSwitcher />
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end} className={navLinkClass}>
              {l.label}
            </NavLink>
          ))}
          {isOperator && (
            <NavLink to="/operator" className={navLinkClass}>
              Operator
            </NavLink>
          )}
        </nav>
        <div className="border-t border-slate-700 p-4 text-xs">
          <p className="truncate text-slate-300">{profile?.full_name || "Account"}</p>
          <p className="mt-0.5 text-slate-500">{membership?.role}</p>
          <button onClick={handleSignOut} className="mt-2 text-slate-400 underline hover:text-white">
            Sign out
          </button>
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="sticky top-0 z-40 bg-slate-900 text-slate-200 lg:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="min-w-0">
            <p className="text-lg font-bold leading-tight text-white">Kodi</p>
            <p className="truncate text-xs text-slate-400">{org?.name ?? "Rent Manager"}</p>
            <OrgSwitcher compact />
          </div>
          <button
            onClick={() => setMenuOpen((o) => !o)}
            aria-expanded={menuOpen}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            className="rounded-lg p-2 text-slate-300 hover:bg-slate-800 hover:text-white"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              {menuOpen ? (
                <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              ) : (
                <path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              )}
            </svg>
          </button>
        </div>
        {menuOpen && (
          <nav className="space-y-1 border-t border-slate-700 px-3 py-3">
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} end={l.end} className={navLinkClass} onClick={() => setMenuOpen(false)}>
                {l.label}
              </NavLink>
            ))}
            {isOperator && (
              <NavLink to="/operator" className={navLinkClass} onClick={() => setMenuOpen(false)}>
                Operator
              </NavLink>
            )}
            <div className="border-t border-slate-700 pt-3 text-xs text-slate-400">
              <p className="px-3 truncate">{profile?.full_name || "Account"}</p>
              <p className="px-3 mt-0.5">{membership?.role}</p>
              <button
                onClick={handleSignOut}
                className="mt-2 block rounded-lg px-3 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white"
              >
                Sign out
              </button>
            </div>
          </nav>
        )}
      </div>

      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-6xl p-4 sm:p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export function PortalLayout() {
  const { tenant, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  return (
    <div className="no-print min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="text-lg font-bold text-slate-900">Kodi</p>
            <p className="truncate text-xs text-slate-500">
              {tenant ? `Welcome, ${tenant.full_name}` : "Tenant portal"}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-4xl p-4 sm:p-6">
        <Outlet />
      </main>
    </div>
  );
}

export function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <p className="text-3xl font-bold text-white">Kodi</p>
          <p className="mt-1 text-sm text-slate-400">
            Rent management for Kenyan landlords
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}
