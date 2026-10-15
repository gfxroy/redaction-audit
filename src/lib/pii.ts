export type PiiKind = "email" | "phone" | "card" | "iban" | "aadhaar" | "pan" | "ssn" | "key";

export interface PiiHit {
  kind: PiiKind;
  value: string;
  index: number;
}

export function luhn(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19 || /^(\d)\1+$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** IBAN mod-97. Spaces are ignored. */
export function isIban(value: string): boolean {
  const s = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let digits = "";
  for (const c of moved) digits += c >= "A" && c <= "Z" ? String(c.charCodeAt(0) - 55) : c;
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + (ch.charCodeAt(0) - 48)) % 97;
  return rem === 1;
}

interface Rule {
  kind: PiiKind;
  re: RegExp;
  check?: (value: string) => boolean;
}

const RULES: Rule[] = [
  { kind: "key", re: /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g },
  { kind: "key", re: /\bsk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "key", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { kind: "key", re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: "key", re: /\b(?:xox[abprs]-[A-Za-z0-9-]{10,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,})/g },
  { kind: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: "iban", re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\s?[A-Z0-9]{0,4}\b/g, check: isIban },
  { kind: "card", re: /\b\d(?:[ -]?\d){12,18}\b/g, check: luhn },
  { kind: "ssn", re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  { kind: "aadhaar", re: /(?<![+\w])[2-9]\d{3}[ -]\d{4}[ -]\d{4}\b(?![ -]?\d)/g },
  { kind: "pan", re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { kind: "phone", re: /(?:\(\d{3}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g },
  { kind: "phone", re: /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}\b/g },
];

const overlaps = (a: PiiHit, b: PiiHit) => a.index < b.index + b.value.length && b.index < a.index + a.value.length;

/** Personal details in plain text. Earlier rules win when two matches overlap. */
export function findPii(text: string): PiiHit[] {
  const hits: PiiHit[] = [];
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.re)) {
      const value = match[0];
      if (rule.check && !rule.check(value)) continue;
      const hit = { kind: rule.kind, value, index: match.index ?? 0 };
      if (hits.some((kept) => overlaps(kept, hit))) continue;
      hits.push(hit);
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

const PII_COPY: Record<PiiKind, { title: string; why: string }> = {
  email: {
    title: "An email address is in the text",
    why: "Someone who gets the file can write to that person.",
  },
  phone: {
    title: "A phone number is in the text",
    why: "A phone number is enough to call or text that person.",
  },
  card: {
    title: "A card number is in the text",
    why: "A card number can be used to charge the card.",
  },
  iban: {
    title: "A bank account number is in the text",
    why: "An IBAN identifies a bank account.",
  },
  aadhaar: {
    title: "An Aadhaar number is in the text",
    why: "An Aadhaar number identifies a person in India.",
  },
  pan: {
    title: "A PAN is in the text",
    why: "A PAN identifies a taxpayer in India.",
  },
  ssn: {
    title: "A Social Security number is in the text",
    why: "A Social Security number is used to open accounts and prove identity.",
  },
  key: {
    title: "An API key is in the text",
    why: "A key can let someone use an account or a service as you.",
  },
};

export function piiCopy(kind: PiiKind) {
  return PII_COPY[kind];
}
