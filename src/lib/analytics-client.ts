// Privacy-safe analytics client. Talks to two SECURITY DEFINER RPCs:
//
//  * log_result_view(year, semester, branch)  - anonymous write
//  * get_results_analytics()                  - aggregated read
//
// The RPCs only accept/return year/semester/branch counts. No roll number,
// name, DOB, or session identifier is ever transmitted. Callers must NEVER
// pass user-identifying fields even accidentally.
import { supabase } from "@/integrations/supabase/client";

export interface AnalyticsPayload {
  total: number;
  byYear: Array<{ year: number; count: number }>;
  byYearSem: Array<{ year: number; semester: number; count: number }>;
  byBranch: Array<{ branch: string; count: number }>;
  pulse24hDistinct: number;
  pulse24hTotal: number;
  updatedAt: string;
}

export async function fetchAnalytics(): Promise<AnalyticsPayload> {
  const { data, error } = await supabase.rpc("get_results_analytics");
  if (error) throw new Error(error.message);
  return data as unknown as AnalyticsPayload;
}

// Fire-and-forget. Failures never surface to the user; analytics logging
// must never disrupt the result-fetch flow.
export function logResultViews(
  events: Array<{ year: number; semester: number; branch: string }>,
): void {
  for (const ev of events) {
    void supabase
      .rpc("log_result_view", {
        _year: ev.year,
        _semester: ev.semester,
        _branch: ev.branch,
      })
      .then(({ error }) => {
        if (error) console.warn("[analytics] log failed", error.message);
      });
  }
}
