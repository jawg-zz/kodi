/** Month keys are "YYYY-MM" — the canonical period identifier for invoices. */

export function isMonthKey(key: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) return false;
  const d = new Date(`${key}-01T00:00:00Z`);
  return !Number.isNaN(d.getTime());
}

export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function currentMonthKey(): string {
  return monthKey(new Date());
}

export function parseMonthKey(key: string): Date {
  if (!isMonthKey(key)) throw new Error(`Invalid month key: ${key}`);
  return new Date(`${key}-01T00:00:00Z`);
}

export function addMonths(key: string, n: number): string {
  const d = parseMonthKey(key);
  d.setUTCMonth(d.getUTCMonth() + n);
  return monthKey(d);
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function monthLabel(key: string): string {
  const d = parseMonthKey(key);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Due date for a month, clamped to the month's last day (due day 31 in Feb -> Feb 28/29). */
export function dueDateFor(key: string, dueDay: number): Date {
  const d = parseMonthKey(key);
  const lastDay = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
  ).getUTCDate();
  d.setUTCDate(Math.min(Math.max(1, dueDay), lastDay));
  return d;
}

/** Inclusive [start, end) UTC interval covering the whole month, for SQL range queries. */
export function monthRange(key: string): { start: string; end: string } {
  const d = parseMonthKey(key);
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { start: d.toISOString(), end: end.toISOString() };
}

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Locale-independent "5 Sep 2026". */
export function formatDate(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return `${date.getDate()} ${MONTH_SHORT[date.getMonth()]} ${date.getFullYear()}`;
}

export function formatDateTime(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${formatDate(date)} ${hh}:${mm}`;
}
