import { describe, expect, it } from "vitest";
import {
  formatPhoneLocal,
  isValidKenyanPhone,
  maskPhone,
  normalizeKenyanPhone,
} from "./phone";

describe("normalizeKenyanPhone", () => {
  it("normalizes common input formats to 254 canonical", () => {
    expect(normalizeKenyanPhone("0712345678")).toBe("254712345678");
    expect(normalizeKenyanPhone("+254712345678")).toBe("254712345678");
    expect(normalizeKenyanPhone("254712345678")).toBe("254712345678");
    expect(normalizeKenyanPhone("712345678")).toBe("254712345678");
    expect(normalizeKenyanPhone("0712 345 678")).toBe("254712345678");
    expect(normalizeKenyanPhone("0712-345-678")).toBe("254712345678");
    expect(normalizeKenyanPhone("0110123456")).toBe("254110123456");
    expect(normalizeKenyanPhone("+254 745 123 456")).toBe("254745123456");
  });

  it("rejects invalid numbers", () => {
    expect(normalizeKenyanPhone("")).toBeNull();
    expect(normalizeKenyanPhone("071234567")).toBeNull(); // too short
    expect(normalizeKenyanPhone("0812345678")).toBeNull(); // not a mobile prefix
    expect(normalizeKenyanPhone("254812345678")).toBeNull(); // bad prefix after 254
    expect(normalizeKenyanPhone("12345")).toBeNull();
    expect(normalizeKenyanPhone("07123456789")).toBeNull(); // too long
  });
});

describe("isValidKenyanPhone", () => {
  it("matches normalize results", () => {
    expect(isValidKenyanPhone("0722000111")).toBe(true);
    expect(isValidKenyanPhone("123")).toBe(false);
  });
});

describe("display helpers", () => {
  it("formats for local display", () => {
    expect(formatPhoneLocal("254712345678")).toBe("0712 345 678");
  });

  it("masks for privacy", () => {
    expect(maskPhone("254712345678")).toBe("0712 *** 678");
  });

  it("returns input unchanged when unparseable", () => {
    expect(formatPhoneLocal("n/a")).toBe("n/a");
    expect(maskPhone("n/a")).toBe("n/a");
  });
});
