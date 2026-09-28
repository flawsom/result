// ─────────────────────────────────────────────────────────────────────────────
// Analytics statistics — pure functions, zero side effects, no dependencies.
//
// Why this file exists: the dashboard must never show a number it cannot
// defend. The Postgres layer returns only raw aggregates; every derived
// quantity (confidence intervals, trend, forecast band, concentration
// indices, anomaly flags) is computed here so there is exactly one
// implementation of each estimator and it can be read, tested and audited
// in isolation.
//
// Conventions
//  * A "sample" is a plain number[]. Empty input never throws — estimators
//    return NaN-free sentinels (0 / null) so the UI can branch cleanly.
//  * Intervals are two-sided at 95% unless a z is passed explicitly.
//  * Nothing here knows about React, the network, or the database.
// ─────────────────────────────────────────────────────────────────────────────

import type { AnalyticsPayload, Outcome } from "@/lib/analytics-client";

/** Two-sided 95% normal quantile. */
export const Z_95 = 1.959963984540054;

/** Guards every divisor in this module. */
const EPS = 1e-12;

export interface Interval {
  /** Point estimate. */
  p: number;
  /** Lower bound (never below 0). */
  low: number;
  /** Upper bound (never above 1 for proportions). */
  high: number;
  /** Sample size the estimate was computed from. */
  n: number;
}

export interface Regression {
  slope: number;
  intercept: number;
  /** Coefficient of determination, 0–1. */
  r2: number;
  /** Standard error of the regression (residual standard deviation). */
  se: number;
  n: number;
  /** Predict the fitted value at an arbitrary x. */
  predict: (x: number) => number;
}

export interface ForecastPoint {
  /** Fitted point estimate at x. */
  y: number;
  /** Lower edge of the 95% prediction interval. */
  low: number;
  /** Upper edge of the 95% prediction interval. */
  high: number;
}

export interface Distribution {
  n: number;
  sum: number;
  mean: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  /** Sample standard deviation (n−1). 0 when n < 2. */
  sd: number;
}

/* ────────────────────────────────────────────── descriptive statistics ─── */

export function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) if (Number.isFinite(x)) s += x;
  return s;
}

export function mean(xs: readonly number[]): number {
  const n = xs.length;
  return n === 0 ? 0 : sum(xs) / n;
}

/** Sample standard deviation (Bessel-corrected). Returns 0 for n < 2. */
export function sampleStdDev(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) acc += (x - m) * (x - m);
  return Math.sqrt(acc / (n - 1));
}

/**
 * Quantile of an ALREADY SORTED ascending array using linear interpolation
 * between order statistics (the "type 7" definition used by R and NumPy).
 * q = 0 → minimum, q = 1 → maximum.
 */
export function quantileSorted(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const clamped = Math.min(1, Math.max(0, q));
  const pos = (n - 1) * clamped;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const w = pos - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

/** Quantile of an arbitrary array (copies + sorts; O(n log n)). */
export function quantile(xs: readonly number[], q: number): number {
  return quantileSorted(
    [...xs].sort((a, b) => a - b),
    q,
  );
}

export function median(xs: readonly number[]): number {
  return quantile(xs, 0.5);
}

/** Full five-number summary plus mean and sample SD. */
export function describe(xs: readonly number[]): Distribution {
  const clean = xs.filter((x) => Number.isFinite(x));
  const n = clean.length;
  if (n === 0) {
    return { n: 0, sum: 0, mean: 0, min: 0, p25: 0, median: 0, p75: 0, max: 0, sd: 0 };
  }
  const sorted = [...clean].sort((a, b) => a - b);
  return {
    n,
    sum: sum(clean),
    mean: mean(clean),
    min: sorted[0],
    p25: quantileSorted(sorted, 0.25),
    median: quantileSorted(sorted, 0.5),
    p75: quantileSorted(sorted, 0.75),
    max: sorted[n - 1],
    sd: sampleStdDev(clean),
  };
}

/* ─────────────────────────────────────────────── proportion intervals ─── */

/**
 * Wilson score interval — the correct interval for a binomial proportion at
 * small n, where the textbook normal ("Wald") interval collapses to zero
 * width at p̂ = 0 or 1 and can extend outside [0, 1]. We use it for every
 * percentage shown next to a count so a reader can tell a real 96% from a
 * 96% that is three observations wide.
 */
export function wilson(successes: number, n: number, z: number = Z_95): Interval {
  if (n <= 0) return { p: 0, low: 0, high: 1, n: 0 };
  const p = Math.min(1, Math.max(0, successes / n));
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    p,
    low: Math.max(0, centre - half),
    high: Math.min(1, centre + half),
    n,
  };
}

