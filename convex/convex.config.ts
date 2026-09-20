import { defineApp } from "convex/server";

/**
 * Convex app config. CREDENTIALS_KEY encrypts Daraja secrets at rest;
 * MPESA_CALLBACK_URL is the public callback (convex site URL + /mpesa-callback).
 * Set both with `npx convex env set ...` — never commit secrets.
 */
const app = defineApp();

export default app;
