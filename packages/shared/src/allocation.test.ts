import { describe, expect, it } from "vitest";
import { allocateFifo, type OpenInvoice } from "./allocation";

const inv = (id: string, month: string, balance: number): OpenInvoice => ({
  id,
  month,
  balance,
});

describe("allocateFifo", () => {
  it("applies to oldest month first", () => {
    const result = allocateFifo(
      [inv("a", "2026-08", 10000), inv("b", "2026-09", 15000)],
      12000
    );
    expect(result.allocations).toEqual([
      { invoiceId: "a", amount: 10000 },
      { invoiceId: "b", amount: 2000 },
    ]);
    expect(result.leftover).toBe(0);
  });

  it("handles partial payment of one invoice", () => {
    const result = allocateFifo([inv("a", "2026-09", 15000)], 5000);
    expect(result.allocations).toEqual([{ invoiceId: "a", amount: 5000 }]);
    expect(result.leftover).toBe(0);
  });

  it("reports leftover credit on overpayment", () => {
    const result = allocateFifo([inv("a", "2026-09", 15000)], 20000);
    expect(result.allocations).toEqual([{ invoiceId: "a", amount: 15000 }]);
    expect(result.leftover).toBe(5000);
  });

  it("skips invoices with zero balance", () => {
    const result = allocateFifo(
      [inv("paid", "2026-07", 0), inv("a", "2026-09", 8000)],
      3000
    );
    expect(result.allocations).toEqual([{ invoiceId: "a", amount: 3000 }]);
  });

  it("returns empty when amount is zero", () => {
    const result = allocateFifo([inv("a", "2026-09", 8000)], 0);
    expect(result.allocations).toEqual([]);
    expect(result.leftover).toBe(0);
  });

  it("sorts independent of input order", () => {
    const result = allocateFifo(
      [inv("new", "2026-10", 9000), inv("old", "2026-08", 9000)],
      5000
    );
    expect(result.allocations).toEqual([
      { invoiceId: "old", amount: 5000 },
    ]);
  });
});
