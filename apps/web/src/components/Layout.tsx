import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Button } from "./Button";

const links = [
  { to: "/app", end: true, label: "Dashboard" },
  { to: "/app/properties", label: "Properties" },
  { to: "/app/tenants", label: "Tenants" },
  { to: "/app/invoices", label: "Invoices" },
  { to: "/app/payments", label: "Payments" },
  { to: "/app/reports", label: "Reports" },
  { to: "/app/settings", label: "Settings" },
];

export function AppLayout() {
  const { org, membership, signOut, profile } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  return (
    <div className="no-print flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col bg-slate-900 text-slate-200">
        <div className="border-b border-slate-700 px-5 py-5">
          <p className="text-xl font-bold text-white">Kodi</p>
          <p className="mt-0.5 truncate text-xs text-slate-400">
            {org?.name ?? "Rent Manager"}
          </p>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              className={({ isActive }) =>
                `block rounded-lg px-3 py-2 text-sm font-medium transition ${
                  isActive
                    ? "bg-brand-600 text-white"
                    : "text-slate-300 hover:bg-slate-800 hover:text-white"
                }`
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-700 p-4 text-xs">
          <p className="truncate text-slate-300">
            {profile?.full_name || "Account"} · {membership?.role}
          </p>
          <button
            onClick={handleSignOut}
            className="mt-2 text-slate-400 underline hover:text-white"
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-6xl p-6">
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
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <div>
            <p className="text-lg font-bold text-slate-900">Kodi</p>
            <p className="text-xs text-slate-500">
              {tenant ? `Welcome, ${tenant.full_name}` : "Tenant portal"}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-4xl p-6">
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
