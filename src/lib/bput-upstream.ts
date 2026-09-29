// Raw, runtime-agnostic client for BPUT's undocumented result endpoints.
//
// Deliberately free of TanStack / Vite / DOM imports so one implementation
// serves every caller: the browser through the server functions in
// `bput.functions.ts`, the in-page census runner, and the headless scheduled
// census tick that has no browser at all. One error taxonomy, one retry policy,
// whichever runtime is driving it.
//
// Reliability: every upstream call is wrapped with an AbortController timeout
// and a single retry with backoff on network error / timeout / 5xx. 4xx passes
// through unretried. Errors are re-thrown with stable prefixes so the client can
// branch on category without needing class instances (server-fn errors are
// serialized as plain messages across the wire).
import type { ResultListItem, StudentDetails, SubjectsResponse } from "./sgpa";

const BPUT_BASE = "https://results.bput.ac.in";

const REG_NO_RE = /^[0-9]{8,12}$/;
const SEM_ID_RE = /^[0-9]{1,3}$/;

// Stable error prefixes. The UI matches on these; do not rename lightly.
export const ERR = {
  TIMEOUT: "BPUT_TIMEOUT",
  UNREACHABLE: "BPUT_UNREACHABLE",
  RATE_LIMITED: "BPUT_RATE_LIMITED",
  NOT_PUBLISHED: "BPUT_NOT_PUBLISHED",
  BAD_INPUT: "BPUT_BAD_INPUT",
  UPSTREAM: "BPUT_UPSTREAM",
} as const;

const TIMEOUT_MS = 7_000;
const RETRY_BACKOFF_MS = 400;

export function assertRollNo(rollNo: string): string {
  const trimmed = rollNo.trim();
  if (!REG_NO_RE.test(trimmed)) {
    throw new Error(`${ERR.BAD_INPUT}: Invalid registration number format.`);
  }
  return trimmed;
}

export function assertSession(session: string): string {
  const trimmed = session.trim();
  if (!trimmed) throw new Error(`${ERR.BAD_INPUT}: Session is required.`);
  return trimmed;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (BPUT-Result-Fetcher)",
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

let logged: ((line: string) => void) | null = null;

/**
 * Route the module's request breadcrumbs somewhere other than console when a
 * headless runner wants them folded into its own run log. Never receives a URL:
 * query strings carry registration numbers.
 */
export function setUpstreamLogger(fn: ((line: string) => void) | null): void {
  logged = fn;
}

function logLine(line: string): void {
  if (logged) logged(line);
  else console.log(`[bput] ${line}`);
}

export async function bputPost<T>(path: string, label: string): Promise<T> {
  const url = `${BPUT_BASE}${path}`;
  // Never log query string, it may carry rollNo / dob. Log the label only.
  logLine(label);

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(url, TIMEOUT_MS);

      if (res.status === 429) {
        const retryAfter = res.headers.get("retry-after") ?? "";
        throw new Error(
          `${ERR.RATE_LIMITED}: Upstream rate-limited${retryAfter ? ` (retry-after=${retryAfter}s)` : ""}.`,
        );
      }
      if (res.status >= 500) {
        // Retryable.
        lastErr = new Error(`${ERR.UPSTREAM}: ${res.status}`);
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
          continue;
        }
        throw lastErr;
      }
      if (res.status === 404) {
        throw new Error(`${ERR.NOT_PUBLISHED}: Not published yet.`);
      }
      if (!res.ok) {
        throw new Error(`${ERR.UPSTREAM}: ${res.status}`);
      }

      const text = await res.text();
      if (!text) {
        throw new Error(`${ERR.NOT_PUBLISHED}: Empty upstream response.`);
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`${ERR.UPSTREAM}: Non-JSON upstream response.`);
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? "";
      // Do not retry classified non-retryable errors.
      if (
        msg.startsWith(ERR.RATE_LIMITED) ||
        msg.startsWith(ERR.NOT_PUBLISHED) ||
        msg.startsWith(ERR.BAD_INPUT) ||
        (msg.startsWith(ERR.UPSTREAM) && !/^BPUT_UPSTREAM: 5/.test(msg))
      ) {
        throw e;
      }
      // AbortError → timeout.
      const isAbort = (e as Error)?.name === "AbortError" || /aborted/i.test(msg);
      lastErr = isAbort
        ? new Error(`${ERR.TIMEOUT}: Upstream took longer than ${TIMEOUT_MS}ms.`)
        : msg.startsWith("BPUT_")
          ? e
          : new Error(`${ERR.UNREACHABLE}: ${msg || "network error"}`);
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error(`${ERR.UNREACHABLE}: unknown`);
}

/** Batch year, branch and college for one registration number. No DOB needed. */
export async function studentDetails(rollNo: string): Promise<StudentDetails> {
  const roll = assertRollNo(rollNo);
  return bputPost<StudentDetails>(
    `/student-detsils-results?rollNo=${encodeURIComponent(roll)}`,
    "studentDetails",
  );
}

/** Grade rows for one semester session. An empty list means not published. */
export async function subjects(input: {
  rollNo: string;
  semId: string;
  session: string;
}): Promise<SubjectsResponse> {
  const roll = assertRollNo(input.rollNo);
  const semId = input.semId.trim();
  const session = assertSession(input.session);
  if (!SEM_ID_RE.test(semId)) throw new Error(`${ERR.BAD_INPUT}: Invalid semester id.`);
  return bputPost<SubjectsResponse>(
    `/student-results-subjects-list?semid=${encodeURIComponent(semId)}&rollNo=${encodeURIComponent(roll)}&session=${encodeURIComponent(session)}`,
    "subjects",
  );
}

export async function resultList(input: {
  rollNo: string;
  dob: string;
  session: string;
}): Promise<ResultListItem[]> {
  const roll = assertRollNo(input.rollNo);
  const dob = input.dob.trim();
  const session = assertSession(input.session);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    throw new Error(`${ERR.BAD_INPUT}: Invalid dob format. Expected YYYY-MM-DD.`);
  }
  return bputPost<ResultListItem[]>(
    `/student-results-list?rollNo=${encodeURIComponent(roll)}&dob=${encodeURIComponent(dob)}&session=${encodeURIComponent(session)}`,
    "resultList",
  );
}
