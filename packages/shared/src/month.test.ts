import { describe, expect, it } from "vitest";
import {
  addMonths,
  currentMonthKey,
  dueDateFor,
  formatDate,
  isMonthKey,
  monthKey,
  monthLabel,
  monthRange,
} from "./month";

describe("monthKey / isMonthKey", () => {
  it("builds keys from dates", () => {
    expect(monthKey(new Date(Date.UTC(2026, 8, 14)))).toBe("2026-09");
    expect(monthKey(new Date(Date.UTC(2026, 0, 31)))).toBe("2026-01");
  });

  it("validates keys", () => {
    expect(isMonthKey("2026-09")).toBe(true);
    expect(isMonthKey("2026-13")).toBe(false);
    expect(isMonthKey("sept")).toBe(false);
    expect(isMonthKey("2026-9")).toBe(false);
  });

  it("currentMonthKey is consistent", () => {
    expect(isMonthKey(currentMonthKey())).toBe(true);
  });
});

describe("addMonths", () => {
  it("crosses year boundaries", () => {
    expect(addMonths("2026-11", 2)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-09", 0)).toBe("2026-09");
  });
});

describe("monthLabel", () => {
  it("renders readable labels", () => {
    expect(monthLabel("2026-09")).toBe("September 2026");
    expect(monthLabel("2026-01")).toBe("January 2026");
  });
});

describe("dueDateFor", () => {
  it("handles normal days", () => {
    expect(dueDateFor("2026-09", 5).toISOString()).toBe(
      "2026-09-05T00:00:00.000Z"
    );
  });

  it("clamps to month end (31st in February)", () => {
    const d = dueDateFor("2027-02", 31);
    expect(d.getUTCMonth()).toBe(1);
    expect(d.getUTCDate()).toBe(28);
  });
});

describe("monthRange", () => {
  it("covers exactly the month", () => {
    const r = monthRange("2026-09");
    expect(r.start).toBe("2026-09-01T00:00:00.000Z");
    expect(r.end).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("formatDate", () => {
  it("formats ISO strings", () => {
    expect(formatDate("2026-09-05T00:00:00.000Z")).toMatch(/5 Sep 2026/);
  });
});
