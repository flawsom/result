// ─────────────────────────────────────────────────────────────────────────────
// Analytics client — the only place the app talks to the telemetry store.
//
// Privacy contract (unchanged from v1, and enforced again by the RPC itself):
// the wire format carries year, semester, branch and *operational* facts about
// one anonymous request. It never carries a registration number, name, DOB,
// grade, mark or session identifier.
//
// Resilience contract:
//  * every read has a hard timeout, so a dead or wrong database URL surfaces
//    as a clear error state instead of an infinite loading skeleton;
//  * a v1-only database (migration not applied yet) is detected and mapped
//    onto the v2 shape, flagged as `mixed` so the UI can label it;
//  * writes are fire-and-forget in a single batched round trip and can never
//    disrupt the student-facing fetch flow.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "@/integrations/supabase/client";

/* ───────────────────────────────────────────────────────────── contract ─── */

export type Outcome =
  | "published"
  | "not_published"
  | "timeout"
  | "rate_limited"
  | "unreachable"
  | "malformed"
  | "upstream_error"
  | "unclassified";

export interface TelemetryEvent {
  year: number;
  semester: number;
  branch: string;
  outcome: Outcome;
  /** End-to-end duration of the attempt in ms; omit when not measured. */
  latencyMs?: number;
  /** 1 = primary session, >1 = back-paper re-publication probe. */
  attempt?: number;
  source?: "live" | "cache" | "unknown";
  /** Number of subject rows returned (0 when nothing was published). */
  subjects?: number;
}

export interface CountedRow {
  count: number;
}

export interface AnalyticsPayload {
  meta: {
    schema: "v2" | "v1";
    generatedAt: string;
    firstEventAt: string | null;
    lastEventAt: string | null;
    activeDays: number;
    /** v1 databases cannot separate seeded baseline from observed traffic. */
    mixed: boolean;
  };
  counts: {
    eventsTotal: number;
    primaries: number;
    probes: number;
    published: number;
    notPublished: number;
    cacheHits: number;
    latencySamples: number;
    pulse1h: number;
    pulse24h: number;
    pulse7d: number;
  };
  observed: {
    byYear: Array<{ year: number; count: number }>;
    byYearSem: Array<{ year: number; semester: number; count: number }>;
    byBranch: Array<{ branch: string; count: number }>;
    byOutcome: Array<{ outcome: Outcome; count: number }>;
    funnel: Array<{ semester: number; attempts: number; published: number; failed: number }>;
    latency: Array<{ semester: number; p50: number; p95: number; maxMs: number; n: number }>;
    subjects: Array<{ semester: number; p50: number; maxSubjects: number; n: number }>;
    daily: Array<{ day: string; total: number; published: number }>;
    hourly: Array<{ hour: string; count: number }>;
    seasonality: Array<{ dow: number; hour: number; count: number }>;
    publication: Array<{
      year: number;
      semester: number;
      firstSeenAt: string;
      lastSeenAt: string;
      count: number;
    }>;
    branchYear: Array<{ year: number; branch: string; count: number }>;
  };
  /** Modelled 2018–2025 reference series. Never observed traffic. */
  baseline: {
    total: number;
    byYear: Array<{ year: number; count: number }>;
    byBranch: Array<{ branch: string; count: number }>;
  };
}

export interface LiveCounters {
  events: number;
  updated_at: string;
  last_year: number | null;
  last_semester: number | null;
  last_outcome: string | null;
  last_latency_ms: number | null;
}

/* ─────────────────────────────────────────────────────────────── errors ─── */

export type TelemetryErrorKind =
  | "unconfigured"
  | "unreachable"
  | "missing-schema"
  | "denied"
  | "timeout"
  | "unknown";

export class TelemetryError extends Error {
  readonly kind: TelemetryErrorKind;

  constructor(kind: TelemetryErrorKind, message: string) {
    super(message);
    this.name = "TelemetryError";
    this.kind = kind;
  }
}

const READ_TIMEOUT_MS = 8_000;
const WRITE_TIMEOUT_MS = 6_000;
export const REALTIME_FALLBACK_POLL_MS = 20_000;

function isMissingFunction(message: string, code?: string): boolean {
  return (
    code === "PGRST202" || /could not find the function|does not exist|schema cache/i.test(message)
  );
}

function isNetworkFailure(message: string): boolean {
  return /failed to fetch|networkerror|load failed|fetch failed|err_name_not_resolved|enotfound|eai_again/i.test(
    message,
  );
}

function classify(message: string, code?: string): TelemetryError {
  if (/missing supabase environment variable/i.test(message)) {
    return new TelemetryError(
      "unconfigured",
      "No Supabase URL or publishable key is configured for this build, so the telemetry store cannot be reached at all.",
    );
  }
  if (isMissingFunction(message, code)) {
    return new TelemetryError(
      "missing-schema",
      "The analytics v2 schema is not present on this database yet (run supabase/migrations/20260928120000_analytics_v2.sql).",
    );
  }
  if (isNetworkFailure(message)) {
    return new TelemetryError(
      "unreachable",
      "Telemetry store unreachable — the configured Supabase host did not answer.",
    );
  }
  if (/permission denied|jwt|401|403/i.test(message)) {
    return new TelemetryError(
      "denied",
      "Telemetry read was rejected by the database's row-level security.",
    );
  }
  return new TelemetryError("unknown", message || "Unknown telemetry failure.");
}

