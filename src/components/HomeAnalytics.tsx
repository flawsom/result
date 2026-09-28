// ─────────────────────────────────────────────────────────────────────────────
// Landing-page "BPUT Results Intelligence" section.
//
// Data flow, end to end:
//   lookup → batched telemetry write (one RPC, ≤64 rows) → Postgres aggregates
//          → get_results_analytics_v2() → derived statistics in the browser.
//
// Three behaviours matter here and are deliberate:
//  1. NOTHING is invented. Every figure is traceable to a recorded observation,
//     and every panel states the sample it rests on.
//  2. The store is never allowed to hang the page. Reads have a hard timeout,
//     so an unreachable or half-migrated database renders a specific,
//     actionable state instead of an endless skeleton.
//  3. "Live" means live. A single aggregate counter row is subscribed through
//     Realtime, so a lookup anywhere in the world increments the ticker here
//     within a second — no polling illusion.
// ─────────────────────────────────────────────────────────────────────────────

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import {
  classifyTelemetryError,
  fetchAnalytics,
  compiledSupabaseHost,
  subscribeLiveCounters,
  type AnalyticsPayload,
  type LiveCounters,
  type TelemetryErrorKind,
} from "@/lib/analytics-client";
import {
  fmtAgo,
  fmtCompact,
  fmtInt,
  fmtMs,
  fmtPct,
  latencyStats,
  outcomeStats,
} from "@/lib/analytics-stats";
import {
  ACCENT,
  BranchPanel,
  DefinitionsPanel,
  FunnelPanel,
  KpiTile,
  LatencyPanel,
  OutcomePanel,
  PublicationPanel,
  SeasonalityPanel,
  VolumePanel,
  YearPanel,
} from "@/components/analytics/panels";

/**
 * While the realtime channel is live, a slow reconciliation read guards against
 * a dropped broadcast; when it is not, we poll often enough that the section
 * still tracks the database closely. Both are short because the aggregate is
 * bounded to 90 daily and 48 hourly buckets.
 */
const RECONCILE_MS = 30_000;
const POLL_MS = 10_000;
/** Bursts of writes collapse into one aggregate read this far apart. */
const COALESCE_MS = 1_500;

/* ────────────────────────────────────────────────────────── scoped styles ── */

const SCOPED_STYLES = `
  @keyframes an-rise {
    from { opacity: 0; transform: translateY(14px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes an-flash {
    0%   { background: color-mix(in oklab, ${ACCENT} 20%, transparent); }
    100% { background: transparent; }
  }
  @keyframes an-blip {
    0%   { transform: scaleY(0.3); opacity: .4; }
    100% { transform: scaleY(1);   opacity: 1; }
  }
  .an-panel { animation: an-rise .5s cubic-bezier(.2,.7,.2,1) both; }
  .an-branch-row {
    position: relative;
    padding: 4px 6px;
    margin: -4px -6px;
    transition: background .18s ease;
  }
  .an-branch-row:hover { background: color-mix(in oklab, ${ACCENT} 8%, transparent); }
  .an-blip { animation: an-blip .45s cubic-bezier(.2,.7,.2,1); transform-origin: bottom; }
  .an-flash { animation: an-flash 1.1s ease-out; }
  @media (prefers-reduced-motion: reduce) {
    .an-panel, .an-blip, .an-flash { animation: none !important; }
  }
`;

/* ────────────────────────────────────────────────────────── small pieces ── */

/** Self-contained clock so the rest of the dashboard re-renders only on data. */
function Freshness({ iso, prefix }: { iso: string | null; prefix?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span>
      {prefix ?? ""}
      {fmtAgo(iso, now)}
    </span>
  );
}

