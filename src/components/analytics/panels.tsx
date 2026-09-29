// ─────────────────────────────────────────────────────────────────────────────
// Analysis panels — the quantitative half of the BPUT Results Intelligence
// dashboard. Every figure here is derived from the aggregate payload by
// `@/lib/analytics-stats`; no component invents a number, and each panel
// states the sample it rests on so a small n is never mistaken for a finding.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { AnalyticsPayload } from "@/lib/analytics-client";
import {
  branchStats,
  buildVolumeSeries,
  fmtCompact,
  fmtDayShort,
  fmtInt,
  fmtMs,
  fmtPct,
  fmtSignedPct,
  heatMatrix,
  latencyStats,
  outcomeStats,
  publicationMatrix,
  WEEKDAY_LABELS,
  wilson,
  yearVolume,
  type Interval,
} from "@/lib/analytics-stats";

export const ACCENT = "oklch(0.45 0.22 265)";
const FAIL = "oklch(0.58 0.24 27)";
const OK = "oklch(0.55 0.18 145)";
const WARN = "oklch(0.72 0.19 65)";

/* ───────────────────────────────────────────────────────────── primitives ── */

export function PanelCard({
  index,
  title,
  meta,
  children,
  className = "",
  style,
}: {
  index: string;
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <section className={`an-panel ${className}`} style={style}>
      <header className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <h4 className="label-caps flex items-center gap-2 font-bold">
          <span className="px-2 py-0.5 text-background" style={{ background: "var(--foreground)" }}>
            {index}
          </span>
          {title}
        </h4>
        {meta ? <span className="label-caps text-muted-foreground">{meta}</span> : null}
      </header>
      {children}
    </section>
  );
}

/** Count-up used for headline figures so a refresh reads as a change. */
function useCountUp(target: number, ms = 900) {
  const [n, setN] = useState(target);
  const from = useRef(target);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    const start = performance.now();
    const origin = from.current;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      setN(Math.round(origin + (target - origin) * eased));
      if (p < 1) raf.current = requestAnimationFrame(step);
      else from.current = target;
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [target, ms]);
  return n;
}

export function KpiTile({
  label,
  value,
  unit,
  sub,
  accent,
  sample,
}: {
  label: string;
  value: number;
  unit?: string;
  sub?: ReactNode;
  accent?: string;
  sample?: string;
}) {
  const n = useCountUp(value);
  return (
    <div className="border-thick p-4">
      <div className="label-caps text-muted-foreground">{label}</div>
      <div
        className="font-display mt-2 text-3xl leading-none tabular-nums"
        style={accent ? { color: accent } : undefined}
      >
        {fmtInt(n)}
        {unit ? <span className="ml-1 text-lg">{unit}</span> : null}
      </div>
      {sub ? <div className="mt-2 font-mono text-[11px] leading-tight">{sub}</div> : null}
      {sample ? <div className="label-caps mt-1 text-muted-foreground">{sample}</div> : null}
    </div>
  );
}

/** Point estimate with its 95% interval drawn as a range bar. */
export function IntervalBar({
  interval,
  format,
  accent = ACCENT,
}: {
  interval: Interval;
  format: (v: number) => string;
  accent?: string;
}) {
  const { p, low, high } = interval;
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 font-mono text-[11px] tabular-nums">{format(p)}</span>
      <span className="relative block h-3 min-w-16 flex-1 bg-muted">
        <span
          className="absolute top-1/2 h-[3px] -translate-y-1/2"
          style={{
            left: `${low * 100}%`,
            width: `${Math.max(0, high - low) * 100}%`,
            background: accent,
            opacity: 0.35,
          }}
        />
        <span
          className="absolute top-0 h-3 w-[3px]"
          style={{ left: `calc(${p * 100}% - 1.5px)`, background: accent }}
        />
      </span>
      <span className="w-28 shrink-0 text-right font-mono text-[10px] text-muted-foreground tabular-nums">
        {format(low)}–{format(high)}
      </span>
    </div>
  );
}

