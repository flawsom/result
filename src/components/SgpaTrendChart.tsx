// SGPA per real semester + running CGPA overlay. Only rendered when at least
// one real semester has been fetched. No synthetic data.
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SubjectsResponse } from "@/lib/sgpa";

interface TrendPoint {
  semId: string;
  label: string;
  sgpa: number;
  cgpa: number;
}

function buildTrend(semesters: Array<{ semId: string; data: SubjectsResponse }>): TrendPoint[] {
  const pts: TrendPoint[] = [];
  let num = 0;
  let den = 0;
  for (const s of semesters) {
    const sg = Number(s.data.sgpadetails.sgpa);
    const cr = Number(s.data.sgpadetails.cretits);
    if (!Number.isFinite(sg) || !Number.isFinite(cr) || cr <= 0) continue;
    num += sg * cr;
    den += cr;
    pts.push({
      semId: s.semId,
      label: s.data.grades[0]?.semester ?? `Sem ${s.semId}`,
      sgpa: Math.round(sg * 100) / 100,
      cgpa: Math.round((num / den) * 100) / 100,
    });
  }
  return pts;
}

export function SgpaTrendChart({
  semesters,
}: {
  semesters: Array<{ semId: string; data: SubjectsResponse }>;
}) {
  const data = buildTrend(semesters);
  if (data.length === 0) return null;

  return (
    <div className="border-heavy bg-background p-6">
      <div className="label-caps mb-1">Trend</div>
      <div className="font-display text-2xl">SGPA / CGPA · per semester</div>
      <div className="mt-4 h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: -8 }}>
            <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
            <XAxis
              dataKey="label"
              stroke="var(--color-foreground)"
              tick={{ fontFamily: "var(--font-mono, monospace)", fontSize: 11 }}
            />
            <YAxis
              domain={[0, 10]}
              stroke="var(--color-foreground)"
              tick={{ fontFamily: "var(--font-mono, monospace)", fontSize: 11 }}
            />
            <Tooltip
              contentStyle={{
                background: "var(--color-background)",
                border: "3px solid var(--color-foreground)",
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 12,
              }}
            />
            <Legend wrapperStyle={{ fontFamily: "var(--font-mono, monospace)", fontSize: 11 }} />
            <Line
              type="monotone"
              dataKey="sgpa"
              name="SGPA"
              stroke="var(--color-foreground)"
              strokeWidth={3}
              dot={{ r: 4 }}
              activeDot={{ r: 6 }}
            />
            <Line
              type="monotone"
              dataKey="cgpa"
              name="Running CGPA"
              stroke="var(--color-primary, #b8860b)"
              strokeWidth={2}
              strokeDasharray="6 4"
              dot={{ r: 3 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
