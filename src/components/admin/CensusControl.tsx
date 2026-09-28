// Census control for the admin surface.
//
// A census run is long by construction: every student costs one request for
// their record plus one per semester, at a deliberately slow pace so the
// university's portal is never hammered. This panel therefore refuses to hide
// the cost — it states the request count and the wall-clock time before you
// start, and it keeps the run in front of you while it works.
//
// Progress is persisted server-side after every batch, so closing the tab is
// survivable: the offset lives in the database, not in this component.
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  cancelCensus,
  estimateRequests,
  getCensusState,
  parseCensusRange,
  pauseCensus,
  resumeCensus,
  runCensus,
  subscribeCensus,
  type CensusRunnerState,
} from "@/lib/census-runner";
import { toast } from "sonner";

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const minutes = ms / 60_000;
  if (minutes < 90) return `${minutes.toFixed(0)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

export function CensusControl() {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [rateMs, setRateMs] = useState(1000);
  const [probe, setProbe] = useState(false);
  const [state, setState] = useState<CensusRunnerState>(getCensusState);

  useEffect(() => subscribeCensus(setState), []);

  const parsed = useMemo(() => {
    if (!start || !end) return null;
    try {
      return parseCensusRange(start, end);
    } catch {
      return null;
    }
  }, [start, end]);

  const requests = parsed ? estimateRequests(parsed.total, probe) : 0;
  const durationMs = requests * Math.max(250, rateMs);

  const progressPct =
    state.total > 0 ? Math.min(100, (Math.min(state.index, state.total) / state.total) * 100) : 0;

  const startRun = async () => {
    if (!parsed) return;
    try {
      toast.info("Census started — leave this tab open. Progress is saved after every batch.");
      await runCensus({
        rangeStart: parsed.start,
        rangeEnd: parsed.end,
        rateLimitMs: rateMs,
        probeBackPapers: probe,
      });
      const s = getCensusState();
      toast.success(
        `Census finished: ${s.observations.toLocaleString()} observations from ${s.students.toLocaleString()} students.`,
      );
    } catch (e) {
      toast.error(`Census stopped: ${(e as Error)?.message ?? "unknown error"}`);
    }
  };

  return (
    <section className="rounded-lg border bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">BPUT census</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Walks a registration-number range and stores anonymous observations only — batch year,
            semester, branch, college, outcome, subject and credit totals, grade histogram. No
            registration number, name or date of birth is written, and progress is recorded as a
            range offset rather than a student.
          </p>
        </div>
        {state.running ? (
          <Badge variant={state.paused ? "secondary" : "default"}>
            {state.paused ? "Paused" : "Running"}
          </Badge>
        ) : null}
      </div>

      <div className="mt-4 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Autonomous crawl:</span> this panel drives a
        range by hand. <code>.github/workflows/census.yml</code> runs the identical walk with no tab
        open and resumes from the same saved offset — set the repository variables{" "}
        <code>CENSUS_RANGE_START</code> and <code>CENSUS_RANGE_END</code>, add the{" "}
        <code>SUPABASE_SERVICE_ROLE_KEY</code> secret, and it ticks on its own. The landing page
        follows it live either way.
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-2">
          <Label htmlFor="census-start">Range start</Label>
          <Input
            id="census-start"
            placeholder="2101010001"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            disabled={state.running}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="census-end">Range end</Label>
          <Input
            id="census-end"
            placeholder="2101011200"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            disabled={state.running}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="census-rate">Delay per request (ms)</Label>
          <Input
            id="census-rate"
            type="number"
            min={250}
            step={250}
            value={rateMs}
            onChange={(e) => setRateMs(Number(e.target.value) || 1000)}
            disabled={state.running}
          />
          <p className="text-xs text-muted-foreground">
            Raise this, never lower it: the portal rate-limits aggressively.
          </p>
        </div>
        <div className="space-y-2">
          <Label>Back-paper probes</Label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={probe}
              onChange={(e) => setProbe(e.target.checked)}
              disabled={state.running}
            />
            <span>Also try later sessions</span>
          </label>
          <p className="text-xs text-muted-foreground">
            Catches republications, but multiplies upstream requests by about five.
          </p>
        </div>
      </div>

      {parsed ? (
        <div className="mt-4 rounded-md border bg-muted/40 p-3 text-sm">
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span>
              <span className="text-muted-foreground">Numbers in range:</span>{" "}
              <strong>{parsed.total.toLocaleString()}</strong>
            </span>
            <span>
              <span className="text-muted-foreground">Upstream requests:</span>{" "}
              <strong>{requests.toLocaleString()}</strong>
            </span>
            <span>
              <span className="text-muted-foreground">Time at this pace:</span>{" "}
              <strong>{formatDuration(durationMs)}</strong>
            </span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Unused numbers inside the range still cost one request each, so a sparse range is slower
            per student found. Nothing is skipped silently.
          </p>
        </div>
      ) : start && end ? (
        <p className="mt-4 text-sm text-destructive">
          Both bounds must be 6–12 digit numbers of equal length, with end ≥ start, and at most
          200,000 numbers apart.
        </p>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-2">
        <Button onClick={() => void startRun()} disabled={!parsed || state.running}>
          {state.total > 0 && !state.running ? "Resume census" : "Start census"}
        </Button>
        <Button
          variant="secondary"
          onClick={() => (state.paused ? resumeCensus() : pauseCensus())}
          disabled={!state.running}
        >
          {state.paused ? "Resume" : "Pause"}
        </Button>
        <Button variant="destructive" onClick={cancelCensus} disabled={!state.running}>
          Stop
        </Button>
      </div>

      {state.total > 0 ? (
        <div className="mt-5 space-y-2">
          <Progress value={progressPct} />
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span>
              <span className="text-muted-foreground">Offset:</span>{" "}
              <strong>
                {state.index.toLocaleString()} / {state.total.toLocaleString()}
              </strong>
            </span>
            <span>
              <span className="text-muted-foreground">Probed:</span>{" "}
              <strong>{state.visited.toLocaleString()}</strong>
            </span>
            <span>
              <span className="text-muted-foreground">Students:</span>{" "}
              <strong>{state.students.toLocaleString()}</strong>
            </span>
            <span>
              <span className="text-muted-foreground">Unused numbers:</span>{" "}
              <strong>{state.notFound.toLocaleString()}</strong>
            </span>
            <span>
              <span className="text-muted-foreground">Observations:</span>{" "}
              <strong>{state.observations.toLocaleString()}</strong>
            </span>
            <span>
              <span className="text-muted-foreground">Stored:</span>{" "}
              <strong>{state.stored.toLocaleString()}</strong>
            </span>
          </div>
          {state.lastError ? <p className="text-xs text-destructive">{state.lastError}</p> : null}
          <p className="text-xs text-muted-foreground">
            A run from this page needs the tab to stay open — closing it stops the crawl, and
            pressing Start again resumes from the saved offset rather than re-walking the range. For
            a crawl that survives the tab, use the scheduled workflow described above.
          </p>
        </div>
      ) : null}
    </section>
  );
}
