import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import "./index.css";
import App from "./App.tsx";
import { AuthProvider, getAccessToken } from "./lib/auth.tsx";
import { convex, convexConfigured } from "./lib/convex.ts";
import { userManager, takeReturnTo, zitadelConfigured } from "./lib/zitadel.ts";
import { Loading } from "./components/ui.tsx";

function ConfigError() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4">
      <div className="max-w-md rounded-xl bg-white p-6 text-sm text-slate-700">
        <h1 className="text-lg font-bold text-slate-900">Auth is not configured</h1>
        <p className="mt-2">
          Set <code>VITE_CONVEX_URL</code>, <code>VITE_ZITADEL_ISSUER</code>{" "}
          and <code>VITE_ZITADEL_CLIENT_ID</code> in <code>apps/web/.env</code>{" "}
          (see <code>.env.example</code>) and restart the dev server.
        </p>
      </div>
    </div>
  );
}

/**
 * Handles OIDC redirects: full login at /auth/callback, silent renew in
 * iframe. Guards against double-processing (StrictMode) and against running
 * with no auth response (direct navigation / stale Zitadel session bounce),
 * both of which previously left users stranded on a reloading sign-in page.
 */
function AuthCallback({ mode }: { mode: "login" | "silent" }) {
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (
      mode === "login" &&
      !window.location.search.includes("code=") &&
      !window.location.search.includes("error=")
    ) {
      // Landed here without an auth response (e.g. logged-out Zitadel
      // session bounced back, or stale redirect). Don't loop — go home.
      window.location.replace("/");
      return;
    }
    const done =
      mode === "login"
        ? userManager.signinRedirectCallback().then(() => {
            window.location.replace(takeReturnTo());
          })
        : userManager.signinSilentCallback();
    done.catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [mode]);
  if (mode === "silent" && !error) return null;
  return (
    <div className="mx-auto max-w-md p-10">
      {error ? (
        <div className="text-sm">
          <p className="text-red-600">Sign-in failed: {error}</p>
          <a href="/" className="mt-2 inline-block font-medium text-brand-600 hover:underline">
            Back to home
          </a>
        </div>
      ) : (
        <Loading label="Finishing sign-in…" />
      )}
    </div>
  );
}

const ready = convexConfigured && zitadelConfigured;

// Feed the Convex client the current Zitadel ID token; re-resolves on
// every request so silent renews take effect without a reload.
if (ready) {
  convex.setAuth(getAccessToken);
}

const pathname = window.location.pathname;
const callbackMode =
  pathname === "/auth/callback"
    ? ("login" as const)
    : pathname === "/auth/silent-renew"
      ? ("silent" as const)
      : null;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {ready ? (
      callbackMode ? (
        <AuthCallback mode={callbackMode} />
      ) : (
        <ConvexProvider client={convex}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ConvexProvider>
      )
    ) : (
      <ConfigError />
    )}
  </StrictMode>,
);
