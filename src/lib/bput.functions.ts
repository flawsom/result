// Server-side proxy to BPUT's undocumented result endpoints. Runs on the
// worker so the browser is never exposed to CORS from results.bput.ac.in
// and so the upstream integration is isolated behind one seam we control.
//
// Reliability: every upstream call is wrapped with an AbortController
// timeout and a single retry with backoff on network error / timeout / 5xx.
// 4xx passes through unretried. Errors are re-thrown with stable prefixes
// so the client can branch on category without needing class instances
// (server-fn errors are serialized as plain messages across the wire).
import { createServerFn } from "@tanstack/react-start";
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

function assertRollNo(rollNo: string): string {
  const trimmed = rollNo.trim();
  if (!REG_NO_RE.test(trimmed)) {
    throw new Error(`${ERR.BAD_INPUT}: Invalid registration number format.`);
  }
  return trimmed;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
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

async function bputPost<T>(path: string, label: string): Promise<T> {
  const url = `${BPUT_BASE}${path}`;
  // Never log query string — it may carry rollNo / dob. Log the label only.
  console.log(`[bput] ${label}`);

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(url);

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

export const fetchStudentDetails = createServerFn({ method: "POST" })
  .validator((data: { rollNo: string }) => data)
  .handler(async ({ data }): Promise<StudentDetails> => {
    const rollNo = assertRollNo(data.rollNo);
    return bputPost<StudentDetails>(
      `/student-detsils-results?rollNo=${encodeURIComponent(rollNo)}`,
      "fetchStudentDetails",
    );
  });

export const fetchResultList = createServerFn({ method: "POST" })
  .validator((data: { rollNo: string; dob: string; session: string }) => data)
  .handler(async ({ data }): Promise<ResultListItem[]> => {
    const rollNo = assertRollNo(data.rollNo);
    const dob = data.dob.trim();
    const session = data.session.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      throw new Error(`${ERR.BAD_INPUT}: Invalid dob format. Expected YYYY-MM-DD.`);
    }
    if (!session) throw new Error(`${ERR.BAD_INPUT}: Session is required.`);
    return bputPost<ResultListItem[]>(
      `/student-results-list?rollNo=${encodeURIComponent(rollNo)}&dob=${encodeURIComponent(dob)}&session=${encodeURIComponent(session)}`,
      "fetchResultList",
    );
  });

export const fetchSubjects = createServerFn({ method: "POST" })
  .validator((data: { rollNo: string; semId: string; session: string }) => data)
  .handler(async ({ data }): Promise<SubjectsResponse> => {
    const rollNo = assertRollNo(data.rollNo);
    const semId = data.semId.trim();
    const session = data.session.trim();
    if (!SEM_ID_RE.test(semId)) throw new Error(`${ERR.BAD_INPUT}: Invalid semester id.`);
    if (!session) throw new Error(`${ERR.BAD_INPUT}: Session is required.`);
    return bputPost<SubjectsResponse>(
      `/student-results-subjects-list?semid=${encodeURIComponent(semId)}&rollNo=${encodeURIComponent(rollNo)}&session=${encodeURIComponent(session)}`,
      "fetchSubjects",
    );
  });
