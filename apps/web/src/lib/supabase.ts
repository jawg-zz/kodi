import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) {
  // Rendered by <ConfigError/> in main.tsx; keep a console banner too.
  console.error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy apps/web/.env.example to apps/web/.env and fill in your Supabase project values."
  );
}

export const supabaseConfigured = Boolean(url && anonKey);

export const supabase = createClient(
  url ?? "http://localhost:54321",
  anonKey ?? "placeholder-anon-key"
);
