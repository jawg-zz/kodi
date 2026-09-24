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

/** Inclusive list of month keys from start to end (both "YYYY-MM"). Caps at 37 entries. */
export function monthRangeList(start: string, end: string): string[] {
  if (!isMonthKey(start) || !isMonthKey(end)) throw new Error(`Invalid month range: ${start}..${end}`);
  const out: string[] = [];
  let cur = start;
  while (cur <= end && out.length < 37) {
    out.push(cur);
    if (cur === end) break;
    cur = addMonths(cur, 1);
  }
  return out;
}

/** UTC "YYYY-MM" for a ms-epoch timestamp (avoids local-timezone drift). */
export function monthKeyFromMs(ms: number): string {
  return monthKey(new Date(ms));
}

/** Start-of-month UTC epoch ms for a month key. */
export function monthStartMs(key: string): number {
  return parseMonthKey(key).getTime();
}

/** Whole days between dueDate "YYYY-MM-DD" (UTC midnight) and nowMs. Negative = not yet due. */
export function daysPastDue(dueDate: string, nowMs: number): number {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(due)) return 0;
  return Math.floor((nowMs - due) / 86_400_000);
}

export type AgingBucket = "Current" | "30+" | "60+" | "90+";

/** Arrears aging bucket from days past due. */
export function agingBucket(days: number): AgingBucket {
  if (days >= 90) return "90+";
  if (days >= 60) return "60+";
  if (days >= 30) return "30+";
  return "Current";
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
