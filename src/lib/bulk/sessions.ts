// Derives the 8 semester session labels from a batch year, matching the
// public app's convention. Also provides back paper candidate sessions:
// BPUT republishes the full semester result under a later session label
// when supplementary/back-paper marks are added, so for each semId we
// enumerate the primary session plus a handful of subsequent regular
// sessions to catch those updates.
export interface SemPlan {
  semId: string;
  session: string;
}

export interface SemAttempts {
  semId: string;
  primary: string;
  /** Later sessions to also try (back-paper republications). */
  backAttempts: string[];
}

export function parseBatchYear(batch: string): number | null {
  const m = batch.match(/(\d{4})/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function sessionLabel(yearStart: number, term: "Odd" | "Even"): string {
  const yearEnd = (yearStart + 1) % 100;
  return `${term}-(${yearStart}-${String(yearEnd).padStart(2, "0")})`;
}

/** Original primary-session plan (backwards compatible). */
export function getSemesterSessions(batchStartYear: number): SemPlan[] {
  const out: SemPlan[] = [];
  for (let sem = 1; sem <= 8; sem++) {
    const yearOffset = Math.floor((sem - 1) / 2);
    const yearStart = batchStartYear + yearOffset;
    const term: "Odd" | "Even" = sem % 2 === 1 ? "Odd" : "Even";
    out.push({ semId: String(sem), session: sessionLabel(yearStart, term) });
  }
  return out;
}

/**
 * For each semester, return the primary exam session plus subsequent
 * sessions where BPUT commonly republishes results after back paper
 * (supplementary) exams. Capped at a reasonable window so we don't
 * hammer the upstream forever — typically the semester after and the
 * matching term of the next academic year are enough.
 */
export function getSemesterAttempts(batchStartYear: number, windowSessions = 4): SemAttempts[] {
  const out: SemAttempts[] = [];
  const currentYear = new Date().getFullYear();
  // Cap the last-year we'll try (a small buffer past the batch's
  // expected graduation to catch late back paper publications).
  const maxYearStart = Math.max(batchStartYear + 4, currentYear);

  for (let sem = 1; sem <= 8; sem++) {
    const yearOffset = Math.floor((sem - 1) / 2);
    const yearStart = batchStartYear + yearOffset;
    const term: "Odd" | "Even" = sem % 2 === 1 ? "Odd" : "Even";
    const primary = sessionLabel(yearStart, term);

    const backAttempts: string[] = [];
    // Walk forward in half-year steps (alternating terms), starting from
    // the term immediately after the primary.
    let y = yearStart;
    let t: "Odd" | "Even" = term === "Odd" ? "Even" : "Odd";
    if (t === "Odd") y += 1; // Even → next Odd rolls the year
    for (let i = 0; i < windowSessions; i++) {
      if (y > maxYearStart) break;
      backAttempts.push(sessionLabel(y, t));
      if (t === "Odd") {
        t = "Even";
      } else {
        t = "Odd";
        y += 1;
      }
    }

    out.push({ semId: String(sem), primary, backAttempts });
  }
  return out;
}
