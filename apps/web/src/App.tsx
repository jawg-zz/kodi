import { Navigate, Outlet, Route, BrowserRouter, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { AppLayout, PortalLayout } from "./components/Layout";
import { Loading } from "./components/ui";
import { LoginPage, SignupPage } from "./pages/AuthPages";
import { OnboardingPage } from "./pages/OnboardingPage";
import { DashboardPage } from "./pages/DashboardPage";
import { PropertiesPage } from "./pages/PropertiesPage";
import { TenantsPage } from "./pages/TenantsPage";
import { TenantDetailPage } from "./pages/TenantDetailPage";
import { InvoicesPage } from "./pages/InvoicesPage";
import { PaymentsPage, ReceiptPage } from "./pages/PaymentsPage";
import { ReportsPage } from "./pages/ReportsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { PortalPage } from "./pages/PortalPage";
import { InvoiceDocPage, ReceiptDocPage, SettlementDocPage, StatementDocPage } from "./pages/PrintPages";

function RequireAuth() {
  const { loading, session } = useAuth();
  if (loading) {
    return (
      <div className="mx-auto max-w-md p-10">
        <Loading label="Checking your session…" />
      </div>
    );
  }
  if (!session) return <Navigate to="/login" replace />;
  return <Outlet />;
}

/** Signed-in user with no org and no tenant link → onboarding. */
function RequireOrgOrPortal() {
  const { loading, org, tenant, membership } = useAuth();
  if (loading) {
    return (
      <div className="mx-auto max-w-md p-10">
        <Loading label="Loading your account…" />
      </div>
    );
  }
  if (tenant && !membership) return <Navigate to="/portal" replace />;
  if (!org) return <Navigate to="/onboarding" replace />;
  return <Outlet />;
}

function RequireStaff() {
  const { org } = useAuth();
  if (!org) return <Navigate to="/onboarding" replace />;
  return <Outlet />;
}

function RequireTenant() {
  const { tenant } = useAuth();
  if (!tenant) return <Navigate to="/" replace />;
  return <Outlet />;
}

function HomeRedirect() {
  const { loading, session, org, tenant, membership } = useAuth();
  if (loading) {
    return (
      <div className="mx-auto max-w-md p-10">
        <Loading label="Loading…" />
      </div>
    );
  }
  if (!session) return <Navigate to="/login" replace />;
  if (tenant && !membership) return <Navigate to="/portal" replace />;
  if (!org) return <Navigate to="/onboarding" replace />;
  return <Navigate to="/app" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />

        <Route element={<RequireAuth />}>
          <Route path="/onboarding" element={<OnboardingPage />} />

          <Route element={<RequireOrgOrPortal />}>
            <Route element={<RequireStaff />}>
              <Route path="/app" element={<AppLayout />}>
                <Route index element={<DashboardPage />} />
                <Route path="properties" element={<PropertiesPage />} />
                <Route path="tenants" element={<TenantsPage />} />
                <Route path="tenants/:id" element={<TenantDetailPage />} />
                <Route path="invoices" element={<InvoicesPage />} />
                <Route path="payments" element={<PaymentsPage />} />
                <Route path="payments/:id" element={<ReceiptPage />} />
                <Route path="reports" element={<ReportsPage />} />
                <Route path="settings" element={<SettingsPage />} />
              </Route>
            </Route>

            <Route element={<RequireTenant />}>
              <Route path="/portal" element={<PortalLayout />}>
                <Route index element={<PortalPage />} />
              </Route>
            </Route>

            {/* Print documents: staff view (tenant statement also reachable by tenant) */}
            <Route path="/print/invoice/:id" element={<InvoiceDocPage />} />
            <Route path="/print/receipt/:id" element={<ReceiptDocPage />} />
            <Route path="/print/statement/:tenantId" element={<StatementDocPage />} />
            <Route path="/print/settlement/:id" element={<SettlementDocPage />} />
          </Route>
        </Route>

        <Route path="/" element={<HomeRedirect />} />
        <Route path="*" element={<HomeRedirect />} />
      </Routes>
    </BrowserRouter>
  );
}
