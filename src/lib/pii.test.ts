import { findPii, isIban, luhn } from "./pii";

describe("findPii", () => {
  it("checks Luhn and IBAN", () => {
    expect(luhn("4111111111111111")).toBe(true);
    expect(luhn("4111111111111112")).toBe(false);
    expect(isIban("GB82WEST12345698765432")).toBe(true);
    expect(isIban("GB82WEST12345698765433")).toBe(false);
  });

  it("finds the personal details this check promises", () => {
    const text = [
      "Write ada@example.com",
      "Call (415) 555-2671",
      "Card 4111 1111 1111 1111",
      "IBAN GB82 WEST 1234 5698 7654 32",
      "Aadhaar 2345 6789 0123",
      "PAN ABCDE1234F",
      "SSN 123-45-6789",
      "Key AKIAIOSFODNN7EXAMPLE",
    ].join("\n");
    const kinds = findPii(text).map((hit) => hit.kind);
    expect(kinds).toEqual(["email", "phone", "card", "iban", "aadhaar", "pan", "ssn", "key"]);
  });

  it("does not treat a short number or a normal sentence as a secret", () => {
    expect(findPii("Page 12 of the quarterly memo.")).toEqual([]);
    expect(findPii("Call room 12.")).toEqual([]);
  });

  it("lets a card number win over a phone-shaped slice of the same digits", () => {
    const hits = findPii("4111111111111111");
    expect(hits.map((hit) => hit.kind)).toEqual(["card"]);
  });
});
