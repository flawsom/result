// Census control for the admin surface.
//
// A census run is long by construction: every student costs one request for
// their record plus one per semester, at a deliberately slow pace so the
// university's portal is never hammered. This panel therefore refuses to hide
// the cost, it states the request count and the wall-clock time before you
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
  runCensusGrid,
  subscribeCensus,
  type CensusRunnerState,
} from "@/lib/census-runner";
import { SKIP_AFTER_MISSES, censusBlocks, estimatedRequests } from "@/lib/census-blocks";
import { toast } from "sonner";

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "–";
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
  const [years, setYears] = useState("");
  const [gridRps, setGridRps] = useState(8);
  const [gridWorkers, setGridWorkers] = useState(4);
  const [gridBlocks, setGridBlocks] = useState(0);
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

  // The measured grid, and what the current selection of it would cost.
  const grid = useMemo(() => {
    const wanted = years
      .split(/[,\s]+/)
      .map(Number)
      .filter(Number.isFinite);
    const all = censusBlocks();
    const selected =
      wanted.length > 0
        ? all.filter((b) => wanted.includes(b.year) || wanted.includes(b.year - 2000))
        : all;
    const capped = gridBlocks > 0 ? selected.slice(0, gridBlocks) : selected;
    const requests = estimatedRequests(capped);
    return {
      years: wanted,
      selected: capped.length,
      all: all.length,
      requests,
      hours: requests / Math.max(1, gridRps) / 3600,
    };
  }, [years, gridBlocks, gridRps]);

  const progressPct =
    state.mode === "grid"
      ? state.gridTotal > 0
        ? Math.min(100, (state.blocksDone / state.gridTotal) * 100)
        : 0
      : state.total > 0
        ? Math.min(100, (Math.min(state.index, state.total) / state.total) * 100)
        : 0;

  const startRun = async () => {
    if (!parsed) return;
    try {
      toast.info("Census started. Leave this tab open. Progress is saved after every batch.");
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

  const startGrid = async () => {
    if (grid.selected === 0) return;
    try {
      toast.info("Grid crawl started. Leave this tab open. Progress is saved per block.");
      await runCensusGrid({
        years: grid.years,
        maxBlocks: gridBlocks,
        concurrency: gridWorkers,
        maxRps: gridRps,
      });
      const s = getCensusState();
      toast.success(
        `Grid pass finished: ${s.blocksDone.toLocaleString()} blocks, ${s.observations.toLocaleString()} observations.`,
      );
    } catch (e) {
      toast.error(`Grid crawl stopped: ${(e as Error)?.message ?? "unknown error"}`);
    }
  };

  return (
    <section className="rounded-lg border bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">BPUT census</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Walks a registration-number range and stores anonymous observations only: batch year,
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
        <span className="font-medium text-foreground">Two engines, one reduction.</span> The grid
        below is the measured BPUT space, committed in <code>src/lib/census-blocks.ts</code>, with
        no range to configure. <code>.github/workflows/census.yml</code> walks it with no tab open:
        add the repository secrets <code>SUPABASE_URL</code> and{" "}
        <code>SUPABASE_SERVICE_ROLE_KEY</code> and it ticks every five minutes on its own, resuming
        each block from the same saved offset. Pacing there is an aggregate request ceiling that
        ramps up and halves on any 429. The landing page follows either engine live.
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
            A run from this page needs the tab to stay open: closing it stops the crawl, and
            pressing Start again resumes from the saved offset rather than re-walking the range. For
            a crawl that survives the tab, use the scheduled workflow described above.
          </p>
        </div>
      ) : null}

      <div className="mt-6 border-t pt-5">
        <h3 className="text-sm font-semibold">Crawl the measured grid</h3>
        <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
          The whole BPUT space as measured on 2026-09-29: {grid.all.toLocaleString()} college-year
          blocks across batches 2012–2025, each declared <code>YY01CCC001</code>–
          <code>YY01CCC999</code> and abandoned after {SKIP_AFTER_MISSES} consecutive misses so a
          block costs its intake rather than its bound. Leave the years box empty to walk
          everything.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-2">
            <Label htmlFor="grid-years">Batch years</Label>
            <Input
              id="grid-years"
              placeholder="23,24,25 · empty for all"
              value={years}
              onChange={(e) => setYears(e.target.value)}
              disabled={state.running}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="grid-rps">Requests per second</Label>
            <Input
              id="grid-rps"
              type="number"
              min={1}
              max={30}
              value={gridRps}
              onChange={(e) => setGridRps(Number(e.target.value) || 8)}
              disabled={state.running}
            />
            <p className="text-xs text-muted-foreground">
              Measured tolerance: 35.6 req/s for 45 s with zero 429s. It halves itself on any 429.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="grid-workers">Workers</Label>
            <Input
              id="grid-workers"
              type="number"
              min={1}
              max={8}
              value={gridWorkers}
              onChange={(e) => setGridWorkers(Number(e.target.value) || 4)}
              disabled={state.running}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="grid-blocks">Max blocks (0 = all)</Label>
            <Input
              id="grid-blocks"
              type="number"
              min={0}
              value={gridBlocks}
              onChange={(e) => setGridBlocks(Number(e.target.value) || 0)}
              disabled={state.running}
            />
          </div>
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          Selected <strong>{grid.selected.toLocaleString()}</strong> of {grid.all.toLocaleString()}{" "}
          blocks ≈ <strong>{grid.requests.toLocaleString()}</strong> upstream requests ≈{" "}
          <strong>{formatDuration(grid.hours * 3_600_000)}</strong> at {Math.max(1, gridRps)} req/s.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => void startGrid()} disabled={state.running || grid.selected === 0}>
            Crawl the grid
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

        {state.mode === "grid" && state.gridTotal > 0 ? (
          <div className="mt-4 space-y-2">
            <Progress value={progressPct} />
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>
                <span className="text-muted-foreground">Blocks:</span>{" "}
                <strong>
                  {state.blocksDone.toLocaleString()} / {state.gridTotal.toLocaleString()}
                </strong>
              </span>
              {state.blocksSkipped > 0 ? (
                <span>
                  <span className="text-muted-foreground">Ended early:</span>{" "}
                  <strong>{state.blocksSkipped.toLocaleString()}</strong>
                </span>
              ) : null}
              <span>
                <span className="text-muted-foreground">In flight:</span>{" "}
                <strong>
                  {state.blockLabel ?? "–"} · serial {state.blockSerial}/{state.blockTotal}
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
                <span className="text-muted-foreground">Observations:</span>{" "}
                <strong>{state.observations.toLocaleString()}</strong>
              </span>
              <span>
                <span className="text-muted-foreground">Stored:</span>{" "}
                <strong>{state.stored.toLocaleString()}</strong>
              </span>
              <span>
                <span className="text-muted-foreground">Rate-limit answers:</span>{" "}
                <strong>{state.rateLimits}</strong>
              </span>
            </div>
            {state.lastError ? <p className="text-xs text-destructive">{state.lastError}</p> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
