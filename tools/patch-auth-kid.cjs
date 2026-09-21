/**
 * Postinstall durability patch for @convex-dev/auth@0.0.95.
 *
 * The self-hosted backend image's JWT verifier requires a `kid` (key ID)
 * header on ID tokens to select the verification key from the JWKS, but
 * 0.0.95's `generateToken` signs with `{ alg: "RS256" }` only. Without this
 * patch every authenticated call fails with:
 *   "Could not decode token. JWT may be missing a 'kid' (key ID) header."
 *
 * The patch reads the key ID from the backend's `JWKS` env var (first key's
 * `kid`; ours is "kodi-1") and includes it in the signed protected header.
 * It falls back to the stock header if the env var is missing or malformed,
 * so local/dev setups without JWKS keep working.
 *
 * Idempotent: safe to run on every install. Re-run automatically via the
 * root `postinstall` script.
 *
 * Remove this file when upgrading to an @convex-dev/auth release whose
 * signer sets `kid` natively (v2 does; v2 is a breaking component-model
 * rewrite — see README auth notes before upgrading).
 */
const fs = require("fs");
const path = require("path");

const TARGET = path.join(
  __dirname,
  "..",
  "node_modules",
  "@convex-dev",
  "auth",
  "dist",
  "server",
  "implementation",
  "tokens.js",
);

const MARKER = "buildProtectedHeader";
const OLD_HEADER = '.setProtectedHeader({ alg: "RS256" })';
const NEW_HEADER = ".setProtectedHeader(await buildProtectedHeader())";
const HELPER = `
async function buildProtectedHeader() {
    try {
        const jwks = JSON.parse(requireEnv('JWKS'));
        const kid = jwks?.keys?.[0]?.kid;
        if (typeof kid === 'string' && kid.length > 0 && kid.length <= 128) {
            return { alg: 'RS256', kid };
        }
    }
    catch { /* fall through to header without kid */ }
    return { alg: 'RS256' };
}
export async function generateToken(ctx, args, config) {`;

function main() {
  if (!fs.existsSync(TARGET)) {
    console.log(`[auth-kid-patch] skipping: ${TARGET} not found`);
    return;
  }
  const src = fs.readFileSync(TARGET, "utf8");
  if (src.includes(MARKER)) {
    console.log("[auth-kid-patch] already applied");
    return;
  }
  if (
    !src.includes(OLD_HEADER) ||
    !src.includes("export async function generateToken(ctx, args, config) {")
  ) {
    console.error(
      "[auth-kid-patch] FAILED: expected token-signing code not found — " +
        "the installed @convex-dev/auth version may have changed. " +
        "Review tools/patch-auth-kid.cjs before deploying.",
    );
    process.exit(1);
  }
  const patched = src
    .replace(
      "export async function generateToken(ctx, args, config) {",
      HELPER,
    )
    .replace(OLD_HEADER, NEW_HEADER);
  fs.writeFileSync(TARGET, patched);
  console.log("[auth-kid-patch] applied kid header patch");
}

main();
