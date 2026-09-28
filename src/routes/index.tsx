import { ClientOnly, createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { lazy, Suspense, useState } from "react";

import { ERR, fetchStudentDetails, fetchSubjects } from "@/lib/bput.functions";
import { calculateSGPA, type StudentDetails, type SubjectsResponse } from "@/lib/sgpa";
import { downloadResultPDF } from "@/lib/pdf";
import { readCache, writeCache, recordEvent } from "@/lib/result-cache";
import { DevCacheHUD } from "@/components/DevCacheHUD";
import { SgpaTrendChart } from "@/components/SgpaTrendChart";
import { GradeDistributionChart } from "@/components/GradeDistributionChart";
import { ReverseSgpaCalc } from "@/components/ReverseSgpaCalc";
import { ErrorStateForMessage, NotPublishedState } from "@/components/ResultStates";
import { logResultEvents, type Outcome, type TelemetryEvent } from "@/lib/analytics-client";

const HomeAnalyticsLazy = lazy(() =>
  import("@/components/HomeAnalytics").then((m) => ({ default: m.HomeAnalytics })),
);

// Census section: renders nothing until the census has stored observations, so
// it can be mounted unconditionally without adding an empty frame.
const BputCensusLazy = lazy(() =>
  import("@/components/BputCensus").then((m) => ({ default: m.BputCensus })),
);

// Client-only KaTeX renderer. Renders directly with katex.renderToString to
// avoid any react-katex / bundler interaction that mangles LaTeX commands.
const KatexBlockLazy = lazy(async () => {
  const katex = (await import("katex")).default;
  const Comp = ({ math }: { math: string }) => {
    const html = katex.renderToString(math, {
      displayMode: true,
      throwOnError: false,
      strict: "ignore",
    });
    return <div data-testid="katex-block" dangerouslySetInnerHTML={{ __html: html }} />;
  };
  return { default: Comp };
});

function BlockMath({ math }: { math: string }) {
  return (
    <ClientOnly fallback={<span className="font-mono text-xs">…</span>}>
      <Suspense fallback={<span className="font-mono text-xs">…</span>}>
        <KatexBlockLazy math={math} />
      </Suspense>
    </ClientOnly>
  );
}

import {
  SGPA_FORMULA_TEX as SGPA_FORMULA,
  CGPA_FORMULA_TEX as CGPA_FORMULA,
  SGPA_LEGEND,
  CGPA_LEGEND,
} from "@/lib/formulas";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [{ property: "og:url", content: "https://result.unifies.codes/" }],
    links: [{ rel: "canonical", href: "https://result.unifies.codes/" }],
  }),
});

interface SemPlan {
  semId: string;
  session: string;
}

type SemAttempt = { session: string; data: SubjectsResponse };

