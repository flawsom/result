// Home-screen "BPUT Results Intelligence" section — data-science styled.
// Aggregates only. Never renders individual student data.
// - Server function applies k=25 anonymity for branch buckets.
// - Lazy-mounted so the hero search box is interactive first.
// - Mouse-reactive: spotlight follows the cursor over the main chart,
//   subtle parallax on annotations, staggered draw-in on sparklines,
//   ripple hover on branch lollipops.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fetchAnalytics, type AnalyticsPayload } from "@/lib/analytics-client";

const ACCENT = "oklch(0.45 0.22 265)"; // indigo, harmonises with --link

/* ------------------------------------------------------------------ hooks */

function useCountUp(target: number, ms = 1400) {
  const [n, setN] = useState(0);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    const start = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      setN(Math.round(target * eased));
      if (p < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [target, ms]);
  return n;
}

// Mouse spotlight. Writes CSS vars --mx/--my (0-100%) + --active (0/1)
// onto the referenced element. Uses rAF throttling so scroll+move stays smooth.
function useMouseSpotlight<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    let lastX = 50;
    let lastY = 50;
    const apply = () => {
      el.style.setProperty("--mx", `${lastX}%`);
      el.style.setProperty("--my", `${lastY}%`);
      raf = 0;
    };
    const onMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      lastX = ((e.clientX - rect.left) / rect.width) * 100;
      lastY = ((e.clientY - rect.top) / rect.height) * 100;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const onEnter = () => el.style.setProperty("--active", "1");
    const onLeave = () => {
      el.style.setProperty("--active", "0");
      lastX = 50;
      lastY = 50;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerenter", onEnter);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerenter", onEnter);
      el.removeEventListener("pointerleave", onLeave);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return ref;
}

// Fires `true` once the element scrolls into view. Used to gate draw-in
// animations so charts animate exactly when the user first sees them.
function useInView<T extends HTMLElement>(threshold = 0.15) {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          if (e.isIntersecting) {
            setSeen(true);
            io.disconnect();
            break;
          }
      },
      { threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, threshold]);
  return { ref, seen };
}

/* --------------------------------------------------------------- utilities */

const fmt = (n: number) => n.toLocaleString();
const fmtCompact = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);