function StatusChip({ status }: { status: "connecting" | "live" | "offline" }) {
  const spec: Record<typeof status, { label: string; color: string }> = {
    connecting: { label: "Connecting", color: "var(--muted-foreground)" },
    live: { label: "Realtime push", color: "oklch(0.55 0.18 145)" },
    offline: { label: "Polling · 10s", color: "oklch(0.72 0.19 65)" },
  };
  const s = spec[status];
  return (
    <span className="label-caps inline-flex items-center gap-2" style={{ color: s.color }}>
      <span className="relative inline-flex h-2.5 w-2.5">
        {status !== "offline" && (
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
            style={{ background: s.color }}
          />
        )}
        <span className="relative inline-flex h-2.5 w-2.5" style={{ background: s.color }} />
      </span>
      {s.label}
    </span>
  );
}

function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse bg-muted ${className}`} aria-hidden />;
}

function LoadingState() {
  return (
    <div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-12">
        <Skeleton className="h-28 md:col-span-6" />
        <Skeleton className="h-28 md:col-span-6" />
        <Skeleton className="h-72 md:col-span-8" />
        <Skeleton className="h-72 md:col-span-4" />
        <Skeleton className="h-64 md:col-span-4" />
        <Skeleton className="h-64 md:col-span-8" />
      </div>
      <p className="label-caps mt-4 text-muted-foreground">
        Reading the telemetry store · reads abort after 8s rather than hanging
      </p>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────── errors ── */

const ERROR_COPY: Record<TelemetryErrorKind, { title: string; detail: ReactNode }> = {
  unconfigured: {
    title: "No telemetry store configured",
    detail: (
      <span>
        This build has no Supabase URL or publishable key, so there is nothing to read from. Set
        VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in Settings then reload — the dashboard
        reads straight from the database and keeps no fallback copy of its own.
      </span>
    ),
  },
  unreachable: {
    title: "Telemetry store unreachable",
    detail: (
      <>
        The configured Supabase host did not answer. Nothing on this page is cached or invented, so
        the panels stay empty until the database responds. Check that <code>VITE_SUPABASE_URL</code>{" "}
        and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> point at a live project.
      </>
    ),
  },
  "missing-schema": {
    title: "Analytics schema not applied",
    detail: (
      <>
        The database is reachable but does not expose <code>get_results_analytics_v2()</code> or{" "}
        <code>log_result_events()</code>, so there is nothing measured to draw. Apply{" "}
        <code>supabase/migrations/20260928120000_analytics_v2.sql</code> in the Supabase SQL editor
        and reload. Nothing is shown in the meantime, because the only series that would be
        available is a modelled one.
      </>
    ),
  },
  denied: {
    title: "Read rejected by row-level security",
    detail: (
      <>
        The RPCs are <code>SECURITY DEFINER</code> and granted to <code>anon</code>. If a read is
        refused, the grants from the migration did not apply — re-run it, then reload.
      </>
    ),
  },
  timeout: {
    title: "Telemetry read timed out",
    detail: (
      <>
        The aggregate did not answer within 8 seconds. The query is bounded to 90 days of daily
        buckets and 48 hours of hourly buckets, so this normally means the database is cold or
        saturated rather than the query being heavy.
      </>
    ),
  },
  unknown: {
    title: "Analytics unavailable",
    detail: <>The telemetry store returned an error the dashboard could not classify.</>,
  },
};

function ErrorState({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}) {
  const e = classifyTelemetryError(error);
  const copy = ERROR_COPY[e.kind] ?? ERROR_COPY.unknown;
  return (
    <div className="border-heavy p-6">
      <div className="label-caps" style={{ color: "oklch(0.58 0.24 27)" }}>
        Diagnostics failed · {e.kind}
      </div>
      <h3 className="font-display mt-2 text-2xl">{copy.title}</h3>
      <p className="mt-3 max-w-3xl font-mono text-xs leading-relaxed">{copy.detail}</p>
      <p className="mt-3 max-w-3xl border-l-4 border-foreground pl-3 font-mono text-[11px] break-words text-muted-foreground">
        {e.message}
      </p>
      <p className="mt-3 max-w-3xl font-mono text-[11px] text-muted-foreground">
        This build was compiled against <span className="font-bold">{compiledSupabaseHost()}</span>.
        If that is not the project you expect, the environment variables the site was built with are
        wrong — a Vite build bakes them in, so changing them requires a rebuild.
      </p>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="border-thick mt-5 bg-foreground px-5 py-2.5 font-mono text-xs font-bold uppercase tracking-widest text-background hover:bg-background hover:text-foreground disabled:opacity-40"
      >
        {retrying ? "Retrying…" : "Retry read"}
      </button>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────── section ── */

export function HomeAnalytics() {
  const queryClient = useQueryClient();
  const [live, setLive] = useState<LiveCounters | null>(null);
  const [status, setStatus] = useState<"connecting" | "live" | "offline">("connecting");

  const q = useQuery({
    queryKey: ["home-analytics"],
    queryFn: fetchAnalytics,
    retry: 1,
    retryDelay: 700,
    staleTime: 5_000,
    refetchInterval: status === "live" ? RECONCILE_MS : POLL_MS,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
  });

  // Realtime: subscribe immediately rather than waiting for the first read, so
  // the ticker starts moving the moment the database is written to. The counter
  // row is painted straight from the pushed payload, and the aggregate is
  // re-read a beat later — coalesced, so a busy evening cannot become a request
  // storm.
  useEffect(() => {
    let timer: number | null = null;
    const sub = subscribeLiveCounters((row) => {
      setLive(row);
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        void queryClient.invalidateQueries({ queryKey: ["home-analytics"] });
      }, COALESCE_MS);
    }, setStatus);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      sub.close();
    };
  }, [queryClient]);

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
          <StatusChip status={status} />
          <div className="label-caps mt-1 text-muted-foreground">
            {q.data ? (
              <Freshness iso={q.data.meta.generatedAt} prefix="snapshot " />
            ) : (
              "awaiting first read"
            )}
          </div>
          <div className="label-caps mt-1 text-muted-foreground">
            {q.data ? "telemetry schema v2 · observed only" : "schema unverified"}
          </div>
        </div>
      </div>

      <p className="mt-6 max-w-3xl text-sm text-muted-foreground">
        Every figure below is derived from requests this site actually served: one anonymous row per
        upstream attempt, recording the batch year, semester, branch, outcome and measured duration
        — never a roll number, name, grade or any other identifying detail. Branches with fewer than
        25 observations are pooled into <em>Other</em>, and the time series is gap-filled with real
        zeros so an idle day never looks like missing data.
      </p>

      <div className="mt-8">
        {q.isPending ? (
          <LoadingState />
        ) : q.isError ? (
          <ErrorState error={q.error} retrying={q.isFetching} onRetry={() => void q.refetch()} />
        ) : q.data ? (
          <AnalyticsBody
            data={q.data}
            live={live}
            status={status}
            refreshing={q.isFetching}
            onRefresh={() => void q.refetch()}
          />
        ) : null}
      </div>

      <div className="mt-10 border-thick p-4 font-mono text-xs leading-relaxed">
        <span className="label-caps">Privacy note</span>
        <span className="ml-3">
          The telemetry table stores only counters and operational facts about anonymous requests:
          batch year, semester, branch, outcome, attempt index, measured duration and how many
          subject rows came back. No registration numbers, names, dates of birth, marks, grades, IP
          addresses or session identifiers are ever written — the writer function rejects any field
          outside that list, and cohorts under 25 observations are always pooled before they are
          shown.
        </span>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────── body ── */

function AnalyticsBody({
  data,
  live,
  status,
  refreshing,
  onRefresh,
}: {
  data: AnalyticsPayload;
  live: LiveCounters | null;
  status: "connecting" | "live" | "offline";
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const outcomes = useMemo(() => outcomeStats(data), [data]);
  const latency = useMemo(() => latencyStats(data.observed.latency), [data]);
  const coldStart = data.counts.eventsTotal === 0;

  return (
    <div className="space-y-8">
      <LiveTicker
        data={data}
        live={live}
        status={status}
        refreshing={refreshing}
        onRefresh={onRefresh}
        coldStart={coldStart}
      />

      <div className="grid grid-cols-1 gap-6 md:grid-cols-12">
        <div className="md:col-span-3">
          <KpiTile
            label="Observed requests"
            value={data.counts.eventsTotal}
            sub={<span className="text-muted-foreground">every recorded upstream attempt</span>}
            sample={`${fmtInt(data.meta.activeDays)} active days`}
          />
        </div>
        <div className="md:col-span-3">
          <KpiTile
            label="Primary attempts"
            value={data.counts.primaries}
            sub={
              <span className="text-muted-foreground">
                +{fmtInt(data.counts.probes)} back-paper probes
              </span>
            }
            sample="one per semester per lookup"
          />
        </div>
        <div className="md:col-span-3">
          <KpiTile
            label="Published rate"
            value={Math.round(outcomes.success.p * 1000) / 10}
            unit="%"
            accent="oklch(0.55 0.18 145)"
            sub={
              <span className="text-muted-foreground">
                Wilson 95% CI {fmtPct(outcomes.success.low, 0)}–{fmtPct(outcomes.success.high, 0)}
              </span>
            }
            sample={`n = ${fmtInt(outcomes.success.n)} primary attempts`}
          />
        </div>
        <div className="md:col-span-3">
          <KpiTile
            label="p95 latency"
            value={Math.round(latency.p95)}
            unit="ms"
            sub={
              <span className="text-muted-foreground">
                p50 {fmtMs(latency.p50)} · tail{" "}
                {latency.spread > 0 ? `${latency.spread.toFixed(2)}×` : "—"}
              </span>
            }
            sample={`n = ${fmtInt(latency.n)} measured attempts`}
          />
        </div>
      </div>

      {coldStart ? (
        <ColdStart />
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-12">
          <div className="md:col-span-8">
            <VolumePanel payload={data} />
          </div>
          <div className="md:col-span-4">
            <OutcomePanel payload={data} />
          </div>
          <div className="md:col-span-4">
            <LatencyPanel payload={data} />
          </div>
          <div className="md:col-span-8">
            <SeasonalityPanel payload={data} />
          </div>
          <div className="md:col-span-6">
            <BranchPanel payload={data} />
          </div>
          <div className="md:col-span-6">
            <PublicationPanel payload={data} />
          </div>
          <div className="md:col-span-8">
            <YearPanel payload={data} />
          </div>
          <div className="md:col-span-4">
            <FunnelPanel payload={data} />
          </div>
        </div>
      )}

      <DefinitionsPanel payload={data} />
    </div>
  );
}

/* ───────────────────────────────────────────────────────────── live ticker ── */

function LiveTicker({
  data,
  live,
  status,
  refreshing,
  onRefresh,
  coldStart,
}: {
  data: AnalyticsPayload;
  live: LiveCounters | null;
  status: "connecting" | "live" | "offline";
  refreshing: boolean;
  onRefresh: () => void;
  coldStart: boolean;
}) {
  const events = live?.events ?? data.counts.eventsTotal;
  const [flashKey, setFlashKey] = useState(0);
  const prev = useRef(events);
  useEffect(() => {
    if (events !== prev.current) {
      prev.current = events;
      setFlashKey((k) => k + 1);
    }
  }, [events]);

  const hourly = useMemo(() => data.observed.hourly.slice(-48), [data]);
  const maxHour = useMemo(() => Math.max(1, ...hourly.map((h) => h.count)), [hourly]);
  const lastOutcome = live?.last_outcome ?? null;

  return (
    <div
      key={`live-${flashKey}`}
      className="border-heavy an-flash p-5"
      style={{ animationDelay: "0ms" } as CSSProperties}
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="label-caps text-muted-foreground">
            01 · Live counter {status === "live" ? "· pushed from the database" : ""}
          </div>
          <div
            className="font-display mt-2 text-5xl leading-none tabular-nums"
            style={{ color: ACCENT }}
          >
            {fmtInt(events)}
          </div>
          <div className="label-caps mt-1 text-muted-foreground">
            anonymous observations recorded
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-6">
          <Stat label="last hour" value={data.counts.pulse1h} />
          <Stat label="last 24h" value={data.counts.pulse24h} />
          <Stat label="last 7d" value={data.counts.pulse7d} />
          <div>
            <div className="label-caps text-muted-foreground">last event</div>
            <div className="font-mono text-sm">
              {live?.last_year ? (
                <>
                  {live.last_year} · S{live.last_semester ?? "?"}
                  {live.last_latency_ms ? ` · ${fmtMs(live.last_latency_ms)}` : ""}
                </>
              ) : data.meta.lastEventAt ? (
                <Freshness iso={data.meta.lastEventAt} />
              ) : (
                "—"
              )}
            </div>
            <div className="label-caps mt-1 text-muted-foreground">
              {lastOutcome ? lastOutcome.replace(/_/g, " ") : "no classified outcome"}
            </div>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="border-thick px-4 py-2 font-mono text-xs font-bold uppercase tracking-widest hover:bg-foreground hover:text-background disabled:opacity-40"
          >
            {refreshing ? "Syncing…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="mt-5">
        <div className="label-caps mb-2 flex items-center justify-between text-muted-foreground">
          <span>48-hour request volume</span>
          <span>{coldStart ? "no observations yet" : `peak ${fmtInt(maxHour)}/hour`}</span>
        </div>
        <div className="flex h-16 items-end gap-[2px]" aria-hidden>
          {hourly.map((h, i) => {
            const pct = (h.count / maxHour) * 100;
            const isLast = i === hourly.length - 1;
            return (
              <span
                key={h.hour}
                title={`${new Date(h.hour).toLocaleString("en-GB")} · ${fmtInt(h.count)} requests`}
                className={`flex-1 ${isLast ? "an-blip" : ""}`}
                style={{
                  height: `${Math.max(2, pct)}%`,
                  background:
                    h.count === 0 ? "var(--muted)" : isLast ? ACCENT : "var(--foreground)",
                  opacity: h.count === 0 ? 1 : isLast ? 1 : 0.55 + pct / 220,
                }}
              />
            );
          })}
        </div>
        <div className="label-caps mt-2 text-muted-foreground">
          Gap-filled hourly buckets · an empty bar is zero requests, not missing data
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="label-caps text-muted-foreground">{label}</div>
      <div className="font-display text-2xl leading-none tabular-nums">{fmtCompact(value)}</div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── cold start ── */

function ColdStart() {
  const rows: Array<[string, string]> = [
    ["Live counter", "increments on the first lookup anywhere in the world"],
    ["Volume, trend & forecast", "needs a few days of daily buckets before a trend is meaningful"],
    ["Outcome mix & success rate", "fills immediately — every attempt is classified"],
    ["Latency by semester", "fills immediately — duration is measured per attempt"],
    ["When lookups happen", "needs events across several days to show a rhythm"],
    ["Branch structure", "needs 25+ observations per branch to clear the anonymity floor"],
    ["Publication matrix", "stamps each semester the first time it is seen published"],
  ];
  return (
    <div className="border-heavy p-6">
      <div className="label-caps text-muted-foreground">
        Panels 03–10 · awaiting the first observation
      </div>
      <h3 className="font-display mt-2 text-3xl">No observations recorded yet.</h3>
      <p className="mt-3 max-w-3xl font-mono text-xs leading-relaxed">
        The telemetry store answered, and it is genuinely empty — the dashboard is not degraded, and
        no fallback data is being substituted. Every panel below populates from real recorded
        activity, so here is exactly what fills and what it waits for.
      </p>
      <table className="mt-4 w-full border-collapse font-mono text-[11px]">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-t border-foreground align-top">
              <td className="w-64 px-3 py-2 font-bold">{k}</td>
              <td className="px-3 py-2 text-muted-foreground">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