/* ──────────────────────────────────────────── trend, smoothing, season ─── */

/** Ordinary least squares with an explicit r² and residual standard error. */
export function linearRegression(xs: readonly number[], ys: readonly number[]): Regression {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) {
    const fallback = n === 1 ? ys[0] : 0;
    return {
      slope: 0,
      intercept: fallback,
      r2: 0,
      se: 0,
      n,
      predict: () => fallback,
    };
  }
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i] - my);
  }
  const slope = sxx < EPS ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  const predict = (x: number) => intercept + slope * x;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const resid = ys[i] - predict(xs[i]);
    ssRes += resid * resid;
    ssTot += (ys[i] - my) * (ys[i] - my);
  }
  const dof = n - 2;
  return {
    slope,
    intercept,
    r2: ssTot < EPS ? 1 : Math.max(0, 1 - ssRes / ssTot),
    se: dof > 0 ? Math.sqrt(ssRes / dof) : 0,
    n,
    predict,
  };
}

/**
 * Point forecast at `xNext` with a 95% **prediction** interval (not a
 * confidence interval on the mean line): it widens with distance from the
 * centre of mass of the observed x's, which is the honest way to show an
 * extrapolation. Counts are clamped at zero.
 */
export function forecast(
  xs: readonly number[],
  ys: readonly number[],
  xNext: number,
  z: number = Z_95,
): ForecastPoint {
  const reg = linearRegression(xs, ys);
  const y = reg.predict(xNext);
  const n = reg.n;
  if (n < 3) return { y: Math.max(0, y), low: Math.max(0, y), high: Math.max(0, y) };

  const mx = mean(xs);
  let sxx = 0;
  for (let i = 0; i < n; i++) sxx += (xs[i] - mx) * (xs[i] - mx);
  const leverage = sxx < EPS ? 0 : 1 + 1 / n + ((xNext - mx) * (xNext - mx)) / sxx;
  const margin = z * reg.se * Math.sqrt(leverage);
  return {
    y: Math.max(0, y),
    low: Math.max(0, y - margin),
    high: Math.max(0, y + margin),
  };
}

/**
 * Exponentially weighted moving average. alpha = smoothing factor
 * (0.05 slow … 0.5 fast); 0.35 tracks week-to-week movement without
 * chasing single-day spikes.
 */
export function ewma(values: readonly number[], alpha = 0.35): number[] {
  const out: number[] = [];
  let prev = 0;
  values.forEach((v, i) => {
    prev = i === 0 ? v : alpha * v + (1 - alpha) * prev;
    out.push(prev);
  });
  return out;
}

/**
 * Median-absolute-deviation z-scores. The standard z-score is computed with
 * the mean and SD, both of which are themselves dragged around by the very
 * outliers we are trying to detect. MAD is robust: a single 10× spike does
 * not hide the next one. Falls back to 0 for flat series.
 */
export function robustZScores(values: readonly number[]): number[] {
  const n = values.length;
  if (n < 3) return values.map(() => 0);
  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med)));
  // 1.4826 makes MAD a consistent estimator of σ for normal data.
  const scale = mad * 1.4826;
  if (scale < EPS) return values.map(() => 0);
  return values.map((v) => (v - med) / scale);
}

/** Indices whose robust z-score exceeds `threshold` in absolute value. */
export function anomalyIndices(values: readonly number[], threshold = 2.5): number[] {
  const z = robustZScores(values);
  const out: number[] = [];
  z.forEach((v, i) => {
    if (Math.abs(v) >= threshold) out.push(i);
  });
  return out;
}

/* ─────────────────────────────────────────────────── concentration ─────── */

/**
 * Gini coefficient (0 = every branch identical, →1 = all volume in one).
 * Reported as a property of the observed mix, not as a judgement.
 */
export function gini(values: readonly number[]): number {
  const xs = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  const n = xs.length;
  const total = sum(xs);
  if (n < 2 || total < EPS) return 0;
  let acc = 0;
  for (let i = 0; i < n; i++) acc += (2 * (i + 1) - n - 1) * xs[i];
  return Math.min(1, Math.max(0, acc / (n * total)));
}

