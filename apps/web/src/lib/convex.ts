import { ConvexReactClient } from "convex/react";

const url = import.meta.env.VITE_CONVEX_URL as string | undefined;

if (!url) {
  // Rendered by <ConfigError/> in main.tsx; keep a console banner too.
  console.error(
    "Missing VITE_CONVEX_URL. Run `npx convex dev` once (it writes .env.local with CONVEX_URL), " +
      "then set VITE_CONVEX_URL to that value in apps/web/.env and restart the dev server.",
  );
}

export const convexConfigured = Boolean(url);

export const convex = new ConvexReactClient(
  url ?? "https://placeholder.convex.cloud",
);
