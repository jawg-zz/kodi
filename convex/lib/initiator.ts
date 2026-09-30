import forge from "node-forge";

/**
 * Daraja initiator SecurityCredential minting.
 *
 * Recipe (per Daraja docs): base64(password) → RSA-encrypt with the M-Pesa
 * X.509 public key using PKCS#1 v1.5 padding (NOT OAEP) → base64(ciphertext).
 *
 * node-forge is pure JS on purpose: this module loads in the Convex V8
 * isolate (queries) as well as the Node action runtime, and neither
 * node:crypto (isolate lacks it) nor WebCrypto (OAEP-only) can do
 * PKCS#1-v1.5 encryption. Same construction the portal docs describe, and
 * the same bytes openssl would produce with -pkeyopt rsa_padding_mode:pkcs1.
 */

function cleanPem(pem: string): string {
  const lines = pem
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("-----"));
  if (lines.length === 0) throw new Error("Empty certificate");
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/**
 * Mint a SecurityCredential from the initiator's plain password and the
 * M-Pesa X.509 cert PEM (Sandbox cert for sandbox, Production for prod —
 * download from the Daraja portal; stored as initiatorCertPem).
 */
export function mintSecurityCredential(
  initiatorPassword: string,
  certPem: string,
): string {
  if (!initiatorPassword) throw new Error("Initiator password is required");
  let cert: forge.pki.Certificate;
  try {
    cert = forge.pki.certificateFromPem(cleanPem(certPem));
  } catch {
    throw new Error(
      "Initiator certificate is not a valid X.509 PEM — paste the M-Pesa public cert from the Daraja portal",
    );
  }
  const step1 = Buffer.from(initiatorPassword, "utf8").toString("base64");
  let encrypted: string;
  try {
    encrypted = (cert.publicKey as forge.pki.rsa.PublicKey).encrypt(
      Buffer.from(step1, "utf8").toString("binary"),
      "RSAES-PKCS1-V1_5",
    );
  } catch {
    throw new Error(
      "Credential encryption failed — the initiator password may exceed the RSA block size",
    );
  }
  return Buffer.from(encrypted, "binary").toString("base64");
}

/** Validate a pasted cert PEM without minting (Settings pre-flight). */
export function inspectInitiatorCert(certPem: string): {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  keyBits: number;
} {
  let cert: forge.pki.Certificate;
  try {
    cert = forge.pki.certificateFromPem(cleanPem(certPem));
  } catch {
    throw new Error("Not a valid X.509 certificate PEM");
  }
  const bits =
    "n" in cert.publicKey
      ? (cert.publicKey as forge.pki.rsa.PublicKey).n.bitLength()
      : 0;
  return {
    subject: cert.subject.attributes
      .map((a) => `${a.shortName}=${a.value}`)
      .join(", "),
    issuer: cert.issuer.attributes
      .map((a) => `${a.shortName}=${a.value}`)
      .join(", "),
    validFrom: cert.validity.notBefore.toISOString(),
    validTo: cert.validity.notAfter.toISOString(),
    keyBits: bits,
  };
}
