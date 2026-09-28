// BPUT population census — the one part of the analytics surface that describes
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
import { useQuery } from "@tanstack/react-query";
import { fetchCensus, type CensusPayload, type CensusProgress } from "@/lib/census-client";
import { fmtAgo, fmtInt, fmtPct, wilson } from "@/lib/analytics-stats";

const ACCENT = "oklch(0.45 0.22 265)";
const OK = "oklch(0.55 0.18 145)";

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

function ProgressLine({ progress }: { progress: CensusProgress }) {
  return (
    <div className="border-thick flex flex-wrap items-center gap-x-6 gap-y-2 p-3 font-mono text-[11px]">
      <span
        className="label-caps inline-flex items-center gap-2"
        style={{ color: progress.active ? OK : "var(--muted-foreground)" }}
      >
        <span className="relative inline-flex h-2.5 w-2.5">
          {progress.active ? (
            <span
              className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
              style={{ background: OK }}
            />
          ) : null}
          <span
            className="relative inline-flex h-2.5 w-2.5"
            style={{ background: progress.active ? OK : "var(--muted-foreground)" }}
          />
        </span>
        {progress.active ? "Census running" : "Census idle"}
      </span>
      <span>
        <span className="text-muted-foreground">numbers probed</span> {fmtInt(progress.visited)}
      </span>
      <span>
        <span className="text-muted-foreground">unused</span> {fmtInt(progress.notFound)}
      </span>
      <span>
        <span className="text-muted-foreground">stored</span> {fmtInt(progress.observations)}
      </span>
      <span>
        <span className="text-muted-foreground">ranges</span> {fmtInt(progress.ranges)} ·{" "}
        {fmtInt(progress.doneRanges)} complete
      </span>
      {progress.updatedAt ? (
        <span className="text-muted-foreground">
          persisted <Age iso={progress.updatedAt} />
        </span>
      ) : null}
    </div>
  );
}

export function BputCensus() {
  const q = useQuery({
    queryKey: ["bput-census"],
    queryFn: fetchCensus,
    retry: 1,
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

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
            {observations > 0 ? "anonymous observations" : "collecting"}
          </div>
          <div className="font-display mt-1 text-3xl tabular-nums">{fmtInt(observations)}</div>
        </div>
      </div>

      <p className="mt-4 max-w-3xl font-mono text-[11px] leading-relaxed text-muted-foreground">
        Collected by walking registration-number ranges on the university&apos;s public result
        portal at a pace it can sustain. Each student is reduced to batch year, semester, branch,
        college, outcome and totals; the registration number is never stored, so a row here is an
        observation and not a person. Cells below {data.meta.kAnonymity} observations are pooled or
        withheld.
      </p>

      <div className="mt-6 space-y-6">
        <ProgressLine progress={data.progress} />

        {observations === 0 ? (
          <div className="border-thick p-6">
            <div className="label-caps" style={{ color: "oklch(0.72 0.19 65)" }}>
              Cohort
            </div>
            <h3 className="font-display mt-2 text-2xl">
              The crawl has started but stored nothing.
            </h3>
            <p className="mt-3 max-w-3xl font-mono text-xs leading-relaxed">
              Numbers have been probed, so the ranges are being read — but no student record has
              come back yet. Panels appear the moment the first observation is written; nothing is
              filled in ahead of that.
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
                      : "—",
                },
              ].map((k) => (
                <div key={k.label} className="border-thick p-4">
                  <div className="label-caps text-muted-foreground">{k.label}</div>
                  <div className="font-display mt-1 text-2xl tabular-nums">{k.value}</div>
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
                              ? "—"
                              : `${fmtPct(ci.p, 0)} [${fmtPct(ci.low, 0)}–${fmtPct(ci.high, 0)}]`
                          }
                          title={`${fmtInt(r.published)} of ${fmtInt(r.observations)} published`}
                        />
                      );
                    })}
                  </div>
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
                        No grade rows yet — they appear with the first published semester.
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
            </div>
          </>
        )}
      </div>
    </section>
  );
}
