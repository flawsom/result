// ─────────────────────────────────────────────────────────────────────────────
// University panels — the half of the BPUT Results Intelligence dashboard that
// describes the university rather than this website.
//
// These three panels draw on the measured census grid (`@/lib/intake-stats` over
// `@/lib/census-blocks`) instead of on this deployment's own lookup telemetry,
// and they are the reason the two data domains are labelled separately on the
// page: a figure in here is a property of the university's numbering, and a
// figure in panels 04+ is a property of traffic this site served. Mixing the two
// silently is the mistake this split exists to prevent.
//
// Nothing here invents a number. The intake figures come from probing all 1,103
// college-and-year ranges for their highest live registration number; the
// coverage figures come from the live census counters; and every estimate says
// so in the panel that shows it.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, type ReactNode } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  MEASURED_AT,
  MEASURED_BLOCKS,
  MEASURED_HOLE_RATE,
  MEASURED_SERIALS,
} from "@/lib/census-blocks";
import type {
  BlockDistribution,
  CensusAcquisition,
  IntakeRow,
  IntakeSeries,
} from "@/lib/intake-stats";
import { fmtCompact, fmtDayShort, fmtInt, fmtPct, fmtSignedPct } from "@/lib/analytics-stats";

/** A `yyyy-mm-dd` date from the database, printed the way the rest of the page is. */
const fmtDayStr = (iso: string): string => fmtDayShort(iso);
import {
  ACCENT,
  EmptyPanel,
  KpiTile,
  LinkChip,
  MeterRow,
  PanelCard,
  StatBox,
  type AcquisitionLink,
} from "@/components/analytics/panels";

const OK = "oklch(0.55 0.18 145)";
const WARN = "oklch(0.72 0.19 65)";
const FAIL = "oklch(0.58 0.24 27)";

/* ─────────────────────────────────────────── 01 · measured intake by year ── */

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

function IntakeTooltip({ active, payload }: TooltipInjected) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload as unknown as IntakeRow | undefined;
  if (!row) return null;
  const yoy = row.yoy === null ? null : fmtSignedPct(row.yoy * 100);
  return (
    <div className="border-thick bg-background p-3 font-mono text-[11px] leading-relaxed">
      <div className="font-bold uppercase">Batch {row.year}</div>
      <div>
        students <span className="font-bold tabular-nums">{fmtInt(row.students)}</span>
      </div>
      <div className="text-muted-foreground">
        {fmtInt(row.serials)} numbers, {fmtInt(row.holes)} holes ({fmtPct(row.holeRate, 2)})
      </div>
      <div className="text-muted-foreground">
        {fmtInt(row.blocks)} colleges · {row.meanCollege.toFixed(1)} avg · median{" "}
        {fmtInt(row.medianCollege)} · largest {fmtInt(row.maxCollege)}
      </div>
      <div className="text-muted-foreground">
        {fmtPct(row.share, 1)} of the grid{yoy === null ? "" : ` · ${yoy} year on year`}
      </div>
    </div>
  );
}

/**
 * The intake chart.
 *
 * Bars are students per batch year, measured rather than sampled. The dashed
 * line is a centred three-year mean, because a raw 14-point series reads as
 * noise; the amber line is average students per college on its own axis, which
 * is what separates a shrinking system from colleges that merely look smaller.
 */
