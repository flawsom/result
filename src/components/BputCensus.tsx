// BPUT population census, the one part of the analytics surface that describes
// the university rather than this website's own visitors.
//
// Everything here comes from the paced census: anonymous student-semester
// observations collected from the university's public result portal. The
// database exposes only cells of at least 25 observations, so no figure on this
// page can describe an individual student.
//
// The section renders nothing until the census has recorded something. An empty
// frame here would be decoration; a census is either running or it is not, and
// the progress line says which.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchCensus,
  subscribeCensusLive,
  type CensusLiveCounters,
  type CensusPayload,
  type CensusProgress,
} from "@/lib/census-client";
import { MEASURED_BLOCKS, MEASURED_SERIALS, MEASURED_STUDENTS } from "@/lib/census-blocks";
import { SESSION_WATCH, SESSION_WATCH_CHECKED_AT } from "@/lib/census-session-watch";
import { fmtAgo, fmtInt, fmtPct, wilson } from "@/lib/analytics-stats";
import { figureStyle } from "@/components/analytics/figure";

const ACCENT = "oklch(0.45 0.22 265)";
const OK = "oklch(0.55 0.18 145)";
const WARN = "oklch(0.72 0.19 65)";

type LinkState = "connecting" | "live" | "offline";

/** A burst of inserts from one crawl flush collapses into a single re-read. */
const COALESCE_MS = 1_500;
/** Push working: a slow reconciliation read is all that is needed. */
const POLL_LIVE_MS = 60_000;
/** Push unavailable: poll often enough that the panels never lag the crawl. */
const POLL_OFFLINE_MS = 15_000;

/**
 * `[3, 4, 5, 6, 7, 8]` → `3–8`; `[7, 8]` → `7, 8`. Runs of three or more collapse,
 * because a reader wants the shape of the window, not its members.
 */
function compressSemesters(semesters: readonly number[]): string {
  const runs: number[][] = [];
  for (const semester of [...semesters].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && semester === last[last.length - 1] + 1) last.push(semester);
    else runs.push([semester]);
  }
  return runs
    .map((run) => (run.length >= 3 ? `${run[0]}–${run[run.length - 1]}` : run.join(", ")))
    .join(", ");
}

/**
 * The daily session watch as one sentence.
 *
 * Batch years that the portal serves the same way collapse into a single clause,
 * so the sentence keeps saying something as cohorts age out and new sessions are
 * declared, rather than growing a line per year.
 */
function describeSessionWatch(): string {
  const groups: Array<{ years: number[]; served: readonly number[] }> = [];
  for (const [year, served] of Object.entries(SESSION_WATCH).sort(
    (a, b) => Number(a[0]) - Number(b[0]),
  )) {
    const last = groups[groups.length - 1];
    if (last && last.served.join() === served.join()) last.years.push(Number(year));
    else groups.push({ years: [Number(year)], served });
  }
  return groups
    .map((group) => {
      const { years } = group;
      const span =
        years.length > 2 ? `${years[0]}–${years[years.length - 1]}` : years.join(" and ");
      return `${span} for S${compressSemesters(group.served)}`;
    })
    .join(", ");
}

