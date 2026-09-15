import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { AuthProvider } from "./lib/auth.tsx";
import { supabaseConfigured } from "./lib/supabase.ts";

function ConfigError() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4">
      <div className="max-w-md rounded-xl bg-white p-6 text-sm text-slate-700">
        <h1 className="text-lg font-bold text-slate-900">Supabase is not configured</h1>
        <p className="mt-2">
          Copy <code>apps/web/.env.example</code> to <code>apps/web/.env</code> and fill in
          your Supabase project URL and anon key (Project settings → API), then restart
          the dev server.
        </p>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {supabaseConfigured ? (
      <AuthProvider>
        <App />
      </AuthProvider>
    ) : (
      <ConfigError />
    )}
  </StrictMode>
);
