import { ConvexError } from "convex/values";

/**
 * Daraja credential encryption (AES-GCM, key from CREDENTIALS_KEY env).
 * Port of supabase/functions/_shared/mod.ts. Used by actions (Node runtime)
 * and the internal creds reader — never imported by queries.
 */

/** process.env in actions (Node runtime). Declared locally to avoid @types/node. */
declare const process: { env: Record<string, string | undefined> };

async function credKey(): Promise<CryptoKey> {
  const raw = process.env.CREDENTIALS_KEY ?? "";
  if (!raw) throw new ConvexError("CREDENTIALS_KEY env var is not configured");
  const bytes = new TextEncoder().encode(raw.padEnd(32, "0").slice(0, 32));
  return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecret(plain: string): Promise<string> {
  const key = await credKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain),
  );
  const buf = new Uint8Array(12 + ct.byteLength);
  buf.set(iv, 0);
  buf.set(new Uint8Array(ct), 12);
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s);
}

export async function decryptSecret(stored: string): Promise<string> {
  const key = await credKey();
  const bin = atob(stored);
  const raw = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: raw.slice(0, 12) },
    key,
    raw.slice(12),
  );
  return new TextDecoder().decode(pt);
}