export function IntakePanel({ series }: { series: IntakeSeries }) {
  const collegeAxis = Math.ceil(Math.max(10, ...series.rows.map((r) => r.meanCollege)) * 1.25);
  const largestCollege = Math.max(...series.rows.map((r) => r.maxCollege));

  return (
    <PanelCard
      index="01"
      title="Measured intake by batch year"
      meta={`${series.rows.length} batch years · ${fmtInt(MEASURED_BLOCKS)} colleges probed ${MEASURED_AT}`}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label="Students in the grid"
          value={series.totalStudents}
          sub={
            <span className="text-muted-foreground">
              {fmtInt(series.totalSerials)} numbers − {fmtInt(series.totalHoles)} holes
            </span>
          }
          sample={`measured ${MEASURED_AT} · probed, not sampled`}
        />
        <KpiTile
          label="Peak intake"
          value={series.peak.students}
          sub={
            <span className="text-muted-foreground">
              {series.peak.year} · {fmtInt(series.peak.blocks)} colleges ·{" "}
              {series.peak.meanCollege.toFixed(1)} avg
            </span>
          }
          sample="largest cohort on record"
        />
        <KpiTile
          label="Trough intake"
          value={series.trough.students}
          accent={WARN}
          sub={
            <span style={{ color: OK }}>
              {fmtSignedPct((series.recovery ?? 0) * 100)} by {series.last.year}
            </span>
          }
          sample={`the ${series.trough.year} intake`}
        />
        <KpiTile
          label={`${series.rows.length - 1}-year change`}
          value={series.netChange * 100}
          unit="%"
          sub={
            <span className="text-muted-foreground">
              CAGR {fmtSignedPct(series.growth ?? 0)}/yr · Theil–Sen {fmtInt(series.robustSlope)}/yr
            </span>
          }
          sample={`mean year ${fmtInt(series.meanStudents)} · OLS ${series.fit.slope.toFixed(
            1,
          )} students/yr · R² ${series.fit.r2.toFixed(2)}`}
        />
      </div>

      <div className="border-thick mt-4 h-72 w-full bg-muted/30">
        <ResponsiveContainer>
          <ComposedChart data={series.rows} margin={{ top: 16, right: 4, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="2 4" strokeOpacity={0.3} vertical={false} />
            <XAxis
              dataKey="year"
              interval={0}
              tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
              axisLine={{ stroke: "currentColor" }}
              tickLine={false}
            />
            <YAxis
              yAxisId="students"
              width={44}
              tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
              tickFormatter={fmtCompact}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              yAxisId="college"
              orientation="right"
              width={34}
              domain={[0, collegeAxis]}
              tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              content={<IntakeTooltip />}
              cursor={{ stroke: "currentColor", strokeDasharray: "3 3" }}
            />
            <Bar yAxisId="students" dataKey="students" fill={ACCENT} isAnimationActive={false} />
            <Line
              yAxisId="students"
              type="monotone"
              dataKey="trend3"
              stroke="var(--foreground)"
              strokeWidth={1.5}
              strokeDasharray="5 3"
              dot={false}
              isAnimationActive={false}
            />
            <Line
              yAxisId="college"
              type="monotone"
              dataKey="meanCollege"
              stroke={WARN}
              strokeWidth={1.6}
              dot={{ r: 2 }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="label-micro mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-4" style={{ background: ACCENT }} /> students per
          batch year
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-[2px] w-4 bg-foreground" /> centred 3-year mean
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-[2px] w-4" style={{ background: WARN }} /> students per
          college · right axis
        </span>
      </div>

      <div className="border-thick mt-4 overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse font-mono text-[11px]">
          <thead>
            <tr className="bg-foreground text-background">
              <IntakeTh align="left">Batch</IntakeTh>
              <IntakeTh>Colleges</IntakeTh>
              <IntakeTh>Numbers</IntakeTh>
              <IntakeTh>Students</IntakeTh>
              <IntakeTh>Avg / college</IntakeTh>
              <IntakeTh>Median college</IntakeTh>
              <IntakeTh>Largest</IntakeTh>
              <IntakeTh>Δ prior</IntakeTh>
            </tr>
          </thead>
          <tbody>
            {series.rows.map((row) => (
              <tr key={row.year} className="border-t border-foreground">
                <td className="px-3 py-1.5 font-bold tabular-nums">{row.year}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtInt(row.blocks)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtInt(row.serials)}</td>
                <td className="px-3 py-1.5 text-right font-bold tabular-nums">
                  {fmtInt(row.students)}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {row.meanCollege.toFixed(1)}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtInt(row.medianCollege)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtInt(row.maxCollege)}</td>
                <td
                  className="px-3 py-1.5 text-right tabular-nums"
                  style={{
                    color: row.yoy === null ? undefined : row.yoy >= 0 ? OK : FAIL,
                  }}
                >
                  {row.yoy === null ? "—" : fmtSignedPct(row.yoy * 100)}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-foreground bg-muted/40 font-bold">
              <td className="px-3 py-2">All</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtInt(MEASURED_BLOCKS)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtInt(series.totalSerials)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtInt(series.totalStudents)}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {(series.totalStudents / MEASURED_BLOCKS).toFixed(1)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">—</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtInt(largestCollege)}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {fmtSignedPct(series.netChange * 100)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
        Method. Every one of the {fmtInt(MEASURED_BLOCKS)} college-and-year ranges was probed for
        its highest live registration number on {MEASURED_AT} — a binary search for the first miss,
        with a gap-arbitration window above it, about 17 requests per range. Numbers are what the
        grid declares; students remove the holes found by walking 22 of those ranges serial by
        serial ({fmtPct(MEASURED_HOLE_RATE.before2015, 1)} of serials below the maximum in
        2012–2014, {fmtPct(MEASURED_HOLE_RATE.from2015, 2)} from 2015 on). Intake describes the
        records the portal still answers for: a measured snapshot of a population, never an
        admission roll.
      </p>
    </PanelCard>
  );
}

function IntakeTh({
  children,
  align = "right",
}: {
  children: ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={
        align === "left" ? "label-micro px-3 py-2 text-left" : "label-micro px-3 py-2 text-right"
      }
      style={{ color: "var(--background)" }}
    >
      {children}
    </th>
  );
}

/* ────────────────────────────────────── 02 · how intake sits across colleges ─ */

/**
 * The shape of one college's intake, not the total.
 *
 * A mean college is meaningless when the median is a third of it, so this panel
 * puts the distribution next to the average: quartiles, a histogram of college
 * size, and a Lorenz curve with its Gini. All of it is computed from the 1,103
 * per-block readings, so it cannot disagree with panel 01.
 */
export function BlockDistributionPanel({ dist }: { dist: BlockDistribution }) {
  const maxBin = Math.max(1, ...dist.bins.map((b) => b.blocks));
  const lorenzPath = useMemo(
    () =>
      dist.lorenz.map((p) => `${(p.x * 100).toFixed(2)},${(100 - p.y * 100).toFixed(2)}`).join(" "),
    [dist],
  );
  const quantiles: Array<[string, number]> = [
    ["p10", dist.p10],
    ["p25", dist.p25],
    ["median", dist.median],
    ["p75", dist.p75],
    ["p90", dist.p90],
    ["p99", dist.p99],
  ];

  return (
    <PanelCard
      index="02"
      title="College size across the grid"
      meta={`n = ${fmtInt(dist.n)} measured colleges · ${fmtInt(dist.tiny)} under 11`}
      style={{ animationDelay: "60ms" }}
    >
      {/* Two across, never four: this panel is half the page, so a four-up row
          would leave each tile ~78px of usable width — narrower than the
          figures it has to hold. */}
      <div className="grid grid-cols-2 gap-3">
        <StatBox
          label="Median college"
          value={fmtInt(dist.median)}
          note={`p25 ${fmtInt(dist.p25)} · p75 ${fmtInt(dist.p75)}`}
        />
        <StatBox
          label="Mean college"
          value={dist.mean.toFixed(1)}
          note={`max ${fmtInt(dist.max)}`}
        />
        <StatBox label="Gini" value={dist.gini.toFixed(3)} note="0 even → 1 all in one" />
        <StatBox
          label="Top decile share"
          value={fmtPct(dist.topDecileShare, 0)}
          note="of the grid's numbers"
          accent={ACCENT}
        />
      </div>

      <div className="mt-4 space-y-2">
        {dist.bins.map((bin) => (
          <div key={bin.label} className="an-branch-row">
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 font-mono text-[11px]">
              <span className="font-bold uppercase tabular-nums">{bin.label}</span>
              <span className="tabular-nums">
                {fmtInt(bin.blocks)} colleges{" "}
                <span className="text-muted-foreground">· {fmtInt(bin.numbers)} numbers</span>
              </span>
            </div>
            <div className="relative h-3 w-full bg-muted">
              <div
                className="absolute inset-y-0 left-0"
                style={{ width: `${(bin.blocks / maxBin) * 100}%`, background: ACCENT }}
                title={`${fmtInt(bin.blocks)} colleges hold ${fmtInt(bin.numbers)} numbers`}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-start gap-4">
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
        <div className="min-w-64 flex-1 font-mono text-[11px] leading-relaxed text-muted-foreground">
          <p>
            Highest live serial per college, ordered smallest to largest, against a perfectly even
            system (dashed diagonal). The gap between the two is the Gini above; a system where
            every college held the same intake would sit on the diagonal.
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {quantiles.map(([label, value]) => (
              <span key={label}>
                <span className="label-caps">{label}</span>{" "}
                <span className="tabular-nums text-foreground">{fmtInt(value)}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <div className="label-caps text-muted-foreground">Largest colleges measured</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {dist.top.map((block) => (
            <span key={block.label} className="border-thin px-2 py-1 font-mono text-[10px]">
              {block.label} <span className="font-bold tabular-nums">{fmtInt(block.serial)}</span>
            </span>
          ))}
        </div>
      </div>

      <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
        A college's value here is the highest serial the portal answered for in that batch year, so
        it is an upper bound on what the college admitted — deliberately so, because the serial is
        the only intake signal the portal exposes. Colleges that never got past ten serials (
        {fmtInt(dist.tiny)} of {fmtInt(dist.n)}) are drawn where they fall rather than filtered out;
        several of them are codes that opened in one batch year and never ran again.
      </p>
    </PanelCard>
  );
}

/* ──────────────────────────────────────────── 03 · is the crawl reading it ─ */

/**
 * Coverage of a measured universe, which is a rare thing to be able to say.
 *
 * Most progress bars divide by an estimate. This one divides by 160,609
 * registration numbers that were counted block by block, so "2% read" means two
 * per cent of a number somebody verified rather than two per cent of a guess.
 * The live row is preferred over the last aggregate read wherever the two
 * overlap, because the database writes it in the same transaction as the batch.
 */
export function CensusAcquisitionPanel({
  acquisition: a,
  link,
}: {
  acquisition: CensusAcquisition;
  link: AcquisitionLink;
}) {
  // Share of the live budget spent. The budget is spent + outstanding, so this
  // rises as the crawl works and falls back when a new publication adds work —
  // which is the truthful shape of "how far through are we".
  const budgetShare = a.budget > 0 ? a.readsSpent / a.budget : 0;

  return (
    <PanelCard
      index="03"
      title="Census coverage & yield"
      meta={<LinkChip link={link} />}
      style={{ animationDelay: "120ms" }}
    >
      {!a.reported ? (
        <EmptyPanel
          headline="No census counters yet"
          detail="The crawl has not stored a batch and has not probed a number, so there is nothing measured here to draw. This panel fills from the first flush — it is not waiting on a seed or a model."
        />
      ) : (
        <>
          {/* Two across at every width: this panel is half the page, so the four
              figures read as a 2×2 block rather than four ~78px columns. */}
          <div className="grid grid-cols-2 gap-3">
            <KpiTile
              label="Numbers probed"
              value={a.visited}
              sub={
                <span className="text-muted-foreground">
                  {fmtInt(a.found)} students · {fmtInt(a.notFound)} absent
                </span>
              }
              sample={`${fmtPct(a.probeCoverage, 2)} of the measured grid`}
            />
            <KpiTile
              label="Observations stored"
              value={a.observations}
              sub={
                <span className="text-muted-foreground">
                  {a.yieldPerProbe.toFixed(1)} per number probed
                </span>
              }
              sample="one anonymous row per student-semester"
            />
            <KpiTile
              label="Ranges read end to end"
              value={a.doneRanges}
              sub={
                <span className="text-muted-foreground">
                  {fmtInt(a.ranges)} declared ranges opened
                </span>
              }
              sample={`of ${fmtInt(MEASURED_BLOCKS)} measured`}
            />
            <KpiTile
              label="Reads left, estimated"
              value={a.readsLeft}
              format={fmtCompact}
              unit="reads"
              sub={
                <span className="text-muted-foreground">
                  of {fmtCompact(a.budget)} budgeted so far
                </span>
              }
              sample={
                a.ledger
                  ? "spent + outstanding · derived from the live ledger"
                  : "baseline measurement · ledger not applied yet"
              }
            />
          </div>

          {/*
            What the one number above is made of. The census does not finish: a
            batch year that answered for six semesters will answer for seven, and
            that seventh term has to be read. Splitting the total says so, and says
            why keeping the record current is cheap — a maintenance pass reads the
            record and the one new term, never the terms already captured.
          */}
          <div className="mt-3 grid gap-3 min-[420px]:grid-cols-2">
            <div className="border-thin min-w-0 p-3">
              <div className="label-micro text-muted-foreground">First pass left</div>
              <div className="font-mono text-[11px] leading-snug tabular-nums">
                {fmtCompact(a.firstPassReadsLeft)} reads · {fmtInt(a.serialsLeft)} serials never
                read
              </div>
            </div>
            <div className="border-thin min-w-0 p-3">
              <div className="label-micro text-muted-foreground">Keeping it current</div>
              <div className="font-mono text-[11px] leading-snug tabular-nums">
                {fmtCompact(a.maintenanceReads)} reads · {fmtInt(a.passesPending)} semester pass(
                {a.passesPending === 1 ? "" : "es"}) pending
              </div>
            </div>
          </div>

          <div className="mt-4 space-y-3">
            <MeterRow
              label="Probe coverage"
              value={a.visited}
              max={MEASURED_SERIALS}
              right={`${fmtPct(a.probeCoverage, 2)} · ${fmtInt(a.visited)}/${fmtInt(MEASURED_SERIALS)}`}
              title={`${fmtInt(a.visited)} of ${fmtInt(MEASURED_SERIALS)} declared numbers probed`}
            />
            <MeterRow
              label="Ranges complete"
              value={a.doneRanges}
              max={MEASURED_BLOCKS}
              right={`${fmtPct(a.rangeCoverage, 1)} · ${fmtInt(a.doneRanges)}/${fmtInt(MEASURED_BLOCKS)}`}
              title={`${fmtInt(a.doneRanges)} of ${fmtInt(MEASURED_BLOCKS)} ranges read end to end`}
              accent={OK}
            />
            <MeterRow
              label="Read budget"
              value={a.readsSpent}
              max={a.budget}
              right={`${fmtPct(budgetShare, 2)} · ${fmtCompact(a.readsSpent)}/${fmtCompact(a.budget)}`}
              title={`${fmtInt(a.readsSpent)} reads spent against a ${fmtInt(a.budget)} budget: spent plus outstanding, recomputed as the work is measured`}
              accent={WARN}
            />
          </div>

          <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
            Coverage has a real denominator because the universe was measured:{" "}
            {fmtInt(MEASURED_SERIALS)} registration numbers across {fmtInt(MEASURED_BLOCKS)}{" "}
            college-and-year ranges. Reads spent is arithmetic rather than a model — one details
            probe per number plus one read per stored semester row — and it reproduces the request
            count of the last recorded crawl slice exactly. An observation is one student-semester
            and never a person: the registration number is dropped before anything is written, and
            published cells are pooled at 25.
          </p>

          {/*
            The part a reader is right to ask about: this is not a one-off. A block
            that has been read is not finished with — BPUT publishes on a rolling
            window, so 2023 will answer for semester 7 after it has answered for six
            — and the number above has to move when that happens rather than
            counting down to zero and staying there.
          */}
          <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
            The census does not end, so this figure is not a countdown. Every slice publishes the
            current measurement and re-asks the portal which sessions each batch year answers for
            {a.watchCheckedAt ? ` (last checked ${fmtDayStr(a.watchCheckedAt)})` : ""}; a session a
            block has not captured becomes work by itself, and the budget is spent plus outstanding,
            so it rises on the day the portal publishes something new. Only the new term is read —
            two requests per student, the record and that one semester — and a semester the portal
            has already published is never read twice, because the pass that read it is recorded
            before it is repeated. A semester the portal serves but nobody has passed yet is
            re-checked monthly rather than assumed, because results are published in batches. The
            same daily job re-sweeps the grid itself, so a batch year the portal has just begun
            numbering and a college that has opened a batch become work here without an edit. What
            none of it can see is a session the portal has not started serving at all, or a college
            whose very first student never registered; nothing here invents either.
          </p>
        </>
      )}
    </PanelCard>
  );
}
