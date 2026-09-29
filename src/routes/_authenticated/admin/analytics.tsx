// Analytics dashboard over cached bulk results. All computation runs
// client-side against IndexedDB, no server aggregation, no PII leaves the
// admin's browser. Filter by batch (or across all batches).
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { bulkDB, type BulkBatch, type BulkJob } from "@/lib/bulk/db";
import {
  branchStats,
  cgpaValues,
  computeJobStats,
  gradeCounts,
  histogram,
  sgpaValues,
  subjectStats,
  topStudents,
  type BranchStat,
} from "@/lib/bulk/analytics";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { type Grade } from "@/lib/sgpa";

export const Route = createFileRoute("/_authenticated/admin/analytics")({
  head: () => ({
    meta: [{ title: "Analytics · BPUT Admin" }, { name: "robots", content: "noindex" }],
  }),
  component: AnalyticsPage,
});

const GRADE_COLORS: Record<Grade, string> = {
  O: "#0f766e",
  E: "#0d9488",
  A: "#14b8a6",
  B: "#5eead4",
  C: "#fcd34d",
  D: "#fb923c",
  F: "#dc2626",
  M: "#991b1b",
  S: "#7f1d1d",
};

function AnalyticsPage() {
  const [batchId, setBatchId] = useState<string>("all");

  const batches = useLiveQuery(() => bulkDB.batches.orderBy("createdAt").reverse().toArray(), []);

  const jobs = useLiveQuery<BulkJob[]>(async () => {
    if (batchId === "all") return bulkDB.jobs.toArray();
    return bulkDB.jobs.where("batchId").equals(batchId).toArray();
  }, [batchId]);

  const stats = useMemo(() => (jobs ? computeJobStats(jobs) : null), [jobs]);
  const cgpas = useMemo(() => (jobs ? cgpaValues(jobs) : []), [jobs]);
  const sgpas = useMemo(() => (jobs ? sgpaValues(jobs) : []), [jobs]);
  const grades = useMemo(() => (jobs ? gradeCounts(jobs) : []), [jobs]);
  const branches = useMemo(() => (jobs ? branchStats(jobs) : []), [jobs]);
  const subjects = useMemo(() => (jobs ? subjectStats(jobs) : []), [jobs]);
  const top = useMemo(() => (jobs ? topStudents(jobs, 10) : []), [jobs]);

  const cgpaHist = useMemo(() => histogram(cgpas, 0, 10, 10), [cgpas]);
  const sgpaHist = useMemo(() => histogram(sgpas, 0, 10, 10), [sgpas]);

  const hasData = stats && stats.withResults > 0;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Analytics</h2>
          <p className="text-xs text-muted-foreground">
            Computed live from cached results in your browser. No data leaves this device.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/admin">Back to batches</Link>
          </Button>
          <Select value={batchId} onValueChange={setBatchId}>
            <SelectTrigger className="h-9 w-64 text-xs">
              <SelectValue placeholder="Select scope" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All batches</SelectItem>
              {(batches ?? []).map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.label} ({b.total})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      {!jobs ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !hasData ? (
        <EmptyState hasBatches={(batches ?? []).length > 0} />
      ) : (
        <>
          <SummaryCards stats={stats!} />
          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard title="CGPA distribution" subtitle={`${cgpas.length} students`}>
              <Histogram data={cgpaHist} color="#2563eb" />
            </ChartCard>
            <ChartCard title="SGPA distribution" subtitle={`${sgpas.length} semester results`}>
              <Histogram data={sgpaHist} color="#0d9488" />
            </ChartCard>
            <ChartCard
              title="Grade mix"
              subtitle={`${grades.reduce((s, g) => s + g.count, 0)} subject attempts`}
            >
              <GradePie data={grades} />
            </ChartCard>
            <ChartCard
              title="Branch comparison"
              subtitle={`${branches.length} branch${branches.length === 1 ? "" : "es"}`}
            >
              <BranchBars data={branches} />
            </ChartCard>
          </div>

          <TwoColTable
            left={<SubjectFailureTable rows={subjects} />}
            right={<TopStudentsTable rows={top} />}
          />
        </>
      )}
    </div>
  );
}

function EmptyState({ hasBatches }: { hasBatches: boolean }) {
  return (
    <section className="rounded-lg border border-dashed p-10 text-center">
      <h3 className="text-sm font-semibold">Nothing to analyze yet</h3>
      <p className="mt-2 text-xs text-muted-foreground">
        {hasBatches
          ? "The selected batch has no completed jobs. Run or resume a batch, then come back."
          : "Create and run a batch first from the admin dashboard."}
      </p>
      <div className="mt-4">
        <Button size="sm" asChild>
          <Link to="/admin">Go to batches</Link>
        </Button>
      </div>
    </section>
  );
}

