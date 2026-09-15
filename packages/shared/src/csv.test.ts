import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";

describe("toCsv", () => {
  it("joins headers and rows", () => {
    const csv = toCsv(["name", "amount"], [["Jane", 25000]]);
    expect(csv).toContain("name,amount");
    expect(csv).toContain("Jane,25000");
  });

  it("escapes commas and quotes", () => {
    const csv = toCsv(["note"], [['paid "full" amount, thanks', null]]);
    expect(csv).toContain('"paid ""full"" amount, thanks",');
  });

  it("handles null and undefined as empty", () => {
    const csv = toCsv(["a", "b"], [[null, undefined]]);
    expect(csv).toContain(",");
  });

  it("starts with UTF-8 BOM", () => {
    expect(toCsv(["a"], [[1]]).charCodeAt(0)).toBe(0xfeff);
  });
});