type SemState =
  | { status: "pending"; session: string }
  | { status: "loading"; session: string }
  | { status: "done"; session: string; data: SubjectsResponse; attempts: SemAttempt[] }
  | { status: "empty"; session: string }
  | { status: "error"; session: string; error: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Map a BPUT error message onto the telemetry outcome taxonomy. The prefixes
 * come from bput.functions and are stable; anything unrecognised is recorded
 * as "unreachable" rather than guessed at.
 */
function classifyOutcome(message: string): Outcome {
  if (message.startsWith(ERR.TIMEOUT)) return "timeout";
  if (message.startsWith(ERR.RATE_LIMITED)) return "rate_limited";
  if (message.startsWith(ERR.UNREACHABLE)) return "unreachable";
  if (message.startsWith(ERR.NOT_PUBLISHED)) return "not_published";
  if (/non-json/i.test(message)) return "malformed";
  if (message.startsWith(ERR.UPSTREAM)) return "upstream_error";
  if (message.startsWith(ERR.BAD_INPUT)) return "unclassified";
  return "unreachable";
}

function getSemesterSessions(batchStartYear: number): SemPlan[] {
  const out: SemPlan[] = [];
  for (let sem = 1; sem <= 8; sem++) {
    const yearOffset = Math.floor((sem - 1) / 2);
    const yearStart = batchStartYear + yearOffset;
    const yearEnd = (yearStart + 1) % 100;
    const term = sem % 2 === 1 ? "Odd" : "Even";
    out.push({
      semId: String(sem),
      session: `${term}-(${yearStart}-${String(yearEnd).padStart(2, "0")})`,
    });
  }
  return out;
}

/**
 * Back paper (supplementary) result sessions for a given semester's
 * primary session. BPUT republishes the full semester result under a
 * later session label after supplementary exams, so we probe the next
 * few regular sessions and prefer the latest non-empty response.
 */
function getBackPaperSessions(batchStartYear: number, semId: string, windowSessions = 4): string[] {
  const sem = Number(semId);
  if (!Number.isFinite(sem) || sem < 1 || sem > 8) return [];
  const yearOffset = Math.floor((sem - 1) / 2);
  const yearStart = batchStartYear + yearOffset;
  const term: "Odd" | "Even" = sem % 2 === 1 ? "Odd" : "Even";
  const currentYear = new Date().getFullYear();
  const maxYearStart = Math.max(batchStartYear + 4, currentYear);
  const out: string[] = [];
  let y = yearStart;
  let t: "Odd" | "Even" = term === "Odd" ? "Even" : "Odd";
  if (t === "Odd") y += 1;
  for (let i = 0; i < windowSessions; i++) {
    if (y > maxYearStart) break;
    const yEnd = (y + 1) % 100;
    out.push(`${t}-(${y}-${String(yEnd).padStart(2, "0")})`);
    if (t === "Odd") {
      t = "Even";
    } else {
      t = "Odd";
      y += 1;
    }
  }
  return out;
}

function parseBatchYear(batch: string): number | null {
  const m = batch.match(/(\d{4})/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function Index() {
  const router = useRouter();
  const getDetails = useServerFn(fetchStudentDetails);
  const getSubjects = useServerFn(fetchSubjects);

  const [rollNo, setRollNo] = useState("");
  const [student, setStudent] = useState<StudentDetails | null>(null);
  const [plan, setPlan] = useState<SemPlan[]>([]);
  const [semStates, setSemStates] = useState<Record<string, SemState>>({});
  const [fetchingAll, setFetchingAll] = useState(false);

  // Try a semester's primary session then its back-paper republications.
  // Fires the primary first; only probes back-paper candidates in parallel
  // if the primary published. Returns EVERY non-empty attempt so the UI
  // (and PDF) can show both the primary and any republications — plus one
  // anonymous telemetry row per attempt (outcome, latency, attempt index).
  const fetchSemesterWithBackPapers = async (
    studentRoll: string,
    p: SemPlan,
    batchYear: number | null,
    branch: string | null,
  ): Promise<{
    result:
      | { kind: "done"; attempts: SemAttempt[] }
      | { kind: "empty"; session: string }
      | { kind: "error"; session: string; error: string };
    telemetry: TelemetryEvent[];
  }> => {
    const telemetry: TelemetryEvent[] = [];
    const semester = Number(p.semId) || 0;
    const canRecord = batchYear !== null && !!branch && semester >= 1 && semester <= 12;

    const record = (
      attempt: number,
      outcome: Outcome,
      latencyMs: number,
      source: "live" | "cache",
      subjects: number,
    ) => {
      if (!canRecord) return;
      telemetry.push({
        year: batchYear as number,
        semester,
        branch: branch as string,
        outcome,
        latencyMs,
        attempt,
        source,
        subjects,
      });
    };

    const tryOne = async (
      session: string,
      attempt: number,
    ): Promise<SubjectsResponse | { __err: string } | null> => {
      const startedAt = performance.now();
      try {
        const cached = readCache(studentRoll, p.semId, session);
        if (cached) {
          recordEvent(studentRoll, p.semId, session, "CACHE");
          const rows = Array.isArray(cached.grades) ? cached.grades.length : 0;
          record(
            attempt,
            rows > 0 ? "published" : "not_published",
            Math.round(performance.now() - startedAt),
            "cache",
            rows,
          );
          return cached;
        }
        const data = await getSubjects({
          data: { rollNo: studentRoll, semId: p.semId, session },
        });
        const hasGrades = Array.isArray(data?.grades) && data.grades.length > 0;
        if (hasGrades) writeCache(studentRoll, p.semId, session, data);
        recordEvent(studentRoll, p.semId, session, "LIVE");
        record(
          attempt,
          hasGrades ? "published" : "not_published",
          Math.round(performance.now() - startedAt),
          "live",
          hasGrades ? data.grades.length : 0,
        );
        return data;
      } catch (e) {
        const msg = (e as Error).message ?? "";
        const latency = Math.round(performance.now() - startedAt);
        if (msg.startsWith(ERR.NOT_PUBLISHED)) {
          record(attempt, "not_published", latency, "live", 0);
          return null;
        }
        record(attempt, classifyOutcome(msg), latency, "live", 0);
        return { __err: msg };
      }
    };

    // Step 1: primary.
    const primaryRes = await tryOne(p.session, 1);
    let primaryError: string | null = null;
    let primary: SemAttempt | null = null;
    if (primaryRes && "__err" in primaryRes) {
      primaryError = primaryRes.__err;
    } else if (primaryRes && Array.isArray(primaryRes.grades) && primaryRes.grades.length > 0) {
      primary = { session: p.session, data: primaryRes };
    }

    // Step 2: only probe back-papers if primary was published.
    const collected: SemAttempt[] = [];
    if (primary) collected.push(primary);
    if (primary && batchYear !== null) {
      const backSessions = getBackPaperSessions(batchYear, p.semId);
      if (backSessions.length > 0) {
        const probes = await Promise.all(backSessions.map((s, i) => tryOne(s, i + 2)));
        probes.forEach((res, i) => {
          if (res && !("__err" in res) && Array.isArray(res.grades) && res.grades.length > 0) {
            collected.push({ session: backSessions[i], data: res });
          }
        });
      }
    }

    let result: Awaited<ReturnType<typeof fetchSemesterWithBackPapers>>["result"];
    if (collected.length > 0) result = { kind: "done", attempts: collected };
    else if (primaryError) result = { kind: "error", session: p.session, error: primaryError };
    else result = { kind: "empty", session: p.session };
    return { result, telemetry };
  };

  const applyResult = (
    p: SemPlan,
    result:
      | { kind: "done"; attempts: SemAttempt[] }
      | { kind: "empty"; session: string }
      | { kind: "error"; session: string; error: string },
  ) => {
    setSemStates((prev) => {
      const next: Record<string, SemState> = { ...prev };
      if (result.kind === "done") {
        const winning = result.attempts[result.attempts.length - 1];
        next[p.semId] = {
          status: "done",
          session: winning.session,
          data: winning.data,
          attempts: result.attempts,
        };
      } else if (result.kind === "empty") {
        next[p.semId] = { status: "empty", session: result.session };
      } else {
        next[p.semId] = {
          status: "error",
          session: result.session,
          error: result.error,
        };
      }
      return next;
    });
  };

  const startSequentialFetch = async (
    plans: SemPlan[],
    studentRoll: string,
    batchYear: number | null,
    branch: string | null,
  ) => {
    setFetchingAll(true);
    const initial: Record<string, SemState> = {};
    for (const p of plans) {
      initial[p.semId] = { status: "loading", session: p.session };
    }
    setSemStates(initial);

    // All 8 semesters in parallel — this is a single user's own lookup,
    // no cross-user rate limiting to respect. Back-paper probes inside
    // each semester also run in parallel (see fetchSemesterWithBackPapers).
    const outcomes = await Promise.all(
      plans.map(async (p) => {
        const outcome = await fetchSemesterWithBackPapers(studentRoll, p, batchYear, branch);
        applyResult(p, outcome.result);
        return outcome;
      }),
    );
    setFetchingAll(false);

    // Privacy-safe telemetry: one anonymous row per upstream attempt
    // (year, semester, branch + outcome / measured latency / attempt index /
    // live vs cache), written as ONE batched request. The roll number is
    // never part of the payload — not even hashed.
    const telemetry = outcomes.flatMap((o) => o.telemetry);
    if (telemetry.length > 0) logResultEvents(telemetry);
  };

  const retryOneSemester = async (
    p: SemPlan,
    studentRoll: string,
    batchYear: number | null,
    branch: string | null,
  ) => {
    setSemStates((prev) => ({
      ...prev,
      [p.semId]: { status: "loading", session: p.session },
    }));
    const outcome = await fetchSemesterWithBackPapers(studentRoll, p, batchYear, branch);
    applyResult(p, outcome.result);
    if (outcome.telemetry.length > 0) logResultEvents(outcome.telemetry);
  };

  const lookup = useMutation({
    mutationFn: async (input: { roll: string }) => {
      const details = await getDetails({ data: { rollNo: input.roll } });
      return { details };
    },
    onSuccess: ({ details }) => {
      setStudent(details);
      setSemStates({});
      const batchYear = parseBatchYear(details.batch);
      if (batchYear === null) {
        setPlan([]);
        return;
      }
      const plans = getSemesterSessions(batchYear);
      setPlan(plans);
      void startSequentialFetch(plans, details.rollNo, batchYear, details.branchName ?? null);
    },
  });

  const reset = () => {
    setStudent(null);
    setPlan([]);
    setSemStates({});
    setFetchingAll(false);
    setRollNo("");
    lookup.reset();
    router.invalidate();
  };

  const doneStates = plan
    .map((p) => semStates[p.semId])
    .filter((s): s is Extract<SemState, { status: "done" }> => s?.status === "done");
  const finishedCount = plan.filter((p) => {
    const st = semStates[p.semId];
    return st && (st.status === "done" || st.status === "empty" || st.status === "error");
  }).length;
  const allDone = plan.length > 0 && finishedCount === plan.length;

  const cgpa = (() => {
    if (doneStates.length === 0) return null;
    let num = 0;
    let den = 0;
    for (const s of doneStates) {
      const sg = Number(s.data.sgpadetails.sgpa);
      const cr = Number(s.data.sgpadetails.cretits);
      if (!Number.isFinite(sg) || !Number.isFinite(cr) || cr <= 0) continue;
      num += sg * cr;
      den += cr;
    }
    if (den === 0) return null;
    return { value: Math.round((num / den) * 100) / 100, credits: den };
  })();

  const [downloading, setDownloading] = useState(false);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-heavy border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
          <div className="flex items-center gap-4">
            <div className="border-thick size-10 bg-foreground" />
            <div>
              <div className="label-caps">BPUT / Result Fetcher</div>
              <div className="font-display text-xl leading-none">results.bput.ac.in</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to="/admin"
              className="label-caps border-thick px-3 py-2 transition-colors hover:bg-foreground hover:text-background"
            >
              Need Bulk Access ?
            </Link>
            <div className="label-caps hidden sm:block">v1.0 // live</div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-12">
        {!student && (
          <section>
            <h1>
              FETCH YOUR
              <br />
              BPUT RESULT.
            </h1>
            <p className="mt-6 max-w-2xl text-base">
              Enter your registration number. We derive all 8 semester sessions from your batch year
              and pull each published semester directly — no DOB or session input required.
            </p>

            <form
              className="border-heavy mt-10 bg-background p-6 sm:p-8"
              onSubmit={(e) => {
                e.preventDefault();
                const roll = rollNo.trim();
                if (!/^\d{8,12}$/.test(roll)) return;
                lookup.mutate({ roll });
              }}
            >
              <label htmlFor="rollNo" className="label-caps block">
                Registration Number
              </label>
              <input
                id="rollNo"
                name="rollNo"
                inputMode="numeric"
                autoComplete="off"
                placeholder="e.g. 2301429052"
                value={rollNo}
                onChange={(e) => setRollNo(e.target.value.replace(/[^\d]/g, ""))}
                className="border-thick mt-3 block w-full bg-background px-4 py-4 font-mono text-2xl outline-none focus:bg-muted"
              />

              <div className="mt-6 flex flex-wrap items-center gap-4">
                <button
                  type="submit"
                  disabled={lookup.isPending || rollNo.length < 8}
                  className="border-thick bg-foreground px-6 py-3 font-mono text-sm font-bold uppercase tracking-widest text-background transition-colors hover:bg-background hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {lookup.isPending ? "Fetching…" : "Fetch Result"}
                </button>
                <span className="label-caps text-muted-foreground">
                  Live · No accounts · Reg no only
                </span>
              </div>

              {lookup.isError && (
                <div className="mt-6">
                  <ErrorStateForMessage
                    message={(lookup.error as Error).message}
                    onRetry={() => {
                      const roll = rollNo.trim();
                      if (/^\d{8,12}$/.test(roll)) lookup.mutate({ roll });
                    }}
                    retrying={lookup.isPending}
                  />
                </div>
              )}
            </form>

            <ClientOnly fallback={null}>
              <Suspense fallback={null}>
                <HomeAnalyticsLazy />
              </Suspense>
            </ClientOnly>

            <ClientOnly fallback={null}>
              <Suspense fallback={null}>
                <BputCensusLazy />
              </Suspense>
            </ClientOnly>

            <section className="mt-12 border-heavy bg-background p-6 sm:p-8">
              <h2 className="font-display text-xl">How it works</h2>
              <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                BPUT Result Fetcher is an unofficial tool that looks up your BPUT semester result by
                registration number and shows an auto-calculated SGPA and CGPA. Enter your
                registration number and we derive all eight semester sessions from your batch year,
                then fetch each published semester directly from the public BPUT result endpoint —
                server-side, with no account and no password.
              </p>
              <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                <li>
                  <strong>SGPA</strong> (Semester Grade Point Average) is the credit-weighted
                  average of grade points for one semester.
                </li>
                <li>
                  <strong>CGPA</strong> (Cumulative Grade Point Average) averages SGPA across all
                  completed semesters by credit.
                </li>
                <li>
                  You can download a PDF marksheet for each semester, and check grade distribution
                  and an SGPA trend chart.
                </li>
              </ul>
              <p className="mt-4 text-xs text-muted-foreground">
                This is an independent utility and is not affiliated with BPUT. Always verify
                important decisions against your official marksheet at results.bput.ac.in.
              </p>
            </section>
            <FooterNote />
          </section>
        )}

        {student && (
          <section className="space-y-10">
            <StudentCard student={student} onReset={reset} />

            <div>
              <div className="flex flex-wrap items-end justify-between gap-4">
                <h2>PUBLISHED RESULTS</h2>
                <div className="flex items-center gap-4">
                  {plan.length > 0 && (
                    <div className="label-caps text-muted-foreground">
                      {finishedCount} / {plan.length} checked · {doneStates.length} published
                      {fetchingAll && " · fetching…"}
                    </div>
                  )}
                  {allDone && doneStates.length > 0 && (
                    <button
                      onClick={async () => {
                        setDownloading(true);
                        try {
                          await downloadResultPDF({
                            student,
                            semesters: plan
                              .map((p) => {
                                const st = semStates[p.semId];
                                if (st?.status !== "done") return null;
                                const [primary, ...rest] = st.attempts;
                                return {
                                  semId: p.semId,
                                  session: primary.session,
                                  subjects: primary.data,
                                  attempts: rest.map((a) => ({
                                    session: a.session,
                                    subjects: a.data,
                                  })),
                                };
                              })
                              .filter((x): x is NonNullable<typeof x> => x !== null),
                            cgpa: cgpa?.value ?? null,
                          });
                        } finally {
                          setDownloading(false);
                        }
                      }}
                      disabled={downloading}
                      className="border-thick bg-foreground px-5 py-3 font-mono text-xs font-bold uppercase tracking-widest text-background hover:bg-background hover:text-foreground disabled:opacity-40"
                    >
                      {downloading ? "Generating…" : "↓ Download PDF"}
                    </button>
                  )}
                </div>
              </div>

              {plan.length === 0 && (
                <div className="border-thick mt-6 p-6 font-mono text-sm">
                  Could not parse batch year from student record — cannot compute semester sessions.
                </div>
              )}
            </div>

            <div className="space-y-8">
              {plan.map((p) => (
                <SemesterBlock
                  key={p.semId}
                  plan={p}
                  state={semStates[p.semId]}
                  student={student}
                  onRetry={() =>
                    retryOneSemester(
                      p,
                      student.rollNo,
                      parseBatchYear(student.batch),
                      student.branchName ?? null,
                    )
                  }
                />
              ))}
            </div>

            {cgpa && doneStates.length > 1 && (
              <div className="border-heavy bg-foreground p-6 text-background">
                <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
                  <div>
                    <div
                      className="label-caps"
                      style={{ color: "var(--color-background)", opacity: 0.7 }}
                    >
                      Cumulative · {doneStates.length} published semester
                      {doneStates.length === 1 ? "" : "s"}
                    </div>
                    <div className="font-display mt-1 text-2xl">CGPA</div>
                    <div className="mt-3 inline-block bg-background px-3 py-2 text-foreground">
                      <BlockMath math={CGPA_FORMULA} />
                    </div>
                    <div className="mt-2 font-mono text-xs opacity-70">
                      {CGPA_LEGEND} ({cgpa.credits} total credits)
                    </div>
                  </div>
                  <div className="font-display text-6xl leading-none sm:text-8xl">
                    {cgpa.value.toFixed(2)}
                  </div>
                </div>
              </div>
            )}

            {doneStates.length >= 2 && (
              <SgpaTrendChart
                semesters={doneStates.map((s, i) => ({
                  semId: plan.filter((p) => semStates[p.semId]?.status === "done")[i].semId,
                  data: s.data,
                }))}
              />
            )}

            {doneStates.length >= 1 && (
              <GradeDistributionChart semesters={doneStates.map((s) => ({ data: s.data }))} />
            )}

            {cgpa && doneStates.length >= 1 && (
              <ReverseSgpaCalc currentCgpa={cgpa.value} totalCredits={cgpa.credits} />
            )}

            <FooterNote />
          </section>
        )}
      </main>
      <DevCacheHUD />
    </div>
  );
}

function SemesterBlock({
  plan,
  state,
  student,
  onRetry,
}: {
  plan: SemPlan;
  state: SemState | undefined;
  student: StudentDetails;
  onRetry: () => void;
}) {
  if (!state || state.status === "pending" || state.status === "loading") {
    return (
      <div className="border-thick space-y-4 p-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="label-caps">Semester {plan.semId}</div>
            <div className="font-display text-2xl leading-none">{plan.session}</div>
          </div>
          <div className="label-caps text-muted-foreground">
            {state?.status === "loading" ? "Loading…" : "Queued…"}
          </div>
        </div>
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-6 w-full bg-muted animate-pulse" />
          ))}
        </div>
      </div>
    );
  }
  if (state.status === "empty") {
    return (
      <div className="space-y-2">
        <div className="label-caps text-muted-foreground">
          Semester {plan.semId} · {plan.session}
        </div>
        <NotPublishedState label={`Semester ${plan.semId} (${plan.session})`} />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="space-y-2">
        <div className="label-caps text-muted-foreground">
          Semester {plan.semId} · {plan.session}
        </div>
        <ErrorStateForMessage
          message={state.error}
          label={`Semester ${plan.semId} (${plan.session})`}
          onRetry={onRetry}
        />
      </div>
    );
  }
  // Render every attempt (primary + back-paper republications) as its
  // own SGPA block + subject table, tagged so the viewer can tell them
  // apart. The last attempt is authoritative for CGPA math.
  return (
    <div className="space-y-6">
      {state.attempts.map((att, idx) => (
        <div key={`${att.session}-${idx}`} className="space-y-3">
          <div className="label-caps text-muted-foreground">
            {idx === 0 ? "Primary result" : `Back paper republication #${idx}`}
            {" · "}
            {att.session}
          </div>
          <SubjectsTable
            data={att.data}
            student={student}
            semId={plan.semId}
            session={att.session}
          />
        </div>
      ))}
    </div>
  );
}

