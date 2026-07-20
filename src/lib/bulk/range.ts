// Reg-no range expansion. BPUT rolls are numeric-only (8-12 digits) with
// fixed width per batch/branch, so lexicographic-safe zero-padded expansion
// works: start=2101010001, end=2101010005 → 2101010001..2101010005.
const MAX_RANGE = 5000;

export interface ExpandedRange {
  rollNos: string[];
  width: number;
}

export function expandRange(start: string, end: string): ExpandedRange {
  const s = start.trim();
  const e = end.trim();
  if (!/^\d{6,12}$/.test(s) || !/^\d{6,12}$/.test(e)) {
    throw new Error("Both start and end must be 6–12 digit numbers.");
  }
  if (s.length !== e.length) {
    throw new Error("Start and end must have the same number of digits.");
  }
  const sn = BigInt(s);
  const en = BigInt(e);
  if (en < sn) throw new Error("End must be ≥ start.");
  const count = Number(en - sn) + 1;
  if (count > MAX_RANGE) {
    throw new Error(`Range too large (${count}). Max is ${MAX_RANGE}.`);
  }
  const width = s.length;
  const out: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = (sn + BigInt(i)).toString().padStart(width, "0");
  }
  return { rollNos: out, width };
}
