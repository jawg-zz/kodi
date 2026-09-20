import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import "./index.css";
import App from "./App.tsx";
import { AuthProvider } from "./lib/auth.tsx";
import { convex, convexConfigured } from "./lib/convex.ts";

function ConfigError() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4">
      <div className="max-w-md rounded-xl bg-white p-6 text-sm text-slate-700">
        <h1 className="text-lg font-bold text-slate-900">Convex is not configured</h1>
        <p className="mt-2">
          Run <code>npx convex dev</code> once from the repo root (it provisions
          the backend), then copy the <code>CONVEX_URL</code> it prints into{" "}
          <code>apps/web/.env</code> as <code>VITE_CONVEX_URL</code> and restart
          the dev server.
        </p>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {convexConfigured ? (
      <ConvexAuthProvider client={convex}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ConvexAuthProvider>
    ) : (
      <ConfigError />
    )}
  </StrictMode>,
);