function SummaryCards({ stats }: { stats: NonNullable<ReturnType<typeof computeJobStats>> }) {
  const items = [
    { label: "Students with results", value: stats.withResults.toLocaleString() },
    { label: "Queued/total jobs", value: stats.total.toLocaleString() },
    {
      label: "Average CGPA",
      value: stats.avgCgpa !== null ? stats.avgCgpa.toFixed(2) : "–",
    },
    {
      label: "Median CGPA",
      value: stats.medianCgpa !== null ? stats.medianCgpa.toFixed(2) : "–",
    },
    {
      label: "Average SGPA",
      value: stats.avgSgpa !== null ? stats.avgSgpa.toFixed(2) : "–",
    },
    {
      label: "Subject pass rate",
      value: `${(stats.passRate * 100).toFixed(1)}%`,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {items.map((it) => (
        <div key={it.label} className="rounded-lg border bg-card p-3">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {it.label}
          </p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{it.value}</p>
        </div>
      ))}
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        {subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
      </div>
      <div className="h-64 w-full">{children}</div>
    </section>
  );
}

function Histogram({ data, color }: { data: ReturnType<typeof histogram>; color: string }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: -8 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
        <XAxis dataKey="label" tick={{ fontSize: 10 }} />
        <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
        <Tooltip
          contentStyle={{
            background: "var(--color-background, #fff)",
            border: "1px solid var(--color-border, #ddd)",
            fontSize: 12,
          }}
        />
        <Bar dataKey="count" fill={color} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function GradePie({ data }: { data: Array<{ grade: Grade; count: number; points: number }> }) {
  const chart = data.map((d) => ({
    name: `${d.grade} (${d.points})`,
    grade: d.grade,
    value: d.count,
  }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={chart}
          dataKey="value"
          nameKey="name"
          innerRadius={45}
          outerRadius={85}
          stroke="var(--color-background)"
          strokeWidth={2}
          label={({ name, value }) => `${name}: ${value}`}
          labelLine={false}
        >
          {chart.map((d) => (
            <Cell key={d.grade} fill={GRADE_COLORS[d.grade]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{
            background: "var(--color-background, #fff)",
            border: "1px solid var(--color-border, #ddd)",
            fontSize: 12,
          }}
        />
        <Legend wrapperStyle={{ fontSize: 10 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

function BranchBars({ data }: { data: BranchStat[] }) {
  const chart = data.slice(0, 12).map((b) => ({
    name: b.branch.length > 18 ? b.branch.slice(0, 16) + "…" : b.branch,
    avgCgpa: b.avgCgpa,
    students: b.students,
  }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={chart} margin={{ top: 8, right: 8, bottom: 40, left: -8 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
        <XAxis dataKey="name" tick={{ fontSize: 9 }} angle={-30} textAnchor="end" interval={0} />
        <YAxis tick={{ fontSize: 10 }} domain={[0, 10]} />
        <Tooltip
          contentStyle={{
            background: "var(--color-background, #fff)",
            border: "1px solid var(--color-border, #ddd)",
            fontSize: 12,
          }}
        />
        <Bar dataKey="avgCgpa" fill="#7c3aed" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function TwoColTable({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {left}
      {right}
    </div>
  );
}

function SubjectFailureTable({ rows }: { rows: ReturnType<typeof subjectStats> }) {
  return (
    <section className="rounded-lg border bg-card">
      <div className="border-b p-4">
        <h3 className="text-sm font-semibold">Toughest subjects</h3>
        <p className="text-xs text-muted-foreground">
          Highest failure rate (F/M/S), min 3 attempts.
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="p-6 text-center text-xs text-muted-foreground">No qualifying subjects yet.</p>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted text-left">
              <tr>
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2">Subject</th>
                <th className="px-3 py-2 text-right">Attempts</th>
                <th className="px-3 py-2 text-right">Failures</th>
                <th className="px-3 py-2 text-right">Fail rate</th>
                <th className="px-3 py-2 text-right">Avg points</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.code} className="border-t">
                  <td className="px-3 py-1.5 font-mono">{r.code}</td>
                  <td className="px-3 py-1.5">{r.name}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.attempts}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.failures}</td>
                  <td className="px-3 py-1.5 text-right">
                    <Badge variant={r.failureRate > 0.2 ? "destructive" : "secondary"}>
                      {(r.failureRate * 100).toFixed(1)}%
                    </Badge>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.avgPoints}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function TopStudentsTable({ rows }: { rows: BulkJob[] }) {
  return (
    <section className="rounded-lg border bg-card">
      <div className="border-b p-4">
        <h3 className="text-sm font-semibold">Top students</h3>
        <p className="text-xs text-muted-foreground">Ranked by CGPA across fetched semesters.</p>
      </div>
      {rows.length === 0 ? (
        <p className="p-6 text-center text-xs text-muted-foreground">Nothing to rank yet.</p>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted text-left">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Reg no</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Branch</th>
                <th className="px-3 py-2 text-right">CGPA</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((j, i) => (
                <tr key={j.id} className="border-t">
                  <td className="px-3 py-1.5 tabular-nums text-muted-foreground">{i + 1}</td>
                  <td className="px-3 py-1.5 font-mono">{j.rollNo}</td>
                  <td className="px-3 py-1.5">{j.student?.studentName ?? "–"}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">
                    {j.student?.branchName ?? "–"}
                  </td>
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                    {j.cgpa?.toFixed(2) ?? "–"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
