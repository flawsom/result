// "What SGPA do I need next semester to hit a target CGPA?"
// Client-only. Operates entirely on already-fetched real data — no network,
// no synthetic inputs. Only shown after ≥1 real semester is loaded.
import { useMemo, useState } from "react";

export function ReverseSgpaCalc({
  currentCgpa,
  totalCredits,
}: {
  currentCgpa: number;
  totalCredits: number;
}) {
  const [target, setTarget] = useState<string>(Math.min(10, currentCgpa + 0.5).toFixed(2));
  const [nextCredits, setNextCredits] = useState<string>("22");

  const result = useMemo(() => {
    const t = Number(target);
    const c = Number(nextCredits);
    if (!Number.isFinite(t) || t <= 0 || t > 10) return null;
    if (!Number.isFinite(c) || c <= 0) return null;
    // ((totalCredits + c) * t - totalCredits * currentCgpa) / c
    const needed = ((totalCredits + c) * t - totalCredits * currentCgpa) / c;
    return {
      needed: Math.round(needed * 100) / 100,
      feasible: needed <= 10 && needed >= 0,
      unreachable: needed > 10,
      trivial: needed < 0,
    };
  }, [target, nextCredits, currentCgpa, totalCredits]);

  return (
    <div className="border-heavy bg-background p-6">
      <div className="label-caps">Reverse calculator · client-only</div>
      <div className="font-display mt-1 text-2xl">What SGPA do I need next?</div>
      <p className="mt-2 font-mono text-xs text-muted-foreground">
        Uses your real CGPA ({currentCgpa.toFixed(2)}) across {totalCredits} credits. No network,
        nothing sent anywhere.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="label-caps">Target CGPA</span>
          <input
            type="number"
            step="0.01"
            min="0"
            max="10"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="border-thick mt-2 block w-full bg-background px-3 py-2 font-mono text-lg outline-none focus:bg-muted"
          />
        </label>
        <label className="block">
          <span className="label-caps">Next-sem credits</span>
          <input
            type="number"
            step="1"
            min="1"
            max="60"
            value={nextCredits}
            onChange={(e) => setNextCredits(e.target.value)}
            className="border-thick mt-2 block w-full bg-background px-3 py-2 font-mono text-lg outline-none focus:bg-muted"
          />
        </label>
      </div>
      <div className="border-thick mt-4 bg-foreground p-4 text-background">
        {!result ? (
          <div className="font-mono text-sm">Enter valid target and credits.</div>
        ) : result.trivial ? (
          <div className="font-mono text-sm">
            You're already above this target — even a 0 next semester keeps you at or above {target}
            .
          </div>
        ) : result.unreachable ? (
          <div>
            <div className="label-caps opacity-70">Not reachable in one semester</div>
            <div className="font-display mt-1 text-3xl">
              Needed SGPA: {result.needed.toFixed(2)}
            </div>
            <div className="mt-1 font-mono text-xs opacity-80">Max possible SGPA is 10.00.</div>
          </div>
        ) : (
          <div>
            <div className="label-caps opacity-70">Needed next-sem SGPA</div>
            <div className="font-display mt-1 text-5xl">{result.needed.toFixed(2)}</div>
          </div>
        )}
      </div>
    </div>
  );
}