/** Herfindahl–Hirschman index on shares (0–1). 1/k means perfectly even. */
export function hhi(shares: readonly number[]): number {
  const s = sum(shares);
  if (s < EPS) return 0;
  return shares.reduce((acc, v) => acc + (v / s) * (v / s), 0);
}

/**
 * Lorenz curve points (cumulative share of population vs cumulative share of
 * volume), each axis in [0, 1]. Starts at the origin, ends at (1, 1).
 */
export function lorenz(values: readonly number[]): Array<{ x: number; y: number }> {
  const xs = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  const total = sum(xs);
  const n = xs.length;
  if (n === 0 || total < EPS)
    return [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
  const pts: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
  let acc = 0;
  xs.forEach((v, i) => {
    acc += v;
    pts.push({ x: (i + 1) / n, y: acc / total });
  });
  return pts;
}

/* ────────────────────────────────────────────────────────── formatting ─── */

export const fmtInt = (n: number): string => Math.round(n).toLocaleString("en-US");

export const fmtCompact = (n: number): string => {
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${(n / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`;
  if (a >= 1_000) return `${(n / 1_000).toFixed(a >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
};

/** Signed percentage with a fixed precision, e.g. "+12.4%". */
export const fmtSignedPct = (v: number, digits = 1): string =>
  `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}%`;

export const fmtPct = (v: number, digits = 1): string => `${(v * 100).toFixed(digits)}%`;

export const fmtMs = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;

/** Short, unambiguous day label for chart axes: "28 Sep". */
export function fmtDayShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

/** Relative freshness, e.g. "12s ago", "4m ago", "3h ago". */
export function fmtAgo(from: string | number | null | undefined, nowMs = Date.now()): string {
  if (from === null || from === undefined) return "never";
  const t = typeof from === "number" ? from : new Date(from).getTime();
  if (Number.isNaN(t)) return "unknown";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/* ─────────────────────────────────────────────────────── time bucketing ── */

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * IST (UTC+5:30) weekday/hour bucketing. BPUT is an Indian university and
 * every meaningful seasonal pattern (publication bursts, evening lookups)
 * is Indian local time, so the heatmap is anchored there rather than in the
 * viewer's timezone. Keeps the picture identical for every visitor.
 */
export function istBucket(iso: string): { dow: number; hour: number } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { dow: 0, hour: 0 };
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return { dow: ist.getUTCDay(), hour: ist.getUTCHours() };
}

/** Index a sparse [{dow, hour, count}] series into a 7×24 matrix. */
export function heatMatrix(rows: Array<{ dow: number; hour: number; count: number }>): number[][] {
  const m: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const r of rows) {
    const dow = ((r.dow % 7) + 7) % 7;
    const hour = ((r.hour % 24) + 24) % 24;
    m[dow][hour] += Number(r.count) || 0;
  }
  return m;
}

/** Percent change between two non-negative counts; null when undefined. */
export function pctChange(prev: number, next: number): number | null {
  if (!Number.isFinite(prev) || !Number.isFinite(next) || prev <= 0) return null;
  return ((next - prev) / prev) * 100;
}

/**
 * Compound annual growth rate over `years` periods between two counts.
 * Returns null rather than ±Infinity when either endpoint is unusable.
 */
export function cagr(first: number, last: number, years: number): number | null {
  if (first <= 0 || last <= 0 || years <= 0) return null;
  return (Math.pow(last / first, 1 / years) - 1) * 100;
}

/* ────────────────────────────────── dashboard derivations ──────────────── */
// Payload → chart-ready structures. Kept here rather than inside the React
// components so the numbers behind every panel can be inspected without
// rendering anything, and so no estimate is ever derived twice.

export interface VolumePoint {
  day: string;
  observed: number | null;
  smoothed: number | null;
  trend: number;
  bandLow: number | null;
  bandWidth: number | null;
  isForecast: boolean;
  anomaly: boolean;
}

export interface VolumeSeries {
  points: VolumePoint[];
  last7: number;
  prev7: number;
  wow: number | null;
  horizonTotal: number;
  horizonLow: number;
  horizonHigh: number;
  regression: Regression;
  season: number | null;
  seasonLabel: string;
  anomalyCount: number;
  truncated: boolean;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Build the daily volume series with smoothing, a fitted trend, a fan-chart
 * prediction band over the next `horizon` days, and robust-z anomaly flags.
 *
 * An unadjusted trend line would read a weekday/weekend mix as growth, so the
 * same window also yields an explicit day-of-week effect (busiest vs quietest
 * weekday, in requests/day).
 */
export function buildVolumeSeries(
  daily: Array<{ day: string; total: number; published: number }>,
  horizon = 7,
): VolumeSeries {
  const clean = daily.filter((d) => Number.isFinite(d.total));
  const totals = clean.map((d) => d.total);
  const idx = totals.map((_, i) => i);
  const regression = linearRegression(idx, totals);
  const smoothed = ewma(totals, 0.3);
  const z = robustZScores(totals);

  const points: VolumePoint[] = clean.map((d, i) => ({
    day: d.day,
    observed: d.total,
    smoothed: smoothed[i],
    trend: Math.max(0, regression.predict(i)),
    bandLow: null,
    bandWidth: null,
    isForecast: false,
    anomaly: Math.abs(z[i]) >= 2.5 && totals.length >= 10 && d.total > 0,
  }));

  // Fan chart: a prediction interval is only meaningful where we extrapolate,
  // so it is drawn from the last observation forward.
  const last = clean[clean.length - 1];
  let horizonTotal = 0;
  let horizonLow = 0;
  let horizonHigh = 0;
  if (last && totals.length >= 3) {
    for (let h = 1; h <= horizon; h++) {
      const f = forecast(idx, totals, totals.length - 1 + h);
      horizonTotal += f.y;
      horizonLow += f.low;
      horizonHigh += f.high;
      points.push({
        day: addDays(last.day, h),
        observed: null,
        smoothed: null,
        trend: f.y,
        bandLow: f.low,
        bandWidth: Math.max(0, f.high - f.low),
        isForecast: true,
        anomaly: false,
      });
    }
  }

  const tail = clean.slice(-14);
  const last7 = tail.slice(-7).reduce((a, d) => a + d.total, 0);
  const prev7 = tail.slice(0, 7).reduce((a, d) => a + d.total, 0);

  let season: number | null = null;
  let seasonLabel = "insufficient data";
  if (clean.length >= 14) {
    const byDow = new Map<number, number[]>();
    for (const d of clean) {
      const wd = new Date(`${d.day}T00:00:00Z`).getUTCDay();
      const bucket = byDow.get(wd) ?? [];
      bucket.push(d.total);
      byDow.set(wd, bucket);
    }
    const avgs = [...byDow.entries()]
      .map(([wd, xs]) => ({ wd, avg: mean(xs) }))
      .sort((a, b) => b.avg - a.avg);
    if (avgs.length >= 5 && avgs[avgs.length - 1].avg > 0) {
      const busy = avgs[0];
      const quiet = avgs[avgs.length - 1];
      season = busy.avg / quiet.avg;
      seasonLabel = `${WEEKDAY_LABELS[busy.wd]} ${busy.avg.toFixed(1)}/day vs ${WEEKDAY_LABELS[quiet.wd]} ${quiet.avg.toFixed(1)}/day`;
    }
  }

  return {
    points,
    last7,
    prev7,
    wow: pctChange(prev7, last7),
    horizonTotal,
    horizonLow,
    horizonHigh,
    regression,
    season,
    seasonLabel,
    anomalyCount: points.filter((p) => p.anomaly).length,
    truncated: clean.length < 14,
  };
}

export interface OutcomeRow {
  outcome: Outcome;
  count: number;
  share: number;
}

export interface OutcomeStats {
  rows: OutcomeRow[];
  attempts: number;
  published: number;
  success: Interval;
  cacheShare: number;
  dominant: OutcomeRow | null;
}

/** Success rate with a Wilson interval over *primary* attempts only. */
export function outcomeStats(payload: AnalyticsPayload): OutcomeStats {
  const rows: OutcomeRow[] = [...payload.observed.byOutcome]
    .map((r) => ({ outcome: r.outcome, count: r.count, share: 0 }))
    .sort((a, b) => b.count - a.count);
  const attempts = rows.reduce((a, r) => a + r.count, 0) || 1;
  for (const r of rows) r.share = r.count / attempts;

  const funnelAttempts = payload.observed.funnel.reduce((a, f) => a + f.attempts, 0);
  const published = payload.observed.funnel.reduce((a, f) => a + f.published, 0);
  const denom = funnelAttempts || attempts;
  const numer = funnelAttempts
    ? published
    : (rows.find((r) => r.outcome === "published")?.count ?? 0);

  return {
    rows,
    attempts: denom,
    published: numer,
    success: wilson(numer, denom),
    cacheShare: payload.counts.eventsTotal
      ? payload.counts.cacheHits / payload.counts.eventsTotal
      : 0,
    dominant: rows[0] ?? null,
  };
}

export interface BranchRow {
  branch: string;
  count: number;
  share: number;
  ci: Interval;
}

export interface BranchStats {
  rows: BranchRow[];
  total: number;
  hhi: number;
  gini: number;
  lorenz: Array<{ x: number; y: number }>;
  leader: BranchRow | null;
  /** Share held by the top three branches — the practical concentration readout. */
  top3Share: number;
}

/** Branch mix with per-branch Wilson intervals on the observed share. */
export function branchStats(byBranch: Array<{ branch: string; count: number }>): BranchStats {
  const total = byBranch.reduce((a, r) => a + r.count, 0);
  const rows: BranchRow[] = [...byBranch]
    .sort((a, b) => b.count - a.count)
    .map((r) => ({
      branch: r.branch,
      count: r.count,
      share: total ? r.count / total : 0,
      ci: wilson(r.count, total),
    }));
  return {
    rows,
    total,
    hhi: hhi(rows.map((r) => r.count)),
    gini: gini(rows.map((r) => r.count)),
    lorenz: lorenz(rows.map((r) => r.count)),
    leader: rows[0] ?? null,
    top3Share: rows.slice(0, 3).reduce((a, r) => a + r.share, 0),
  };
}

export interface LatencyStats {
  rows: Array<{ semester: number; p50: number; p95: number; maxMs: number; n: number }>;
  p50: number;
  p95: number;
  max: number;
  n: number;
  /** p95/p50 — how heavy the tail is relative to the typical request. */
  spread: number;
}

/** Roll up per-semester percentiles into a single service-level readout. */
export function latencyStats(
  rows: Array<{ semester: number; p50: number; p95: number; maxMs: number; n: number }>,
): LatencyStats {
  const sorted = [...rows].sort((a, b) => a.semester - b.semester);
  const n = sorted.reduce((a, r) => a + r.n, 0);
  const weighted = (key: "p50" | "p95") =>
    n > 0 ? sorted.reduce((a, r) => a + r[key] * r.n, 0) / n : 0;
  const p50 = weighted("p50");
  const p95 = weighted("p95");
  return {
    rows: sorted,
    p50,
    p95,
    max: sorted.reduce((a, r) => Math.max(a, r.maxMs), 0),
    n,
    spread: p50 > 0 ? p95 / p50 : 0,
  };
}

export interface PublicationCell {
  year: number;
  semester: number;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Dense year × semester matrix of *observed* published results. */
export function publicationMatrix(rows: AnalyticsPayload["observed"]["publication"]): {
  years: number[];
  cells: PublicationCell[][];
  max: number;
  observed: number;
} {
  const years = [...new Set(rows.map((r) => r.year))].sort((a, b) => a - b);
  const cells: PublicationCell[][] = years.map(() => []);
  let max = 0;
  for (let yi = 0; yi < years.length; yi++) {
    for (let sem = 1; sem <= 8; sem++) {
      const hit = rows.find((r) => r.year === years[yi] && r.semester === sem);
      const cell: PublicationCell = hit
        ? {
            year: years[yi],
            semester: sem,
            count: hit.count,
            firstSeenAt: hit.firstSeenAt,
            lastSeenAt: hit.lastSeenAt,
          }
        : { year: years[yi], semester: sem, count: 0, firstSeenAt: "", lastSeenAt: "" };
      cells[yi].push(cell);
      if (cell.count > max) max = cell.count;
    }
  }
  return { years, cells, max, observed: rows.length };
}

export interface YearRow {
  year: number;
  observed: number;
}

/**
 * Observed lookups by batch year. Only measured traffic reaches this function —
 * there is no modelled series to blend in, so a year with no lookups is absent
 * rather than filled with a reference number.
 */
export function yearVolume(payload: AnalyticsPayload): YearRow[] {
  return payload.observed.byYear
    .map((r) => ({ year: r.year, observed: r.count }))
    .sort((a, b) => a.year - b.year);
}