async function withTimeout<T>(
  run: (signal: AbortSignal) => PromiseLike<T>,
  ms: number,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await run(ctrl.signal);
  } catch (e) {
    const err = e as Error;
    if (err?.name === "AbortError" || /aborted/i.test(err?.message ?? "")) {
      throw new TelemetryError("timeout", `Telemetry read exceeded ${ms} ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ──────────────────────────────────────────────────────────────── read ─── */

/** v1 shape, kept so a database without the v2 migration still renders. */
interface LegacyPayload {
  total: number;
  byYear: Array<{ year: number; count: number }>;
  byYearSem: Array<{ year: number; semester: number; count: number }>;
  byBranch: Array<{ branch: string; count: number }>;
  pulse24hDistinct: number;
  pulse24hTotal: number;
  updatedAt: string;
}

function adaptLegacy(raw: LegacyPayload): AnalyticsPayload {
  const total = Number(raw.total) || 0;
  return {
    meta: {
      schema: "v1",
      generatedAt: raw.updatedAt ?? new Date().toISOString(),
      firstEventAt: null,
      lastEventAt: raw.updatedAt ?? null,
      activeDays: 0,
      mixed: true,
    },
    counts: {
      eventsTotal: total,
      primaries: total,
      probes: 0,
      published: total,
      notPublished: 0,
      cacheHits: 0,
      latencySamples: 0,
      pulse1h: 0,
      pulse24h: Number(raw.pulse24hTotal) || 0,
      pulse7d: 0,
    },
    observed: {
      byYear: (raw.byYear ?? []).map((r) => ({
        year: Number(r.year),
        count: Number(r.count),
      })),
      byYearSem: (raw.byYearSem ?? []).map((r) => ({
        year: Number(r.year),
        semester: Number(r.semester),
        count: Number(r.count),
      })),
      byBranch: (raw.byBranch ?? []).map((r) => ({
        branch: String(r.branch),
        count: Number(r.count),
      })),
      byOutcome: [],
      funnel: [],
      latency: [],
      subjects: [],
      daily: [],
      hourly: [],
      seasonality: [],
      publication: [],
      branchYear: [],
    },
    baseline: { total: 0, byYear: [], byBranch: [] },
  };
}

/**
 * Normalise anything thrown on the read path into a classified TelemetryError,
 * so the UI can always show a specific cause instead of a raw message.
 */
export function classifyTelemetryError(error: unknown): TelemetryError {
  if (error instanceof TelemetryError) return error;
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  const code = (error as { code?: string } | null)?.code;
  return classify(message, code);
}

/**
 * One round trip that returns the whole dashboard snapshot.
 * Order of preference: v2 → v1 → throw a classified TelemetryError.
 */
export async function fetchAnalytics(): Promise<AnalyticsPayload> {
  let v2: Awaited<ReturnType<typeof readV2>>;
  try {
    v2 = await readV2();
  } catch (e) {
    throw classifyTelemetryError(e);
  }

  if (!v2.error && v2.data) {
    const payload = v2.data as unknown as AnalyticsPayload;
    return {
      ...payload,
      meta: { ...payload.meta, schema: "v2", mixed: false },
    };
  }

  const v2Error = classify(v2.error?.message ?? "", v2.error?.code);

  // A missing v2 function is expected on a database that has not run the new
  // migration yet — degrade to the legacy aggregate instead of failing.
  if (v2Error.kind !== "missing-schema") throw v2Error;

  try {
    const v1 = await withTimeout(
      (signal) => supabase.rpc("get_results_analytics").abortSignal(signal),
      READ_TIMEOUT_MS,
    );
    if (v1.error || !v1.data) {
      throw classify(v1.error?.message ?? v2Error.message, v1.error?.code);
    }
    return adaptLegacy(v1.data as unknown as LegacyPayload);
  } catch (e) {
    throw classifyTelemetryError(e);
  }
}

/** v2 read, split out so its synchronous throws are classified too. */
function readV2() {
  return withTimeout(
    (signal) => supabase.rpc("get_results_analytics_v2").abortSignal(signal),
    READ_TIMEOUT_MS,
  );
}

/* ─────────────────────────────────────────────────────────────── write ─── */

/**
 * Write a whole lookup's worth of observations in ONE request.
 *
 * Previously each successful semester fired its own request (8 per lookup,
 * failures never recorded at all). Batching means we can afford to record
 * every attempt — including the ones that failed — which is what makes the
 * success-rate and latency panels meaningful.
 *
 * Never throws, never blocks the result flow.
 */
export function logResultEvents(events: TelemetryEvent[]): void {
  if (events.length === 0) return;
  void withTimeout(
    (signal) =>
      supabase
        .rpc("log_result_events", { _events: events as unknown as never })
        .abortSignal(signal),
    WRITE_TIMEOUT_MS,
  )
    .then(({ error }) => {
      if (error) console.warn("[analytics] log failed:", error.message);
    })
    .catch((e) => {
      console.warn("[analytics] log failed:", (e as Error)?.message ?? e);
    });
}

/* ─────────────────────────────────────────────────────────────── live ─── */

export interface LiveSubscription {
  /** Detach the channel. Safe to call twice. */
  close: () => void;
}

/**
 * Genuine push updates: the database maintains a single aggregate counter row
 * and broadcasts every change to it. The browser never gets read access to the
 * event stream itself — only to that one aggregate row.
 */
export function subscribeLiveCounters(
  onRow: (row: LiveCounters) => void,
  onStatus?: (status: "connecting" | "live" | "offline") => void,
): LiveSubscription {
  let closed = false;
  onStatus?.("connecting");

  const channel = supabase
    .channel("analytics-live-counters")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "analytics_live" },
      (payload) => {
        const row = (payload.new ?? null) as LiveCounters | null;
        if (row && typeof row.events === "number") onRow(row);
      },
    )
    .subscribe((status) => {
      if (closed) return;
      if (status === "SUBSCRIBED") onStatus?.("live");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        onStatus?.("offline");
      }
    });

  return {
    close: () => {
      closed = true;
      void supabase.removeChannel(channel);
    },
  };
}