function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse bg-muted ${className}`} aria-hidden />;
}

function LoadingState() {
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-12">
      <Skeleton className="h-40 md:col-span-8" />
      <Skeleton className="h-40 md:col-span-4" />
      <Skeleton className="h-72 md:col-span-8" />
      <Skeleton className="h-72 md:col-span-4" />
      <Skeleton className="h-40 md:col-span-12" />
    </div>
  );
}

/* ------------------------------------------------------ scoped animations */

const SCOPED_STYLES = `
  @keyframes an-rise {
    from { opacity: 0; transform: translateY(14px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes an-draw {
    from { stroke-dashoffset: var(--dash, 400); }
    to   { stroke-dashoffset: 0; }
  }
  @keyframes an-flash {
    0%   { background: color-mix(in oklab, ${ACCENT} 22%, transparent); }
    100% { background: transparent; }
  }
  @keyframes an-pulse-dot {
    0%, 100% { transform: scale(1); }
    50%      { transform: scale(1.35); }
  }
  .an-panel { animation: an-rise .55s cubic-bezier(.2,.7,.2,1) both; }
  .an-spot {
    position: absolute; inset: 0; pointer-events: none;
    background: radial-gradient(
      260px 260px at var(--mx, 50%) var(--my, 50%),
      color-mix(in oklab, ${ACCENT} 22%, transparent) 0%,
      transparent 70%
    );
    opacity: calc(var(--active, 0) * 1);
    transition: opacity .3s ease;
    mix-blend-mode: multiply;
  }
  .an-grid-overlay {
    position: absolute; inset: 0; pointer-events: none;
    background-image:
      linear-gradient(to right, color-mix(in oklab, currentColor 6%, transparent) 1px, transparent 1px),
      linear-gradient(to bottom, color-mix(in oklab, currentColor 6%, transparent) 1px, transparent 1px);
    background-size: 40px 40px;
    mask-image: radial-gradient(
      180px 180px at var(--mx, 50%) var(--my, 50%),
      black 0%, transparent 75%
    );
    opacity: calc(var(--active, 0) * 1);
    transition: opacity .3s ease;
  }
  .an-parallax {
    transform: translate(
      calc((var(--mx, 50%) - 50%) * 0.05),
      calc((var(--my, 50%) - 50%) * 0.05)
    );
    transition: transform .18s cubic-bezier(.2,.7,.2,1);
  }
  .an-sparkline path.an-line {
    stroke-dasharray: var(--dash, 260);
    animation: an-draw 1.2s cubic-bezier(.65,0,.35,1) both;
  }
  .an-sparkline path.an-fill {
    opacity: 0;
    animation: an-fade-in .8s .5s ease forwards;
  }
  @keyframes an-fade-in { to { opacity: 1; } }
  .an-branch-row {
    position: relative;
    padding: 6px 8px;
    margin: -6px -8px;
    transition: background .2s ease;
  }
  .an-branch-row:hover { background: color-mix(in oklab, ${ACCENT} 8%, transparent); }
  .an-branch-dot {
    transition: transform .25s cubic-bezier(.2,.7,.2,1), box-shadow .25s ease;
  }
  .an-branch-row:hover .an-branch-dot {
    transform: translateX(-6px) scale(1.7);
    box-shadow: 0 0 0 4px color-mix(in oklab, ${ACCENT} 22%, transparent);
  }
  .an-branch-bar { transition: filter .2s ease; }
  .an-branch-row:hover .an-branch-bar { filter: drop-shadow(0 0 6px ${ACCENT}); }
  .an-year-btn {
    transition: transform .18s cubic-bezier(.2,.7,.2,1), background .18s ease, color .18s ease;
  }
  .an-year-btn:hover { transform: translateY(-2px); }
  .an-flash { animation: an-flash 1.2s ease-out; }
  .an-pulse-dot { animation: an-pulse-dot 1.6s ease-in-out infinite; transform-origin: center; }
`;

/* -------------------------------------------------------------- component */

export function HomeAnalytics() {
  const q = useQuery({
    queryKey: ["home-analytics"],
    queryFn: fetchAnalytics,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  return (
    <section aria-labelledby="analytics-heading" className="mt-20">
      <style>{SCOPED_STYLES}</style>
      <div className="flex flex-wrap items-end justify-between gap-4 border-b-4 border-foreground pb-6">
        <div>
          <div className="label-caps text-muted-foreground">
            System diagnostics // Analytics engine
          </div>
          <h2 id="analytics-heading" className="mt-2">
            BPUT RESULTS
            <br />
            INTELLIGENCE.
          </h2>
        </div>
        <div className="text-right">
          <div className="label-caps flex items-center justify-end gap-2 text-muted-foreground">
            <span className="relative inline-flex h-2.5 w-2.5">
              <span
                className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
                style={{ background: "oklch(0.65 0.18 145)" }}
              />
              <span
                className="relative inline-flex h-2.5 w-2.5 rounded-full"
                style={{ background: "oklch(0.55 0.18 145)" }}
              />
            </span>
            Live stream
          </div>
          <div className="label-caps mt-1 text-muted-foreground">Auto-refresh · 30s</div>
        </div>
      </div>

      <p className="mt-6 max-w-2xl text-sm text-muted-foreground">
        A live, aggregate view of results checked through this site. Only counts by year, semester,
        and branch are stored — never roll numbers, names, grades, or any identifying detail.
        Branches with fewer than 25 records are folded into <em>Other</em>.
      </p>

      <div className="mt-8">
        {q.isPending ? (
          <LoadingState />
        ) : q.isError ? (
          <div className="border-thick p-6 font-mono text-sm">
            Analytics unavailable. {(q.error as Error).message}
          </div>
        ) : q.data ? (
          <AnalyticsBody data={q.data} />
        ) : null}
      </div>

      <div className="mt-10 border-thick p-4 font-mono text-xs leading-relaxed">
        <span className="label-caps">Privacy note</span>
        <span className="ml-3">
          We only ever store anonymous per-branch/per-semester counters. No registration numbers, no
          names, no grades, no IPs are kept for these charts. Cohorts under 25 records are always
          merged into <em>Other</em>.
        </span>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- body */

function AnalyticsBody({ data }: { data: AnalyticsPayload }) {
  const total = useCountUp(data.total);
  const [selectedYear, setSelectedYear] = useState<number | null>(null);

  const yearRows = useMemo(() => [...data.byYear].sort((a, b) => a.year - b.year), [data.byYear]);

  const peak = useMemo(() => {
    if (!yearRows.length) return null;
    return yearRows.reduce((a, b) => (b.count > a.count ? b : a));
  }, [yearRows]);

  const yoy = useMemo(() => {
    if (yearRows.length < 2) return null;
    const a = yearRows[yearRows.length - 2].count;
    const b = yearRows[yearRows.length - 1].count;
    if (!a) return null;
    return ((b - a) / a) * 100;
  }, [yearRows]);

  const focusYear = selectedYear ?? yearRows[yearRows.length - 1]?.year ?? null;

  const semRows = useMemo(() => {
    if (focusYear === null) return [];
    const byS = new Map<number, number>();
    for (const r of data.byYearSem)
      if (r.year === focusYear) byS.set(r.semester, (byS.get(r.semester) ?? 0) + r.count);
    const out: Array<{ semester: number; label: string; count: number }> = [];
    for (let s = 1; s <= 8; s++) out.push({ semester: s, label: `S${s}`, count: byS.get(s) ?? 0 });
    return out;
  }, [data.byYearSem, focusYear]);

  const branchRows = useMemo(() => {
    const sorted = [...data.byBranch].sort((a, b) => b.count - a.count);
    const sum = sorted.reduce((s, r) => s + r.count, 0) || 1;
    return sorted.map((r) => ({ ...r, pct: (r.count / sum) * 100 }));
  }, [data.byBranch]);
  const branchMaxPct = branchRows[0]?.pct ?? 100;

  // Live pulse "tick" flash — briefly wash the pulse panel every 30s to
  // signal freshness even when the numbers themselves haven't moved.
  const [flashKey, setFlashKey] = useState(0);
  useEffect(() => {
    setFlashKey((k) => k + 1);
  }, [data.pulse24hTotal, data.pulse24hDistinct]);

  const chartRef = useMouseSpotlight<HTMLDivElement>();
  const { ref: sparkRef, seen: sparksInView } = useInView<HTMLDivElement>();

  return (
    <div className="space-y-8">
      {/* Row: headline counter + live pulse */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-12">
        <div
          className="border-heavy an-panel p-6 md:col-span-8"
          style={{ animationDelay: "0ms" } as CSSProperties}
        >
          <div className="flex items-baseline justify-between gap-4">
            <div className="label-caps text-muted-foreground">Total records scoped · all-time</div>
            {yoy !== null && (
              <div className="label-caps" style={{ color: ACCENT }}>
                {yoy >= 0 ? "▲" : "▼"} {Math.abs(yoy).toFixed(1)}% YoY
              </div>
            )}
          </div>
          <div className="mt-3 font-display text-6xl leading-none tabular-nums italic tracking-tight">
            {fmt(total)}
          </div>
          <div className="mt-4 h-12 w-full">
            <ResponsiveContainer>
              <LineChart data={yearRows}>
                <Line
                  type="monotone"
                  dataKey="count"
                  stroke={ACCENT}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={true}
                  animationDuration={1400}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div
          key={flashKey}
          className="border-heavy an-panel an-flash p-6 md:col-span-4"
          style={{ animationDelay: "80ms" } as CSSProperties}
        >
          <div className="label-caps text-muted-foreground">Live pulse · 24h</div>
          <div className="mt-3 font-display text-4xl tabular-nums">
            {fmt(data.pulse24hDistinct)}
          </div>
          <div className="label-caps mt-1 text-muted-foreground">distinct semesters</div>
          <div className="mt-4 border-t border-border pt-3">
            <div className="font-display text-2xl tabular-nums">{fmt(data.pulse24hTotal)}</div>
            <div className="label-caps mt-1 text-muted-foreground">total lookups</div>
          </div>
        </div>
      </div>

      {/* Row: year-wise volume (area+KDE) + branch lollipops */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-12">
        <div
          className="an-panel md:col-span-8"
          style={{ animationDelay: "160ms" } as CSSProperties}
        >
          <div className="mb-4 flex items-center justify-between">
            <h3 className="label-caps border-l-4 pl-2" style={{ borderColor: ACCENT }}>
              Volume density / {yearRows[0]?.year}–{yearRows[yearRows.length - 1]?.year}
            </h3>
            <div className="label-caps flex gap-4 text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2" style={{ background: ACCENT }} />
                Volume
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-[2px] w-3 bg-foreground" />
                Trend
              </span>
            </div>
          </div>
          <div
            ref={chartRef}
            className="border-thick relative h-72 w-full overflow-hidden bg-muted/40"
          >
            <div className="an-grid-overlay" aria-hidden />
            <ResponsiveContainer>
              <AreaChart data={yearRows} margin={{ top: 16, right: 20, left: 0, bottom: 8 }}>
                <defs>
                  <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={ACCENT} stopOpacity={0.35} />
                    <stop offset="95%" stopColor={ACCENT} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="2 4" strokeOpacity={0.35} vertical={false} />
                <XAxis
                  dataKey="year"
                  tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }}
                  axisLine={{ stroke: "currentColor" }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }}
                  tickFormatter={fmtCompact}
                  axisLine={false}
                  tickLine={false}
                  width={40}
                />
                <Tooltip
                  cursor={{
                    stroke: "currentColor",
                    strokeWidth: 1,
                    strokeDasharray: "3 3",
                  }}
                  contentStyle={{
                    background: "var(--background)",
                    border: "3px solid var(--foreground)",
                    borderRadius: 0,
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    padding: 8,
                  }}
                  labelFormatter={(y) => `YEAR ${y}`}
                  formatter={(v: number) => [fmt(v), "Results"]}
                />
                <Area
                  type="monotone"
                  dataKey="count"
                  stroke={ACCENT}
                  strokeWidth={3}
                  fill="url(#areaFill)"
                  isAnimationActive={true}
                  animationDuration={1600}
                  animationEasing="ease-out"
                  activeDot={{
                    r: 6,
                    fill: "var(--background)",
                    stroke: ACCENT,
                    strokeWidth: 3,
                  }}
                />
                {peak && (
                  <ReferenceDot
                    x={peak.year}
                    y={peak.count}
                    r={5}
                    fill="var(--foreground)"
                    stroke="var(--background)"
                    strokeWidth={2}
                    ifOverflow="visible"
                  />
                )}
              </AreaChart>
            </ResponsiveContainer>
            <div className="an-spot" aria-hidden />
            {peak && (
              <div
                className="an-parallax absolute top-4 left-4 px-2 py-1 font-mono text-[10px] leading-tight text-background"
                style={{ background: "var(--foreground)" }}
              >
                <div className="font-bold">PEAK · {peak.year}</div>
                <div>{fmt(peak.count)} records</div>
              </div>
            )}
          </div>
          <div className="label-caps mt-2 flex justify-between text-muted-foreground italic">
            <span>Start · {yearRows[0]?.year}</span>
            <span>Move cursor for spotlight · pick a year below</span>
            <span>Now · {yearRows[yearRows.length - 1]?.year}</span>
          </div>
        </div>

        {/* Branch lollipops */}
        <div
          className="an-panel md:col-span-4"
          style={{ animationDelay: "240ms" } as CSSProperties}
        >
          <div className="mb-4 flex items-center justify-between">
            <h3 className="label-caps border-l-4 border-foreground pl-2">Branch distribution</h3>
            <span className="label-caps text-muted-foreground">k≥25</span>
          </div>
          <div className="border-thick space-y-4 p-5">
            {branchRows.map((r, i) => {
              const w = (r.pct / branchMaxPct) * 100;
              const highlight = i === 0;
              return (
                <div key={r.branch} className="an-branch-row">
                  <div className="mb-1 flex justify-between font-mono text-[11px] font-bold uppercase">
                    <span className="truncate">{r.branch}</span>
                    <span
                      className="tabular-nums"
                      style={highlight ? { color: ACCENT } : undefined}
                    >
                      {r.pct.toFixed(1)}%{" "}
                      <span className="text-muted-foreground">({fmtCompact(r.count)})</span>
                    </span>
                  </div>
                  <div className="relative flex h-4 items-center">
                    <div className="absolute h-px w-full bg-muted-foreground/25" />
                    <div
                      className="an-branch-bar absolute h-px transition-all duration-700"
                      style={{
                        width: `${w}%`,
                        background: highlight ? ACCENT : "var(--foreground)",
                        transitionDelay: `${300 + i * 80}ms`,
                      }}
                    />
                    <div
                      className="an-branch-dot absolute h-3 w-3 rounded-full border-2"
                      style={{
                        left: `calc(${w}% - 6px)`,
                        background: highlight ? ACCENT : "var(--background)",
                        borderColor: "var(--foreground)",
                        transitionDelay: `${300 + i * 80}ms`,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Year selector strip */}
      <div
        className="border-thick an-panel p-5"
        style={{ animationDelay: "320ms" } as CSSProperties}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="label-caps flex items-center gap-2">
            <span
              className="px-2 py-0.5 text-background"
              style={{ background: "var(--foreground)" }}
            >
              01
            </span>
            Year-wise volume · pick a year
          </h3>
          <span className="label-caps text-muted-foreground">Focus · {focusYear}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {yearRows.map((r) => {
            const active = r.year === focusYear;
            return (
              <button
                key={r.year}
                onClick={() => setSelectedYear(r.year)}
                className="an-year-btn border-thin flex flex-col items-start px-3 py-2 font-mono text-[11px] hover:bg-muted"
                style={
                  active
                    ? {
                        background: "var(--foreground)",
                        color: "var(--background)",
                        borderColor: "var(--foreground)",
                      }
                    : undefined
                }
              >
                <span className="font-bold tabular-nums">{r.year}</span>
                <span className="tabular-nums opacity-70">{fmtCompact(r.count)}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Small multiples: semester density for focus year */}
      <div ref={sparkRef} className="an-panel" style={{ animationDelay: "400ms" } as CSSProperties}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="label-caps flex items-center gap-2">
            <span
              className="px-2 py-0.5 text-background"
              style={{ background: "var(--foreground)" }}
            >
              02
            </span>
            Semester distribution · {focusYear}
          </h3>
          <span className="label-caps text-muted-foreground">8 semesters · normalised</span>
        </div>
        <div
          key={focusYear ?? "none"}
          className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8"
        >
          {semRows.map((s, idx) => {
            const peakSem = Math.max(...semRows.map((x) => x.count), 1);
            const highlight = s.count === peakSem && s.count > 0;
            return (
              <SemesterSparkline
                key={`${focusYear}-${s.semester}`}
                label={s.label}
                value={s.count}
                pct={s.count / peakSem}
                highlight={highlight}
                delayMs={sparksInView ? idx * 90 : 0}
                active={sparksInView}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------- semester spark */

function SemesterSparkline({
  label,
  value,
  pct,
  highlight,
  delayMs,
  active,
}: {
  label: string;
  value: number;
  pct: number;
  highlight: boolean;
  delayMs: number;
  active: boolean;
}) {
  const peakY = 40 - Math.max(6, pct * 34);
  const gradId = `sem-fill-${label}`;
  const stroke = highlight ? ACCENT : "var(--foreground)";
  const path = `M0,40 Q25,40 40,${peakY} T80,${peakY + 4} T100,40`;
  const fillPath = `${path} L100,40 L0,40 Z`;

  // Individual card hover spotlight — subtle indigo bloom.
  const cardRef = useMouseSpotlight<HTMLDivElement>();
  const [hover, setHover] = useState(false);

  return (
    <div
      ref={cardRef}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      className={`an-sparkline relative overflow-hidden p-2 transition-transform duration-200 hover:-translate-y-0.5 ${highlight ? "border-thick" : "border-thin"}`}
      style={
        {
          borderColor: highlight ? ACCENT : undefined,
          "--dash": 260,
          animationDelay: `${delayMs}ms`,
        } as CSSProperties
      }
    >
      <div className="an-spot" aria-hidden />
      <div className="relative flex items-baseline justify-between">
        <span
          className="font-mono text-[10px] font-bold"
          style={highlight ? { color: ACCENT } : undefined}
        >
          {label}
        </span>
        <span
          className={`font-mono text-[10px] tabular-nums transition-colors ${hover ? "" : "text-muted-foreground"}`}
          style={hover ? { color: ACCENT } : undefined}
        >
          {fmtCompact(value)}
        </span>
      </div>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="mt-1 h-12 w-full">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={0.4} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
        <line x1="0" y1="40" x2="100" y2="40" stroke="currentColor" strokeOpacity={0.25} />
        {active && (
          <>
            <path
              className="an-fill"
              d={fillPath}
              fill={`url(#${gradId})`}
              style={{ animationDelay: `${delayMs + 400}ms` } as CSSProperties}
            />
            <path
              className="an-line"
              d={path}
              fill="none"
              stroke={stroke}
              strokeWidth={1.75}
              style={{ animationDelay: `${delayMs}ms` } as CSSProperties}
            />
          </>
        )}
      </svg>
    </div>
  );
}