/** Ticks once a second so "persisted" never reads as frozen. */
function Age({ iso }: { iso: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  return <>{fmtAgo(iso, now)}</>;
}

function Bar({
  label,
  value,
  max,
  right,
  title,
  color = ACCENT,
}: {
  label: string;
  value: number;
  max: number;
  right: string;
  title?: string;
  color?: string;
}) {
  return (
    <div className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-2">
      <span className="label-caps truncate text-muted-foreground" title={label}>
        {label}
      </span>
      <span className="relative block h-2 min-w-0 bg-muted" title={title}>
        <span
          className="absolute inset-y-0 left-0"
          style={{ width: `${max > 0 ? (value / max) * 100 : 0}%`, background: color }}
        />
      </span>
      <span className="text-right font-mono text-[10px] tabular-nums whitespace-nowrap">
        {right}
      </span>
    </div>
  );
}

function Block({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <section>
      <header className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <h3 className="label-caps font-bold">{title}</h3>
        {meta ? <span className="label-caps text-muted-foreground">{meta}</span> : null}
      </header>
      {children}
    </section>
  );
}

/** Which channel is actually feeding this section, stated, not implied. */
function LinkChip({ link }: { link: LinkState }) {
  const text =
    link === "live" ? "Live push" : link === "connecting" ? "Connecting" : "Polling · 15s";
  const color = link === "live" ? OK : link === "connecting" ? "var(--muted-foreground)" : WARN;
  return (
    <span className="label-caps inline-flex items-center gap-2" style={{ color }}>
      <span className="relative inline-flex h-2 w-2">
        {link === "live" ? (
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
            style={{ background: OK }}
          />
        ) : null}
        <span className="relative inline-flex h-2 w-2" style={{ background: color }} />
      </span>
      {text}
    </span>
  );
}

function ProgressLine({
  progress,
  live,
  link,
}: {
  progress: CensusProgress;
  live: CensusLiveCounters | null;
  link: LinkState;
}) {
  // The broadcast row is fresher than the last aggregate read: the database
  // writes it in the same transaction that stored the batch, so it cannot lag
  // behind the crawl the way a polled snapshot can.
  const observations = live?.observations ?? progress.observations;
  const visited = live?.visited ?? progress.visited;
  const notFound = live?.not_found ?? progress.notFound;
  const ranges = live?.ranges ?? progress.ranges;
  const lastBatchAt = live?.last_batch_at ?? progress.lastBatchAt ?? null;
  const active = progress.active || (live?.active ?? false);
  const perProbe = visited > 0 ? observations / visited : 0;

  return (
    <div className="border-thick flex flex-wrap items-center gap-x-6 gap-y-2 p-3 font-mono text-[11px]">
      <span
        className="label-caps inline-flex items-center gap-2"
        style={{ color: active ? OK : "var(--muted-foreground)" }}
      >
        <span className="relative inline-flex h-2.5 w-2.5">
          {active ? (
            <span
              className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
              style={{ background: OK }}
            />
          ) : null}
          <span
            className="relative inline-flex h-2.5 w-2.5"
            style={{ background: active ? OK : "var(--muted-foreground)" }}
          />
        </span>
        {active ? "Census running" : "Census idle"}
      </span>
      <LinkChip link={link} />
      <span>
        <span className="text-muted-foreground">numbers probed</span> {fmtInt(visited)}
      </span>
      <span>
        <span className="text-muted-foreground">unused</span> {fmtInt(notFound)}
      </span>
      <span>
        <span className="text-muted-foreground">stored</span> {fmtInt(observations)}
      </span>
      <span>
        <span className="text-muted-foreground">obs / probed</span> {perProbe.toFixed(1)}
      </span>
      <span>
        <span className="text-muted-foreground">ranges completed</span>{" "}
        {fmtInt(progress.doneRanges)}/{fmtInt(MEASURED_BLOCKS)} · {fmtInt(ranges)} read
      </span>
      {lastBatchAt ? (
        <span className="text-muted-foreground">
          last batch <Age iso={lastBatchAt} />
        </span>
      ) : progress.updatedAt ? (
        <span className="text-muted-foreground">
          persisted <Age iso={progress.updatedAt} />
        </span>
      ) : null}
    </div>
  );
}

export function BputCensus() {
  const queryClient = useQueryClient();
  const [live, setLive] = useState<CensusLiveCounters | null>(null);
  const [link, setLink] = useState<LinkState>("connecting");

  const q = useQuery({
    queryKey: ["bput-census"],
    queryFn: fetchCensus,
    retry: 1,
    staleTime: 10_000,
    // Push is the channel; polling is only the safety net. The interval is
    // deliberately loose while the channel is healthy and tight when it is not.
    refetchInterval: link === "live" ? POLL_LIVE_MS : POLL_OFFLINE_MS,
    refetchIntervalInBackground: false,
  });

  // Subscribe before the first read completes: the point of the counter is to
  // move the moment a crawl flush commits, including while the initial
  // aggregate is still in flight.
  useEffect(() => {
    let timer: number | null = null;
    const subscription = subscribeCensusLive((row) => {
      setLive(row);
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        void queryClient.invalidateQueries({ queryKey: ["bput-census"] });
      }, COALESCE_MS);
    }, setLink);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      subscription.close();
    };
  }, [queryClient]);

  const data: CensusPayload | undefined = q.data;
  const observations = data?.meta.observations ?? 0;
  const visited = data?.progress.visited ?? 0;

  const maxYear = useMemo(
    () => Math.max(1, ...(data?.byYear ?? []).map((r) => r.observations)),
    [data],
  );
  const maxSem = useMemo(
    () => Math.max(1, ...(data?.bySemester ?? []).map((r) => r.observations)),
    [data],
  );
  const branches = useMemo(() => (data?.byBranch ?? []).slice(0, 8), [data]);
  const maxBranch = useMemo(() => Math.max(1, ...branches.map((r) => r.observations)), [branches]);
  const grades = useMemo(() => data?.grades ?? [], [data]);
  const maxGrade = useMemo(() => Math.max(1, ...grades.map((g) => g.n)), [grades]);
  const semLoad = useMemo(() => data?.bySemester ?? [], [data]);
  const branchYear = useMemo(() => data?.branchYear ?? [], [data]);
  const k = data?.meta.kAnonymity ?? 25;

  // Coverage is drawn from branch × year cells, but only from cells that already
  // clear the published anonymity threshold. The aggregate returns those raw, so
  // the suppression has to happen here or a single-student cell would be drawn.
  const coverage = useMemo(() => {
    const rows = new Map<string, Map<number, number>>();
    const years = new Set<number>();
    let max = 1;
    for (const r of branchYear) {
      if (r.observations < k) continue;
      let cells = rows.get(r.branch);
      if (!cells) {
        cells = new Map<number, number>();
        rows.set(r.branch, cells);
      }
      cells.set(r.batchYear, r.observations);
      years.add(r.batchYear);
      max = Math.max(max, r.observations);
    }
    const list = [...rows.entries()]
      .map(([branch, cells]) => ({
        branch,
        cells,
        total: [...cells.values()].reduce((n, v) => n + v, 0),
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);
    return { years: [...years].sort(), rows: list, max };
  }, [branchYear, k]);

  // Silent while loading or unreadable: this section is additive, and a failed
  // read here must never become a broken promise on the landing page.
  if (q.isLoading || q.isError || !data) return null;
  if (observations === 0 && visited === 0) return null;

  return (
    <section aria-labelledby="census-heading" className="mt-20">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b-4 border-foreground pb-6">
        <div>
          <div className="label-caps text-muted-foreground">
            University census // Aggregate only
          </div>
          <h2 id="census-heading" className="mt-2">
            BPUT POPULATION
            <br />
            CENSUS.
          </h2>
        </div>
        <div className="text-right">
          <div className="label-caps text-muted-foreground">
            {observations > 0 ? "anonymous student-semester observations" : "collecting"}
          </div>
          <div className="font-display mt-1 text-3xl tabular-nums">
            {fmtInt(live?.observations ?? observations)}
          </div>
        </div>
      </div>

      <p className="mt-4 max-w-3xl font-mono text-[11px] leading-relaxed text-muted-foreground">
        Collected by walking registration-number ranges on the university&apos;s public result
        portal at a pace it can sustain. Each student is reduced to batch year, semester, branch,
        college, outcome and totals; the registration number is never stored, so a row here is an
        observation and not a person. Cells below {data.meta.kAnonymity} observations are pooled or
        withheld.
      </p>

      <p className="mt-2 max-w-3xl font-mono text-[11px] leading-relaxed text-muted-foreground">
        The {fmtInt(MEASURED_BLOCKS)} college-and-year ranges below were measured, not guessed:
        every one was probed for its last live registration number, and they hold{" "}
        {fmtInt(MEASURED_SERIALS)} numbers across roughly {fmtInt(MEASURED_STUDENTS)} students. A
        block is complete when its serials have been read end to end, holes and all.
      </p>

      <div className="mt-6 space-y-6">
        <ProgressLine progress={data.progress} live={live} link={link} />

        {observations === 0 ? (
          <div className="border-thick p-6">
            <div className="label-caps" style={{ color: "oklch(0.72 0.19 65)" }}>
              Cohort
            </div>
            <h3 className="font-display mt-2 text-2xl">
              The crawl has started but stored nothing.
            </h3>
            <p className="mt-3 max-w-3xl font-mono text-xs leading-relaxed">
              Numbers have been probed, so the ranges are being read, but no student record has come
              back yet. Panels appear the moment the first observation is written; nothing is filled
              in ahead of that.
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {[
                { label: "Batch years", value: fmtInt(data.meta.batchYears) },
                { label: "Branches", value: fmtInt(data.meta.branches) },
                { label: "Colleges", value: fmtInt(data.meta.colleges) },
                {
                  label: "Year span",
                  value:
                    data.meta.minBatchYear && data.meta.maxBatchYear
                      ? `${data.meta.minBatchYear}–${data.meta.maxBatchYear}`
                      : "–",
                },
              ].map((k) => (
                <div key={k.label} className="@container border-thick min-w-0 overflow-hidden p-4">
                  <div className="label-micro text-muted-foreground">{k.label}</div>
                  {/* Sized from the tile: "2012–2025" is the widest of these and
                      a two-up row on a phone leaves it ~123px. */}
                  <div
                    className="font-display mt-1 leading-none tabular-nums break-words"
                    style={figureStyle(k.value.length, 1.9)}
                  >
                    {k.value}
                  </div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-12">
              <div className="md:col-span-6">
                <Block title="Coverage by batch year" meta={`${data.byYear.length} years`}>
                  <div className="border-thick space-y-3 p-4">
                    {data.byYear.map((r) => (
                      <Bar
                        key={r.batchYear}
                        label={String(r.batchYear)}
                        value={r.observations}
                        max={maxYear}
                        right={`${fmtInt(r.observations)} · ${fmtPct(
                          r.observations > 0 ? r.published / r.observations : 0,
                          0,
                        )} pub`}
                        title={`${fmtInt(r.observations)} observations, ${fmtInt(r.published)} published`}
                      />
                    ))}
                  </div>
                </Block>
              </div>

              <div className="md:col-span-6">
                <Block title="Publication by semester" meta="Wilson 95%">
                  <div className="border-thick space-y-3 p-4">
                    {data.bySemester.map((r) => {
                      const ci = wilson(r.published, r.observations);
                      return (
                        <Bar
                          key={r.semester}
                          label={`Sem ${r.semester}`}
                          value={r.observations}
                          max={maxSem}
                          right={
                            r.observations === 0
                              ? "–"
                              : `${fmtPct(ci.p, 0)} [${fmtPct(ci.low, 0)}–${fmtPct(ci.high, 0)}]`
                          }
                          title={`${fmtInt(r.published)} of ${fmtInt(r.observations)} published`}
                        />
                      );
                    })}
                  </div>
                  {/*
                    An early semester reading near 0% looks like a failed read and is not
                    one: the portal stops serving old sessions. The sentence below is
                    generated from the daily session watch rather than written by hand,
                    because it is a statement about today, see
                    `src/lib/census-session-watch.ts`.
                  */}
                  <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    An early semester near 0% here is usually the portal having aged that session
                    out, not a failed read. An automated check asks the portal for all eight derived
                    sessions of one student in every batch year; on {SESSION_WATCH_CHECKED_AT} it
                    answered {describeSessionWatch()}. Nothing in the numbering derivation is wrong:
                    the university keeps a rolling window of what it serves, and a session appears
                    only once its exams have been held, which is why the newest batches are still
                    partway down the list.
                  </p>
                </Block>
              </div>

              <div className="md:col-span-6">
                <Block
                  title="Branch mix"
                  meta={`k ≥ ${data.meta.kAnonymity} · pooled bands shown as Other`}
                >
                  <div className="border-thick space-y-3 p-4">
                    {branches.map((r) => (
                      <Bar
                        key={r.branch}
                        label={r.branch}
                        value={r.observations}
                        max={maxBranch}
                        right={`${fmtInt(r.observations)} · ${fmtPct(
                          r.observations > 0 ? r.published / r.observations : 0,
                          0,
                        )} pub`}
                        title={`${fmtInt(r.observations)} observations, ${fmtInt(r.published)} published`}
                      />
                    ))}
                  </div>
                </Block>
              </div>

              <div className="md:col-span-6">
                <Block title="Grade distribution" meta="all grade rows recorded">
                  <div className="border-thick space-y-3 p-4">
                    {grades.length === 0 ? (
                      <p className="font-mono text-[11px] text-muted-foreground">
                        No grade rows yet; they appear with the first published semester.
                      </p>
                    ) : (
                      grades.map((g) => (
                        <Bar
                          key={g.grade}
                          label={g.grade}
                          value={g.n}
                          max={maxGrade}
                          right={fmtInt(g.n)}
                          title={`${fmtInt(g.n)} grade rows`}
                        />
                      ))
                    )}
                  </div>
                </Block>
              </div>

              <div className="md:col-span-6">
                <Block title="Semester load" meta="median of published semesters">
                  <div className="border-thick space-y-3 p-4">
                    {semLoad.every((r) => r.published === 0) ? (
                      <p className="font-mono text-[11px] text-muted-foreground">
                        No published semester yet. Subject and grade-point medians appear with the
                        first one, and carry no figure until then.
                      </p>
                    ) : (
                      semLoad.map((r) => (
                        <Bar
                          key={r.semester}
                          label={`Sem ${r.semester}`}
                          value={r.published}
                          max={maxSem}
                          right={
                            r.published === 0
                              ? "–"
                              : `${Math.round(Number(r.subjectsP50 ?? 0))} subj · ${Math.round(
                                  Number(r.pointsP50 ?? 0),
                                )} pts`
                          }
                          title={
                            r.published === 0
                              ? `Semester ${r.semester}: nothing published yet`
                              : `Median over ${fmtInt(r.published)} published semesters: ${Math.round(
                                  Number(r.subjectsP50 ?? 0),
                                )} subjects, ${Math.round(Number(r.pointsP50 ?? 0))} grade points`
                          }
                        />
                      ))
                    )}
                  </div>
                </Block>
              </div>

              <div className="md:col-span-6">
                <Block title="Coverage matrix" meta={`cells under ${k} withheld`}>
                  <div className="border-thick p-4">
                    {coverage.rows.length === 0 ? (
                      <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
                        Every branch-and-year cell is still below {k} observations. A cell that
                        small would describe a handful of students, so the census shows the gap
                        rather than the number, and fills this in as the crawl deepens.
                      </p>
                    ) : (
                      <>
                        <div className="mb-1 flex gap-0.5 pl-20">
                          {coverage.years.map((y) => (
                            <span
                              key={y}
                              className="label-caps flex-1 text-center text-muted-foreground"
                              style={{ fontSize: 9 }}
                            >
                              {String(y).slice(2)}
                            </span>
                          ))}
                        </div>
                        {coverage.rows.map((row) => (
                          <div key={row.branch} className="mb-0.5 flex items-center gap-0.5">
                            <span
                              className="label-caps w-20 shrink-0 truncate text-muted-foreground"
                              style={{ fontSize: 9 }}
                              title={row.branch}
                            >
                              {row.branch.replace(/^B\.Tech\.\((.*)\)$/, "$1")}
                            </span>
                            {coverage.years.map((y) => {
                              const n = row.cells.get(y) ?? 0;
                              const t = n === 0 ? 0 : Math.min(1, n / coverage.max);
                              return (
                                <span
                                  key={y}
                                  className="h-6 flex-1"
                                  title={
                                    n === 0
                                      ? `${row.branch} · ${y}: under ${k} observations`
                                      : `${row.branch} · ${y}: ${fmtInt(n)} observations`
                                  }
                                  style={{
                                    background:
                                      n === 0
                                        ? "repeating-linear-gradient(45deg, var(--muted) 0 3px, transparent 3px 6px)"
                                        : `color-mix(in oklab, ${ACCENT} ${Math.max(
                                            20,
                                            Math.round(t * 100),
                                          )}%, transparent)`,
                                  }}
                                />
                              );
                            })}
                          </div>
                        ))}
                        <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                          Hatched cells hold fewer than {k} observations and are withheld rather
                          than drawn. A thin column here is the census being young, not a branch
                          that does not exist.
                        </p>
                      </>
                    )}
                  </div>
                </Block>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
