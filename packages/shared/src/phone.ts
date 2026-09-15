/**
 * Kenyan mobile numbers: 070x–079x and 010x–019x.
 * Canonical storage format: 2547XXXXXXXX / 2541XXXXXXXX (12 digits).
 */

export function normalizeKenyanPhone(input: string): string | null {
  if (!input) return null;
  let digits = input.replace(/\D/g, "");
  // 0712345678 / 0110123456
  if (digits.length === 10 && digits.startsWith("0")) {
    digits = "254" + digits.slice(1);
  } else if (digits.length === 9 && (digits.startsWith("7") || digits.startsWith("1"))) {
    digits = "254" + digits;
  }
  if (digits.length !== 12 || !digits.startsWith("254")) return null;
  const local = digits.slice(3);
  if (!local.startsWith("7") && !local.startsWith("1")) return null;
  return digits;
}

export function isValidKenyanPhone(input: string): boolean {
  return normalizeKenyanPhone(input) !== null;
}

/** 254712345678 -> 0712 345 678 (for display) */
export function formatPhoneLocal(phone: string): string {
  const n = normalizeKenyanPhone(phone);
  if (!n) return phone;
  const local = n.slice(3); // 9 digits: 712345678
  return `0${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
}

/** 254712345678 -> 0712 *** 678 */
export function maskPhone(phone: string): string {
  const n = normalizeKenyanPhone(phone);
  if (!n) return phone;
  const local = n.slice(3);
  return `0${local.slice(0, 3)} *** ${local.slice(6)}`;
}