function StudentCard({ student, onReset }: { student: StudentDetails; onReset: () => void }) {
  return (
    <div className="border-heavy grid grid-cols-1 gap-0 sm:grid-cols-[1fr_auto]">
      <div
        className="border-b-thick sm:border-b-0 sm:border-r-[5px] p-6"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="label-caps">Student</div>
        <div className="font-display mt-2 text-3xl leading-tight sm:text-4xl">
          {student.studentName}
        </div>
        <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-3 font-mono text-sm">
          <Row k="Roll No" v={student.rollNo} />
          <Row k="Batch" v={student.batch} />
          <Row k="Course" v={student.courseName} />
          <Row k="Branch" v={student.branchName} />
          <Row k="College" v={student.collegeName} />
          <Row k="College Code" v={student.collegeCode} />
          {student.leet && <Row k="Lateral Entry" v={student.leet} />}
        </dl>
      </div>
      <div className="flex items-start justify-end p-6">
        <button
          onClick={onReset}
          className="border-thick bg-background px-5 py-3 font-mono text-xs font-bold uppercase tracking-widest hover:bg-foreground hover:text-background"
        >
          ← New Lookup
        </button>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="label-caps text-muted-foreground">{k}</dt>
      <dd className="break-words">{v}</dd>
    </>
  );
}

