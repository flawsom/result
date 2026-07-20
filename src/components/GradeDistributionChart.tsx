// Aggregate grade distribution across every real fetched subject.
// No synthetic weights — just counts of what BPUT returned.
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { GRADE_POINTS, type Grade, type SubjectsResponse } from "@/lib/sgpa";

const GRADE_ORDER: Grade[] = ["O", "E", "A", "B", "C", "D", "F", "M", "S"];

// High-contrast tokens. Failing grades share the destructive color.
const COLORS: Record<Grade, string> = {
  O: "var(--color-foreground)",
  E: "#4b5563",
  A: "#6b7280",
  B: "#9ca3af",
  C: "#cbd5e1",
  D: "#e5e7eb",
  F: "var(--color-destructive, #b91c1c)",
  M: "var(--color-destructive, #b91c1c)",
  S: "var(--color-destructive, #b91c1c)",
};

export function GradeDistributionChart({
  semesters,
}: {
  semesters: Array<{ data: SubjectsResponse }>;
}) {
  const counts: Record<Grade, number> = {
    O: 0,
    E: 0,
    A: 0,
    B: 0,
    C: 0,
    D: 0,
    F: 0,
    M: 0,
    S: 0,
  };
  for (const s of semesters) {
    for (const g of s.data.grades) {
      if (g.grade in counts) counts[g.grade] += 1;
    }
  }
  const data = GRADE_ORDER.filter((g) => counts[g] > 0).map((g) => ({
    name: `${g} (${GRADE_POINTS[g]})`,
    grade: g,
    value: counts[g],
  }));
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) return null;

  return (
    <div className="border-heavy bg-background p-6">
      <div className="label-caps mb-1">Distribution</div>
      <div className="font-display text-2xl">
        Grades · {total} subject{total === 1 ? "" : "s"}
      </div>
      <div className="mt-4 h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius={60}
              outerRadius={100}
              stroke="var(--color-foreground)"
              strokeWidth={2}
              label={({ name, value }) => `${name}: ${value}`}
            >
              {data.map((d) => (
                <Cell key={d.grade} fill={COLORS[d.grade]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                background: "var(--color-background)",
                border: "3px solid var(--color-foreground)",
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 12,
              }}
            />
            <Legend wrapperStyle={{ fontFamily: "var(--font-mono, monospace)", fontSize: 11 }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