/** Row with a label, a 0–100% track, and a right-aligned readout. */
export function MeterRow({
  label,
  value,
  max,
  right,
  accent,
  title,
}: {
  label: string;
  value: number;
  max: number;
  right: ReactNode;
  accent?: string;
  title?: string;
}) {
  const width = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="an-branch-row" title={title}>
      <div className="mb-1 flex items-baseline justify-between gap-2 font-mono text-[11px]">
        <span className="truncate font-bold uppercase">{label}</span>
        <span className="shrink-0 tabular-nums">{right}</span>
      </div>
      <div className="relative h-3 w-full bg-muted">
        <div
          className="absolute inset-y-0 left-0 transition-all duration-700"
          style={{ width: `${width}%`, background: accent ?? "var(--foreground)" }}
        />
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────── volume & forecast ── */

interface TooltipInjected {
  active?: boolean;
  label?: string | number;
  payload?: Array<{
    dataKey?: string | number;
    value?: number | string | null;
    /** The datum itself, so a tooltip can read fields the chart does not plot. */
    payload?: Record<string, unknown>;
  }>;
}

function VolumeTooltip({ active, label, payload }: TooltipInjected) {
  if (!active || !payload || payload.length === 0) return null;
  const get = (key: string): number | null => {
    const hit = payload.find((p) => p.dataKey === key);
    const v = hit?.value;
    return typeof v === "number" ? v : null;
  };
  const observed = get("observed");
  const smoothed = get("smoothed");
  const trend = get("trend");
  const bandLow = get("bandLow");
  const bandWidth = get("bandWidth");
  const isForecast = observed === null;
  return (
    <div className="border-thick bg-background p-3 font-mono text-[11px] leading-relaxed">
      <div className="font-bold uppercase">{String(label)}</div>
      {observed !== null ? (
        <>
          <div>
            observed <span className="font-bold tabular-nums">{fmtInt(observed)}</span>
          </div>
          {smoothed !== null && (
            <div>
              7-sample EWMA <span className="tabular-nums">{smoothed.toFixed(1)}</span>
            </div>
          )}
        </>
      ) : (
        <div className="text-muted-foreground">forecast horizon</div>
      )}
      {trend !== null && (
        <div>
          fitted trend <span className="tabular-nums">{trend.toFixed(1)}</span>
        </div>
      )}
      {isForecast && bandLow !== null && bandWidth !== null && (
        <div>
          95% PI{" "}
          <span className="tabular-nums">
            {bandLow.toFixed(1)}–{(bandLow + bandWidth).toFixed(1)}
          </span>
        </div>
      )}
    </div>
  );
}

export function PanelGroup({ label, note }: { label: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b-2 border-foreground pb-2">
      <h3 className="label-caps font-bold">{label}</h3>
      {note ? <span className="label-caps text-muted-foreground">{note}</span> : null}
    </div>
  );
}

export type AcquisitionLink = "connecting" | "live" | "offline";

/** Which channel is feeding a panel. Stated, never implied. */
export function LinkChip({ link }: { link: AcquisitionLink }) {
  const text = link === "live" ? "Live push" : link === "connecting" ? "Connecting" : "Polling";
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

export function VolumePanel({ payload }: { payload: AnalyticsPayload }) {
  const series = useMemo(() => buildVolumeSeries(payload.observed.daily, 7), [payload]);

  const points = useMemo(
    () =>
      series.points.map((p) => ({
        ...p,
        anomalyPoint: p.anomaly ? p.observed : null,
      })),
    [series],
  );

  const hasData = series.points.some((p) => (p.observed ?? 0) > 0);
  const slopePerWeek = series.regression.slope * 7;

  return (
    <PanelCard
      index="04"
      title="Volume, trend & 7-day forecast"
      meta={`${series.points.length - 7} days observed · ${series.points.filter((p) => p.isForecast).length} forecast`}
      style={{ animationDelay: "80ms" }}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label="Last 7 days"
          value={series.last7}
          sub={
            series.wow === null ? (
              <span className="text-muted-foreground">no comparable prior week</span>
            ) : (
              <span style={{ color: series.wow >= 0 ? OK : FAIL }}>
                {fmtSignedPct(series.wow)} week over week
              </span>
            )
          }
          sample={`vs ${fmtInt(series.prev7)} prior 7d`}
        />
        <KpiTile
          label="Trend"
          value={Math.round(Math.abs(slopePerWeek) * 10) / 10}
          unit="req/wk"
          sub={
            <span className="text-muted-foreground">
              {slopePerWeek >= 0 ? "rising" : "falling"} · R² {series.regression.r2.toFixed(2)}
            </span>
          }
          sample={`OLS on ${series.regression.n} daily buckets`}
        />
        <KpiTile
          label="Next 7 days (fit)"
          value={Math.round(series.horizonTotal)}
          sub={
            <span className="text-muted-foreground">
              PI {Math.round(series.horizonLow)}–{Math.round(series.horizonHigh)}
            </span>
          }
          sample="OLS point forecast + 95% prediction interval"
        />
        <KpiTile
          label="Anomalous days"
          value={series.anomalyCount}
          sub={
            <span className="text-muted-foreground">
              {series.season ? `${series.season.toFixed(2)}× weekday effect` : "weekday effect n/a"}
            </span>
          }
          sample="robust z ≥ 2.5 (median/MAD)"
        />
      </div>

      <div className="border-thick mt-4 h-72 w-full bg-muted/30">
        {hasData ? (
          <ResponsiveContainer>
            <ComposedChart data={points} margin={{ top: 16, right: 16, left: 0, bottom: 8 }}>
              <defs>
                <linearGradient id="volFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={ACCENT} stopOpacity={0.32} />
                  <stop offset="100%" stopColor={ACCENT} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="2 4" strokeOpacity={0.3} vertical={false} />
              <XAxis
                dataKey="day"
                tickFormatter={fmtDayShort}
                tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
                interval={Math.max(0, Math.floor(points.length / 8) - 1)}
                axisLine={{ stroke: "currentColor" }}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
                tickFormatter={fmtCompact}
                axisLine={false}
                tickLine={false}
                width={38}
              />
              <Tooltip
                content={<VolumeTooltip />}
                cursor={{ stroke: "currentColor", strokeDasharray: "3 3" }}
              />
              {/* Fan chart: transparent base + visible width, stacked. */}
              <Area
                dataKey="bandLow"
                stackId="pi"
                stroke="none"
                fill="transparent"
                isAnimationActive={false}
              />
              <Area
                dataKey="bandWidth"
                stackId="pi"
                stroke="none"
                fill={ACCENT}
                fillOpacity={0.13}
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="observed"
                stroke={ACCENT}
                strokeWidth={2.5}
                fill="url(#volFill)"
                isAnimationActive={false}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="smoothed"
                stroke="var(--foreground)"
                strokeWidth={1.5}
                strokeDasharray="5 3"
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="linear"
                dataKey="trend"
                stroke="var(--muted-foreground)"
                strokeWidth={1.2}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                dataKey="anomalyPoint"
                stroke="none"
                isAnimationActive={false}
                dot={{ r: 4, fill: FAIL, stroke: "var(--background)", strokeWidth: 2 }}
                activeDot={false}
                connectNulls={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <EmptyPanel
            headline="No observations in the last 90 days"
            detail="Daily buckets are gap-filled server-side, so empty days are real zeros — not missing data. This chart fills as soon as results are fetched through the site."
          />
        )}
      </div>

      <div className="label-caps mt-2 flex flex-wrap justify-between gap-2 text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-4" style={{ background: ACCENT }} /> observed /day
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-[2px] w-4 bg-foreground" /> EWMA(0.3)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-[2px] w-4 bg-muted-foreground" /> OLS fit
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-4" style={{ background: FAIL }} /> anomaly
        </span>
        <span>shaded = 95% prediction interval</span>
      </div>
      {series.season ? (
        <p className="mt-2 font-mono text-[11px] text-muted-foreground">
          Weekday effect: {series.seasonLabel}. Counts are bucketed in UTC; the seasonality panel
          below is bucketed in IST.
        </p>
      ) : null}
    </PanelCard>
  );
}

/* ─────────────────────────────────────────────────────────────── outcomes ── */

const OUTCOME_LABEL: Record<string, string> = {
  published: "Published",
  not_published: "Not published",
  timeout: "Upstream timeout",
  rate_limited: "Rate limited",
  unreachable: "Upstream unreachable",
  malformed: "Malformed payload",
  upstream_error: "Upstream error",
  unclassified: "Unclassified (pre-v2)",
};

const OUTCOME_COLOR: Record<string, string> = {
  published: OK,
  not_published: "var(--muted-foreground)",
  timeout: WARN,
  rate_limited: WARN,
  unreachable: FAIL,
  malformed: FAIL,
  upstream_error: FAIL,
  unclassified: "var(--muted-foreground)",
};

export function OutcomePanel({ payload }: { payload: AnalyticsPayload }) {
  const stats = useMemo(() => outcomeStats(payload), [payload]);
  const max = stats.rows[0]?.count ?? 0;
  const failed = stats.rows
    .filter((r) => r.outcome !== "published" && r.outcome !== "not_published")
    .reduce((a, r) => a + r.count, 0);

  return (
    <PanelCard
      index="05"
      title="Outcome mix & success rate"
      meta={`n = ${fmtInt(stats.attempts)} primary attempts`}
      style={{ animationDelay: "140ms" }}
    >
      <div className="border-thick p-4">
        <div className="label-caps text-muted-foreground">Published rate · Wilson 95% CI</div>
        <div className="font-display mt-2 text-4xl leading-none tabular-nums" style={{ color: OK }}>
          {fmtPct(stats.success.p, 1)}
        </div>
        <div className="mt-3">
          <IntervalBar interval={stats.success} format={(v) => fmtPct(v, 0)} accent={OK} />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 font-mono text-[11px]">
          <div>
            <div className="label-caps text-muted-foreground">published</div>
            <div className="tabular-nums">{fmtInt(stats.published)}</div>
          </div>
          <div>
            <div className="label-caps text-muted-foreground">transport faults</div>
            <div className="tabular-nums" style={{ color: failed > 0 ? FAIL : undefined }}>
              {fmtInt(failed)}
            </div>
          </div>
          <div>
            <div className="label-caps text-muted-foreground">cache served</div>
            <div className="tabular-nums">{fmtPct(stats.cacheShare, 0)}</div>
          </div>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {stats.rows.length === 0 ? (
          <EmptyPanel
            headline="No classified outcomes yet"
            detail="Outcome taxonomy needs the v2 telemetry columns. Rows written before the migration are reported as unclassified rather than guessed."
          />
        ) : (
          stats.rows.map((r) => (
            <MeterRow
              key={r.outcome}
              label={OUTCOME_LABEL[r.outcome] ?? r.outcome}
              value={r.count}
              max={max}
              accent={OUTCOME_COLOR[r.outcome]}
              right={
                <>
                  {fmtInt(r.count)}{" "}
                  <span className="text-muted-foreground">({fmtPct(r.share, 1)})</span>
                </>
              }
            />
          ))
        )}
      </div>

      <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
        Every row is one upstream attempt. A semester is counted as a <em>published</em> primary
        only when BPUT returned subjects for its primary session, and the same semester is counted
        once in the rate above regardless of how many back-paper probes followed it.
      </p>
    </PanelCard>
  );
}

/* ──────────────────────────────────────────────────────────────── latency ── */

export function LatencyPanel({ payload }: { payload: AnalyticsPayload }) {
  const stats = useMemo(() => latencyStats(payload.observed.latency), [payload]);
  const scaleMax = Math.max(stats.max, 1);

  return (
    <PanelCard
      index="06"
      title="Upstream latency by semester"
      meta={`n = ${fmtInt(stats.n)} measured attempts`}
      style={{ animationDelay: "200ms" }}
    >
      <div className="grid grid-cols-3 gap-3">
        <div className="border-thick p-3">
          <div className="label-caps text-muted-foreground">p50</div>
          <div className="font-display mt-1 text-2xl tabular-nums">{fmtMs(stats.p50)}</div>
        </div>
        <div className="border-thick p-3">
          <div className="label-caps text-muted-foreground">p95</div>
          <div className="font-display mt-1 text-2xl tabular-nums" style={{ color: WARN }}>
            {fmtMs(stats.p95)}
          </div>
        </div>
        <div className="border-thick p-3">
          <div className="label-caps text-muted-foreground">tail ratio</div>
          <div className="font-display mt-1 text-2xl tabular-nums">
            {stats.spread > 0 ? `${stats.spread.toFixed(2)}×` : "—"}
          </div>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {stats.rows.length === 0 ? (
          <EmptyPanel
            headline="No latency samples yet"
            detail="Duration is measured end-to-end in the browser for every attempt, so this panel populates from the first lookup after the migration is applied."
          />
        ) : (
          stats.rows.map((r) => {
            const left = (r.p50 / scaleMax) * 100;
            const right = (r.p95 / scaleMax) * 100;
            const mx = (r.maxMs / scaleMax) * 100;
            return (
              <div key={r.semester} className="an-branch-row" title={`n=${r.n}`}>
                <div className="mb-1 flex items-baseline justify-between font-mono text-[11px]">
                  <span className="font-bold uppercase">Semester {r.semester}</span>
                  <span className="tabular-nums">
                    p50 {fmtMs(r.p50)}{" "}
                    <span className="text-muted-foreground">· p95 {fmtMs(r.p95)}</span>
                  </span>
                </div>
                <div className="relative h-4 w-full bg-muted">
                  <div
                    className="absolute inset-y-0"
                    style={{
                      left: `${left}%`,
                      width: `${Math.max(0.5, right - left)}%`,
                      background: WARN,
                      opacity: 0.5,
                    }}
                  />
                  <div
                    className="absolute top-0 h-4 w-[3px]"
                    style={{ left: `calc(${left}% - 1.5px)`, background: ACCENT }}
                  />
                  <div
                    className="absolute top-1/2 h-[3px] -translate-y-1/2"
                    style={{ left: `calc(${mx}% - 1.5px)`, background: FAIL }}
                    title={`max ${fmtMs(r.maxMs)}`}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>

      <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
        Bars run p50 → p95; the red tick marks the observed maximum, the blue tick the median. The
        tail ratio is p95 ÷ p50 — above ~3× the upstream is the bottleneck, not the network.
      </p>
    </PanelCard>
  );
}

/* ──────────────────────────────────────────────────────────── seasonality ── */

export function SeasonalityPanel({ payload }: { payload: AnalyticsPayload }) {
  const matrix = useMemo(() => heatMatrix(payload.observed.seasonality), [payload]);
  const max = useMemo(() => Math.max(1, ...matrix.flat()), [matrix]);
  const totals = useMemo(() => matrix.map((row) => row.reduce((a, b) => a + b, 0)), [matrix]);
  const peak = useMemo(() => {
    let best = { dow: 0, hour: 0, v: -1 };
    matrix.forEach((row, dow) =>
      row.forEach((v, hour) => {
        if (v > best.v) best = { dow, hour, v };
      }),
    );
    return best;
  }, [matrix]);
  const empty = max <= 1 && totals.every((t) => t === 0);

  return (
    <PanelCard
      index="07"
      title="When lookups happen · IST"
      meta="7 × 24 · all-time observed"
      style={{ animationDelay: "240ms" }}
    >
      {empty ? (
        <EmptyPanel
          headline="No time-of-day signal yet"
          detail="Once events span a few days this grid shows the real hourly rhythm of result checking in Indian local time."
        />
      ) : (
        <>
          <div className="overflow-x-auto">
            <div className="min-w-[560px]">
              <div className="mb-1 flex pl-10">
                {Array.from({ length: 24 }).map((_, h) => (
                  <span
                    key={h}
                    className="label-caps flex-1 text-center text-muted-foreground"
                    style={{ fontSize: 9 }}
                  >
                    {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
                  </span>
                ))}
              </div>
              {matrix.map((row, dow) => (
                <div key={dow} className="mb-0.5 flex items-center">
                  <span
                    className="label-caps w-10 shrink-0 text-muted-foreground"
                    style={{ fontSize: 10 }}
                  >
                    {WEEKDAY_LABELS[dow]}
                  </span>
                  {row.map((v, hour) => {
                    const t = max > 0 ? v / max : 0;
                    return (
                      <span
                        key={hour}
                        title={`${WEEKDAY_LABELS[dow]} ${String(hour).padStart(2, "0")}:00 IST · ${fmtInt(v)} requests`}
                        className="mr-0.5 h-5 flex-1 transition-transform duration-150 hover:scale-y-125"
                        style={{
                          background:
                            v === 0
                              ? "var(--muted)"
                              : `color-mix(in oklab, ${ACCENT} ${Math.max(12, Math.round(t * 100))}%, transparent)`,
                        }}
                      />
                    );
                  })}
                  <span className="ml-2 w-12 shrink-0 text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                    {fmtCompact(totals[dow])}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="label-caps mt-3 flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
            <span>
              Peak · {WEEKDAY_LABELS[peak.dow]} {String(peak.hour).padStart(2, "0")}:00 IST (
              {fmtInt(peak.v)})
            </span>
            <span className="flex items-center gap-1">
              low
              {[0.15, 0.35, 0.55, 0.75, 1].map((s) => (
                <span
                  key={s}
                  className="inline-block h-3 w-3"
                  style={{ background: `color-mix(in oklab, ${ACCENT} ${s * 100}%, transparent)` }}
                />
              ))}
              high
            </span>
          </div>
        </>
      )}
    </PanelCard>
  );
}

/* ─────────────────────────────────────────────────────── branch structure ── */

export function BranchPanel({ payload }: { payload: AnalyticsPayload }) {
  const stats = useMemo(() => branchStats(payload.observed.byBranch), [payload]);
  const max = stats.rows[0]?.count ?? 0;
  const lorenzPath = useMemo(() => {
    const pts = stats.lorenz
      .map((p) => `${(p.x * 100).toFixed(1)},${(100 - p.y * 100).toFixed(1)}`)
      .join(" ");
    return pts;
  }, [stats]);

  return (
    <PanelCard
      index="08"
      title="Branch structure & concentration"
      meta="k ≥ 25 anonymity floor"
      style={{ animationDelay: "300ms" }}
    >
      {stats.rows.length === 0 ? (
        <EmptyPanel
          headline="No branch buckets yet"
          detail="A branch appears only after at least 25 observations support it; smaller buckets stay pooled in Other."
        />
      ) : (
        <>
          <div className="space-y-3">
            {stats.rows.map((r) => (
              <div key={r.branch} className="an-branch-row">
                <div className="mb-1 flex items-baseline justify-between gap-2 font-mono text-[11px]">
                  <span className="truncate font-bold uppercase">{r.branch}</span>
                  <span className="shrink-0 tabular-nums">
                    {fmtPct(r.share, 1)}{" "}
                    <span className="text-muted-foreground">
                      ({fmtPct(r.ci.low, 0)}–{fmtPct(r.ci.high, 0)})
                    </span>
                  </span>
                </div>
                <div className="relative h-3 w-full bg-muted">
                  <div
                    className="absolute inset-y-0 left-0"
                    style={{ width: `${max > 0 ? (r.count / max) * 100 : 0}%`, background: ACCENT }}
                  />
                  <span
                    className="absolute top-1/2 h-[3px] w-[3px] -translate-y-1/2 -translate-x-1/2"
                    title={`95% CI ${fmtPct(r.ci.low, 1)}–${fmtPct(r.ci.high, 1)}`}
                    style={{ left: `${r.ci.low * 100}%`, background: "var(--foreground)" }}
                  />
                  <span
                    className="absolute top-1/2 h-[3px] w-[3px] -translate-y-1/2 -translate-x-1/2"
                    title={`95% CI ${fmtPct(r.ci.low, 1)}–${fmtPct(r.ci.high, 1)}`}
                    style={{ left: `${r.ci.high * 100}%`, background: "var(--foreground)" }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 grid grid-cols-3 gap-3">
            <div className="border-thick p-3">
              <div className="label-caps text-muted-foreground">HHI</div>
              <div className="font-display mt-1 text-xl tabular-nums">{stats.hhi.toFixed(3)}</div>
              <div className="font-mono text-[10px] text-muted-foreground">
                even mix = {(1 / Math.max(1, stats.rows.length)).toFixed(3)}
              </div>
            </div>
            <div className="border-thick p-3">
              <div className="label-caps text-muted-foreground">Gini</div>
              <div className="font-display mt-1 text-xl tabular-nums">{stats.gini.toFixed(3)}</div>
              <div className="font-mono text-[10px] text-muted-foreground">
                0 even → 1 one branch
              </div>
            </div>
            <div className="border-thick p-3">
              <div className="label-caps text-muted-foreground">Top 3 share</div>
              <div className="font-display mt-1 text-xl tabular-nums">
                {fmtPct(stats.top3Share, 0)}
              </div>
              <div className="font-mono text-[10px] text-muted-foreground">
                leader {stats.leader ? stats.leader.branch : "—"}
              </div>
            </div>
          </div>

          {stats.rows.length >= 3 ? (
            <div className="mt-4 flex items-center gap-4">
              <svg viewBox="0 0 100 100" className="h-28 w-28 shrink-0 border-thin">
                <line
                  x1="0"
                  y1="100"
                  x2="100"
                  y2="0"
                  stroke="currentColor"
                  strokeOpacity={0.25}
                  strokeDasharray="3 3"
                />
                <polyline
                  points={lorenzPath}
                  fill="none"
                  stroke={ACCENT}
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
                Lorenz curve of requests per branch against a perfectly even mix (dashed diagonal).
                The gap is the Gini coefficient above; with{" "}
                <span className="font-bold">{stats.rows.length}</span> visible buckets the sample is
                still small, so read the interval markers on each bar before reading the spread.
              </p>
            </div>
          ) : null}
        </>
      )}
    </PanelCard>
  );
}

/* ───────────────────────────────────────────────────── publication matrix ── */

export function PublicationPanel({ payload }: { payload: AnalyticsPayload }) {
  const matrix = useMemo(() => publicationMatrix(payload.observed.publication), [payload]);

  return (
    <PanelCard
      index="09"
      title="Publication matrix"
      meta={`${matrix.observed} year × semester cells observed`}
      style={{ animationDelay: "340ms" }}
    >
      {matrix.years.length === 0 ? (
        <EmptyPanel
          headline="No publication events recorded"
          detail="Every successful primary fetch is stamped with the moment that semester was first seen live, building a real publication timeline instead of a guess."
        />
      ) : (
        <>
          <div className="overflow-x-auto">
            <div className="min-w-[460px]">
              <div className="mb-1 flex pl-12">
                {Array.from({ length: 8 }).map((_, i) => (
                  <span
                    key={i}
                    className="label-caps flex-1 text-center text-muted-foreground"
                    style={{ fontSize: 10 }}
                  >
                    S{i + 1}
                  </span>
                ))}
              </div>
              {matrix.years.map((year, yi) => (
                <div key={year} className="mb-0.5 flex items-center">
                  <span
                    className="label-caps w-12 shrink-0 text-muted-foreground"
                    style={{ fontSize: 11 }}
                  >
                    {year}
                  </span>
                  {matrix.cells[yi].map((cell) => {
                    const t = matrix.max > 0 ? cell.count / matrix.max : 0;
                    return (
                      <span
                        key={cell.semester}
                        title={
                          cell.count > 0
                            ? `${year} · Sem ${cell.semester} · ${fmtInt(cell.count)} published fetches · first seen ${new Date(cell.firstSeenAt).toLocaleString("en-GB")}`
                            : `${year} · Sem ${cell.semester} · not observed`
                        }
                        className="mr-0.5 flex h-7 flex-1 items-center justify-center font-mono text-[10px] transition-transform duration-150 hover:scale-105"
                        style={{
                          background:
                            cell.count === 0
                              ? "var(--muted)"
                              : `color-mix(in oklab, ${OK} ${Math.max(18, Math.round(t * 100))}%, transparent)`,
                          color: t > 0.55 ? "var(--background)" : "var(--foreground)",
                        }}
                      >
                        {cell.count > 0 ? fmtCompact(cell.count) : ""}
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
            Green intensity is the number of successful fetches observed for that year/semester
            pair. Blank cells are genuinely unobserved — not zero traffic, and not a claim that BPUT
            has not published.
          </p>
        </>
      )}
    </PanelCard>
  );
}

/* ───────────────────────────────────────────────────── observed by year ── */

export function YearPanel({ payload }: { payload: AnalyticsPayload }) {
  const rows = useMemo(() => yearVolume(payload), [payload]);
  const max = useMemo(() => Math.max(1, ...rows.map((r) => r.observed)), [rows]);
  const observedYears = rows.filter((r) => r.observed > 0);

  return (
    <PanelCard
      index="10"
      title="Observed volume by batch year"
      meta={`${observedYears.length} years observed`}
      style={{ animationDelay: "380ms" }}
    >
      {rows.length === 0 ? (
        <EmptyPanel
          headline="No year-level data yet"
          detail="Results are attributed to the student's batch year, so this panel fills as soon as any lookup completes."
        />
      ) : (
        <>
          <div className="border-thick p-4">
            <div className="space-y-3">
              {rows.map((r) => (
                <div key={r.year} className="grid grid-cols-[2.5rem_1fr_7.5rem] items-center gap-2">
                  <span className="label-caps text-muted-foreground">{r.year}</span>
                  <span className="relative block h-2 bg-muted">
                    <span
                      className="absolute inset-y-0 left-0"
                      style={{ width: `${(r.observed / max) * 100}%`, background: ACCENT }}
                      title={`${fmtInt(r.observed)} lookups`}
                    />
                  </span>
                  <span className="text-right font-mono text-[10px] tabular-nums">
                    {fmtInt(r.observed)}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="label-caps mt-2 flex flex-wrap gap-4 text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-4" style={{ background: ACCENT }} /> observed
            </span>
          </div>
          <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
            Every bar is a lookup this deployment actually served. Nothing modelled or seeded is
            plotted anywhere on this page, so an empty year means no traffic rather than missing
            data.
          </p>
        </>
      )}
    </PanelCard>
  );
}

/* ──────────────────────────────────────────────────────── semester funnel ── */

export function FunnelPanel({ payload }: { payload: AnalyticsPayload }) {
  const rows = payload.observed.funnel;
  const totalAttempts = rows.reduce((n, r) => n + r.attempts, 0);
  const max = Math.max(1, ...rows.map((r) => r.attempts));
  const successCi = useMemo(() => outcomeStats(payload).success, [payload]);

  return (
    <PanelCard
      index="11"
      title="Semester coverage"
      meta={totalAttempts > 0 ? "primary attempts only" : "awaiting primaries"}
      style={{ animationDelay: "420ms" }}
    >
      {totalAttempts === 0 ? (
        <EmptyPanel
          headline="No primary attempt recorded yet"
          detail="Coverage counts the first session tried for each semester, so it needs lookups served after the v2 migration. Rows already in the table were written before outcome and attempt index existed, and carry no semester coverage to draw — an empty panel here means no eligible attempts, not a broken read."
        />
      ) : (
        <>
          <div className="border-thick">
            {rows.map((r) => {
              const ci = wilson(r.published, r.attempts);
              return (
                <div
                  key={r.semester}
                  className="grid grid-cols-[2.5rem_1fr_auto] items-center gap-2 border-b border-foreground px-3 py-2 last:border-b-0"
                >
                  <span className="label-caps font-bold tabular-nums">S{r.semester}</span>
                  <span
                    className="relative block h-2 min-w-0 bg-muted"
                    title={`${fmtInt(r.attempts)} primary attempts for semester ${r.semester}`}
                  >
                    <span
                      className="absolute inset-y-0 left-0"
                      style={{ width: `${(r.attempts / max) * 100}%`, background: ACCENT }}
                    />
                  </span>
                  <span className="text-right font-mono text-[10px] whitespace-nowrap tabular-nums">
                    {r.attempts === 0 ? "—" : `${fmtPct(ci.p, 0)} · ${fmtInt(r.attempts)}`}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-4" style={{ background: ACCENT }} /> primary
              attempts
            </span>
            <span>
              published overall {fmtPct(successCi.p, 0)} · Wilson 95% {fmtPct(successCi.low, 0)}–
              {fmtPct(successCi.high, 0)}
            </span>
          </div>
        </>
      )}
    </PanelCard>
  );
}

/* ────────────────────────────────────────────────────────── definitions ──── */

export function DefinitionsPanel({ payload }: { payload: AnalyticsPayload }) {
  const rows: Array<[string, string, string]> = [
    [
      "Event",
      "One upstream attempt: a semester's primary session, or one back-paper re-publication probe.",
      `${fmtInt(payload.counts.eventsTotal)} recorded`,
    ],
    [
      "Primary attempt",
      "The first session tried for a semester — exactly one per semester per lookup.",
      `${fmtInt(payload.counts.primaries)} recorded`,
    ],
    [
      "Published rate",
      "Published primary attempts ÷ all primary attempts, with a Wilson 95% interval.",
      "panel 05",
    ],
    [
      "Probe",
      "A later session probed only after the primary published, looking for a republication.",
      `${fmtInt(payload.counts.probes)} recorded`,
    ],
    [
      "Cache-served",
      "Served from the browser's local cache, so no upstream call was made and latency is not meaningful.",
      `${fmtInt(payload.counts.cacheHits)} recorded`,
    ],
    [
      "p50 / p95",
      "Percentile of measured end-to-end duration across attempts with a sample.",
      "panel 06",
    ],
    [
      "Trend & forecast",
      "Ordinary least squares on the 90-day daily series, with a 95% prediction interval — not a confidence interval on the mean.",
      "panel 04",
    ],
    ["Anomaly", "Robust z-score (median/MAD) ≥ 2.5 on the daily series.", "panel 04"],
    [
      "HHI / Gini",
      "Concentration of requests across visible branch buckets; a description of this sample, not of the university.",
      "panel 08",
    ],
    [
      "k ≥ 25",
      "A branch bucket is published only when at least 25 observations support it; smaller buckets pool into Other.",
      "panels 08, 06",
    ],
    [
      "Measured intake",
      "The highest live registration number in each college-and-year range, probed block by block rather than sampled; students remove the measured hole rate.",
      "panel 01",
    ],
    [
      "Hole",
      "A registration number below a college's maximum that answers for nobody — a dropout, a transfer or a withdrawn record.",
      "panel 01",
    ],
    [
      "Theil–Sen slope",
      "Median of all pairwise slopes, shown beside OLS because one real trough year moves a least-squares line further than it should.",
      "panel 01",
    ],
    [
      "Gini / top decile",
      "Concentration of intake across the 1,103 measured colleges — a description of the university's numbering, not of its admissions policy.",
      "panel 02",
    ],
    [
      "Probe coverage",
      "Numbers probed so far ÷ the 160,609 numbers the grid declares. The denominator was measured, which is the only reason a percentage is meaningful.",
      "panel 03",
    ],
    [
      "Reads left (est.)",
      "Nine reads per student plus one probe per number, summed over the per-block means and minus the reads already spent. An estimate, and labelled as one.",
      "panel 03",
    ],
    [
      "Schema",
      "v2 telemetry: outcome, latency, attempt index, source and subject counts are fields this deployment records itself. No modelled or seeded series is plotted anywhere.",
      payload.meta.schema,
    ],
  ];

  return (
    <details className="border-thick mt-8 p-4">
      <summary className="label-caps cursor-pointer font-bold">
        Metric definitions, units and known limitations
      </summary>
      <table className="mt-4 w-full border-collapse font-mono text-[11px]">
        <thead>
          <tr className="bg-foreground text-background">
            <th className="label-caps px-3 py-2 text-left" style={{ color: "var(--background)" }}>
              Metric
            </th>
            <th className="label-caps px-3 py-2 text-left" style={{ color: "var(--background)" }}>
              Definition
            </th>
            <th className="label-caps px-3 py-2 text-left" style={{ color: "var(--background)" }}>
              Present
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v, p]) => (
            <tr key={k} className="border-t border-foreground align-top">
              <td className="px-3 py-2 font-bold">{k}</td>
              <td className="px-3 py-2">{v}</td>
              <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{p}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="mt-4 list-disc space-y-1 pl-5 font-mono text-[11px] text-muted-foreground">
        <li>
          Daily buckets are UTC; the seasonality grid is IST (UTC+5:30) because that is when BPUT
          students are awake. The two are deliberately different and each panel says which is in
          use.
        </li>
        <li>
          Latency is measured in the browser and therefore includes the visitor's own network — it
          is a user-perceived figure, not an upstream-only measurement.
        </li>
        <li>
          Panels 01–03 describe the university and come from the census measurement; panels 04–11
          describe this deployment&apos;s own traffic. The two are never blended, and each panel
          states which it is.
        </li>
        <li>
          Intake is the portal&apos;s numbering standing in for cohort size. It is an upper bound:
          it counts records the portal still serves rather than students who ever enrolled, and
          older batches have had a decade in which to change.
        </li>
        <li>
          Counts describe activity on this site. They are not enrolment numbers, pass rates, or any
          statement about BPUT's own data.
        </li>
      </ul>
    </details>
  );
}

/* ─────────────────────────────────────────────────────────── empty state ── */

export function EmptyPanel({ headline, detail }: { headline: string; detail: string }) {
  return (
    <div className="border-thin flex h-full min-h-24 flex-col justify-center gap-1 bg-muted/40 p-4">
      <div className="label-caps font-bold">{headline}</div>
      <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">{detail}</p>
    </div>
  );
}