function SubjectsTable({
  data,
  student,
  semId,
  session,
}: {
  data: SubjectsResponse;
  student: StudentDetails;
  semId: string;
  session: string;
}) {
  const upstreamSgpa = Number(data.sgpadetails.sgpa);
  const localSgpa = calculateSGPA(data.grades);
  const mismatch = Math.abs(upstreamSgpa - localSgpa) > 0.01;

  return (
    <div className="space-y-6">
      <div className="border-heavy bg-foreground text-background">
        <div className="grid gap-6 p-6 sm:grid-cols-[auto_1fr_auto] sm:items-end">
          <div>
            <div className="label-caps" style={{ color: "var(--color-background)", opacity: 0.7 }}>
              {student.rollNo} · {data.grades[0]?.semester ?? `Sem ${semId}`} · {session}
            </div>
            <div className="font-display mt-1 text-2xl">SGPA</div>
          </div>
          <div className="font-display text-6xl leading-none sm:text-8xl">
            {data.sgpadetails.sgpa}
          </div>
          <div className="font-mono text-sm">
            <div>
              Σ credits = <span className="font-bold">{data.sgpadetails.cretits}</span>
            </div>
            <div>
              Σ grade pts = <span className="font-bold">{data.sgpadetails.totalGradePoints}</span>
            </div>
            <div className="mt-2 opacity-70">Local recompute: {localSgpa.toFixed(2)}</div>
          </div>
        </div>
        <div
          className="border-t-thick bg-background p-4 text-foreground"
          style={{ borderColor: "var(--color-background)" }}
        >
          <BlockMath math={SGPA_FORMULA} />
          <div className="mt-1 font-mono text-xs text-muted-foreground">{SGPA_LEGEND}</div>
        </div>
        {mismatch && (
          <div
            className="border-t-thick p-4 font-mono text-xs"
            style={{ borderColor: "var(--color-background)" }}
          >
            ⚠ Upstream SGPA and local recompute disagree. Investigate upstream change.
          </div>
        )}
      </div>

      <div className="border-thick overflow-x-auto">
        <table className="w-full border-collapse font-mono text-sm">
          <thead className="bg-foreground text-background">
            <tr>
              <Th>Code</Th>
              <Th>Subject</Th>
              <Th className="text-center">T/P</Th>
              <Th className="text-right">Credits</Th>
              <Th className="text-center">Grade</Th>
              <Th className="text-right">Points</Th>
              <Th className="text-right">Credit Pts</Th>
            </tr>
          </thead>
          <tbody>
            {data.grades.map((g, i) => (
              <tr key={`${g.subjectCODE}-${i}`} className="border-t border-foreground">
                <Td className="whitespace-nowrap">{g.subjectCODE}</Td>
                <Td>{g.subjectName}</Td>
                <Td className="text-center">{g.subjectTP}</Td>
                <Td className="text-right">{g.subjectCredits}</Td>
                <Td className="text-center">
                  <span
                    className={`inline-block min-w-8 border-thick px-2 py-0.5 font-bold ${
                      g.grade === "F" || g.grade === "M" || g.grade === "S"
                        ? "bg-destructive text-destructive-foreground"
                        : "bg-background"
                    }`}
                  >
                    {g.grade}
                  </span>
                </Td>
                <Td className="text-right">{g.points}</Td>
                <Td className="text-right font-bold">{g.creditPoints}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`label-caps px-3 py-3 text-left ${className}`}
      style={{ color: "var(--color-background)" }}
    >
      {children}
    </th>
  );
}
function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2.5 align-top ${className}`}>{children}</td>;
}

function FooterNote() {
  return (
    <footer className="border-thick mt-16 p-5 font-mono text-xs leading-relaxed">
      <div className="mb-4">
        <a
          href="https://www.producthunt.com/products/bput-result-fetcher-sgpa-in-seconds?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-bput-result-fetcher-sgpa-in-seconds"
          target="_blank"
          rel="noopener noreferrer"
        >
          <img
            alt="BPUT Result Fetcher — SGPA in seconds - Live BPUT results, SGPA/CGPA, and PDF marksheets. No login. | Product Hunt"
            width="250"
            height="54"
            src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1196678&theme=dark&t=1784064523865"
          />
        </a>
      </div>
      Unofficial. This tool proxies public BPUT result endpoints server-side and displays what BPUT
      returns. No account, no DOB, no bulk lookups — one registration number per request, as typed.{" "}
      <Link to="/privacy" className="underline">
        Privacy &amp; FAQ
      </Link>
    </footer>
  );
}
