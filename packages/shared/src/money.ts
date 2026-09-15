/** All money is whole Kenyan shillings (integers) throughout the system. */

const group = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatKES(amount: number): string {
  return `KES ${group.format(Math.round(amount))}`;
}

export function formatKESShort(amount: number): string {
  if (Math.abs(amount) >= 1_000_000) {
    return `KES ${(amount / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (Math.abs(amount) >= 10_000) {
    return `KES ${(amount / 1_000).toFixed(0)}K`;
  }
  return formatKES(amount);
}

/** Parses user input into whole KES. Returns null when not a valid non-negative amount. */
export function parseKES(input: string | number): number | null {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) return null;
    return Math.round(input);
  }
  const cleaned = input.replace(/[,\s]/g, "");
  if (cleaned === "" || !/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Math.round(Number(cleaned));
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}
