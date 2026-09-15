import { describe, expect, it } from "vitest";
import {
  formatKES,
  formatKESShort,
  parseKES,
} from "./money";

describe("formatKES", () => {
  it("formats whole shillings with thousands separators", () => {
    expect(formatKES(25000)).toBe("KES 25,000");
    expect(formatKES(1500000)).toBe("KES 1,500,000");
    expect(formatKES(0)).toBe("KES 0");
    expect(formatKES(999)).toBe("KES 999");
  });

  it("rounds fractional input", () => {
    expect(formatKES(1500.49)).toBe("KES 1,500");
  });
});

describe("formatKESShort", () => {
  it("abbreviates large amounts", () => {
    expect(formatKESShort(2_500_000)).toBe("KES 2.5M");
    expect(formatKESShort(25_000)).toBe("KES 25K");
    expect(formatKESShort(8_500)).toBe("KES 8,500");
  });
});

describe("parseKES", () => {
  it("parses strings with commas and spaces", () => {
    expect(parseKES("25,000")).toBe(25000);
    expect(parseKES(" 15000 ")).toBe(15000);
    expect(parseKES("12,500.60")).toBe(12501);
  });

  it("parses numbers", () => {
    expect(parseKES(2500)).toBe(2500);
    expect(parseKES(10.4)).toBe(10);
  });

  it("rejects invalid input", () => {
    expect(parseKES("")).toBeNull();
    expect(parseKES("abc")).toBeNull();
    expect(parseKES("-5")).toBeNull();
    expect(parseKES(NaN)).toBeNull();
    expect(parseKES(Infinity)).toBeNull();
  });
});
