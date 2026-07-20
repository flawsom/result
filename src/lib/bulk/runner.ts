// Bulk-fetch runner. Single in-flight request at a time per browser tab.
// Honors rate limit (delay between rollNos), retries on transient errors,
// respects pause/resume/cancel, and persists progress to IndexedDB after
// every state transition so a refresh resumes cleanly.
//
// Deliberately not concurrent: the upstream BPUT server is fragile and
// concurrent requests trigger 429s and long timeouts. Serial + small delay
// is the sustainable pace.
import { bulkDB, type BulkBatch, type BulkJob } from "./db";
import { fetchStudentDetails, fetchSubjects, ERR } from "@/lib/bput.functions";
import { getSemesterAttempts, parseBatchYear } from "./sessions";
import { calculateSGPA, type SubjectsResponse } from "@/lib/sgpa";

interface RunnerState {
  batchId: string | null;
  running: boolean;
  paused: boolean;
  cancelled: boolean;
  currentRollNo: string | null;
}

const state: RunnerState = {
  batchId: null,
  running: false,
  paused: false,
  cancelled: false,
  currentRollNo: null,
};

type Listener = (s: Readonly<RunnerState>) => void;
const listeners = new Set<Listener>();
export function subscribeRunner(fn: Listener): () => void {
  listeners.add(fn);
  fn({ ...state });
  return () => listeners.delete(fn);
}
function emit() {
  const snap = { ...state };
  listeners.forEach((l) => l(snap));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitWhilePaused() {
  while (state.paused && !state.cancelled) {
    await sleep(200);
  }
}

function classifyError(msg: string): { code: string; retryable: boolean; notFound: boolean } {
  if (msg.startsWith(ERR.NOT_PUBLISHED))
    return { code: ERR.NOT_PUBLISHED, retryable: false, notFound: true };
  if (msg.startsWith(ERR.BAD_INPUT))
    return { code: ERR.BAD_INPUT, retryable: false, notFound: false };
  if (msg.startsWith(ERR.RATE_LIMITED))
    return { code: ERR.RATE_LIMITED, retryable: true, notFound: false };
  if (msg.startsWith(ERR.TIMEOUT)) return { code: ERR.TIMEOUT, retryable: true, notFound: false };
  if (msg.startsWith(ERR.UNREACHABLE))
    return { code: ERR.UNREACHABLE, retryable: true, notFound: false };
  if (msg.startsWith(ERR.UPSTREAM)) return { code: ERR.UPSTREAM, retryable: true, notFound: false };
  return { code: "UNKNOWN", retryable: true, notFound: false };
}

async function processJob(job: BulkJob, batch: BulkBatch): Promise<void> {
  await bulkDB.jobs.update(job.id, {
    status: "running",
    updatedAt: Date.now(),
  });

  let attempt = job.attempts;
  while (attempt <= batch.maxRetries) {
    if (state.cancelled) return;
    await waitWhilePaused();
    try {
      const student = await fetchStudentDetails({ data: { rollNo: job.rollNo } });
      if (!student?.rollNo) {
        await bulkDB.jobs.update(job.id, {
          status: "not_found",
          attempts: attempt + 1,
          error: "No student record",
          errorCode: ERR.NOT_PUBLISHED,
          updatedAt: Date.now(),
        });
        return;
      }

      const batchYear = parseBatchYear(student.batch);
      const attempts = batchYear ? getSemesterAttempts(batchYear) : [];
      const semesters: NonNullable<BulkJob["semesters"]> = [];
      let totalPoints = 0;
      let totalCredits = 0;
      const sgpas: number[] = [];

      for (const s of attempts) {
        if (state.cancelled) return;
        await waitWhilePaused();

        // Step 1: fetch the primary session first. If BPUT hasn't
        // published it, skip the (usually empty) back-paper probes.
        let primary: { session: string; data: SubjectsResponse } | null = null;
        let primaryError: string | null = null;
        try {
          const data: SubjectsResponse = await fetchSubjects({
            data: { rollNo: job.rollNo, semId: s.semId, session: s.primary },
          });
          if (data.grades && data.grades.length > 0) {
            primary = { session: s.primary, data };
          }
        } catch (e) {
          const msg = (e as Error).message ?? String(e);
          const cls = classifyError(msg);
          if (!cls.notFound) primaryError = msg;
        }

        // Step 2: only probe back-paper republications if the primary
        // was published — otherwise BPUT will never have re-published.
        // Fire probes in parallel; BPUT tolerates a handful.
        const collected: Array<{ session: string; data: SubjectsResponse }> = [];
        if (primary) collected.push(primary);

        if (primary && s.backAttempts.length > 0) {
          if (state.cancelled) return;
          await waitWhilePaused();
          const probes = await Promise.allSettled(
            s.backAttempts.map((session) =>
              fetchSubjects({
                data: { rollNo: job.rollNo, semId: s.semId, session },
              }).then((data) => ({ session, data })),
            ),
          );
          for (const p of probes) {
            if (p.status !== "fulfilled") continue;
            const { session, data } = p.value;
            if (data.grades && data.grades.length > 0) {
              collected.push({ session, data });
            }
          }
        }

        if (collected.length > 0) {
          // Winning attempt (used for SGPA/CGPA) is the LAST published
          // in chronological order — BPUT overwrites earlier grades.
          const winning = collected[collected.length - 1];
          const sgpa = calculateSGPA(
            winning.data.grades.map((g) => ({
              subjectCredits: Number(g.subjectCredits) || 0,
              grade: g.grade,
            })),
          );
          if (Number.isFinite(sgpa)) sgpas.push(sgpa);
          totalCredits += Number(winning.data.sgpadetails?.cretits) || 0;
          totalPoints += Number(winning.data.sgpadetails?.totalGradePoints) || 0;
          semesters.push({
            semId: s.semId,
            session: winning.session,
            status: "done",
            data: winning.data,
            attempts: collected,
          });
        } else if (primaryError) {
          semesters.push({
            semId: s.semId,
            session: s.primary,
            status: "error",
            error: primaryError,
          });
        } else {
          semesters.push({ semId: s.semId, session: s.primary, status: "empty" });
        }

        // Small pacing pause between semesters (per-student), still
        // respectful of BPUT but far faster than the previous
        // rateLimitMs-per-request cadence.
        if (!state.cancelled) await sleep(Math.min(batch.rateLimitMs, 200));
      }

      const sgpaAvg = sgpas.length
        ? Math.round((sgpas.reduce((a, b) => a + b, 0) / sgpas.length) * 100) / 100
        : undefined;
      const cgpa =
        totalCredits > 0 ? Math.round((totalPoints / totalCredits) * 100) / 100 : undefined;

      await bulkDB.jobs.update(job.id, {
        status: "done",
        attempts: attempt + 1,
        student,
        semesters,
        sgpaAvg,
        cgpa,
        error: undefined,
        errorCode: undefined,
        updatedAt: Date.now(),
      });
      return;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const cls = classifyError(msg);
      attempt += 1;

      if (cls.notFound) {
        await bulkDB.jobs.update(job.id, {
          status: "not_found",
          attempts: attempt,
          error: msg,
          errorCode: cls.code,
          updatedAt: Date.now(),
        });
        return;
      }

      if (!cls.retryable || attempt > batch.maxRetries) {
        await bulkDB.jobs.update(job.id, {
          status: "failed",
          attempts: attempt,
          error: msg,
          errorCode: cls.code,
          updatedAt: Date.now(),
        });
        return;
      }

      // Back off longer on rate limits.
      const backoff = cls.code === ERR.RATE_LIMITED ? 5_000 : 1_000 * attempt;
      await sleep(backoff);
    }
  }
}

export async function runBatch(batchId: string): Promise<void> {
  if (state.running) return;
  const batch = await bulkDB.batches.get(batchId);
  if (!batch) return;

  state.batchId = batchId;
  state.running = true;
  state.paused = batch.state === "paused";
  state.cancelled = false;
  emit();

  await bulkDB.batches.update(batchId, {
    state: state.paused ? "paused" : "running",
    updatedAt: Date.now(),
  });

  try {
    while (!state.cancelled) {
      await waitWhilePaused();
      if (state.cancelled) break;
      const next = await bulkDB.jobs.where("[batchId+status]").equals([batchId, "queued"]).first();
      if (!next) break;
      state.currentRollNo = next.rollNo;
      emit();
      const freshBatch = (await bulkDB.batches.get(batchId)) ?? batch;
      await processJob(next, freshBatch);
      if (!state.cancelled) await sleep(freshBatch.rateLimitMs);
    }

    const remaining = await bulkDB.jobs
      .where("[batchId+status]")
      .equals([batchId, "queued"])
      .count();

    await bulkDB.batches.update(batchId, {
      state: state.cancelled ? "cancelled" : remaining > 0 ? "paused" : "completed",
      updatedAt: Date.now(),
    });
  } finally {
    state.running = false;
    state.currentRollNo = null;
    state.batchId = null;
    emit();
  }
}

export function pause() {
  state.paused = true;
  emit();
  if (state.batchId) {
    bulkDB.batches.update(state.batchId, { state: "paused", updatedAt: Date.now() });
  }
}
export function resume() {
  state.paused = false;
  emit();
  if (state.batchId) {
    bulkDB.batches.update(state.batchId, { state: "running", updatedAt: Date.now() });
  }
}
export function cancel() {
  state.cancelled = true;
  state.paused = false;
  emit();
}
export function getRunnerState(): Readonly<RunnerState> {
  return { ...state };
}

export async function createBatch(input: {
  label: string;
  rollNos: string[];
  start: string;
  end: string;
  rateLimitMs: number;
  maxRetries: number;
}): Promise<string> {
  const id = `b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const batch: BulkBatch = {
    id,
    label: input.label,
    start: input.start,
    end: input.end,
    total: input.rollNos.length,
    state: "running",
    rateLimitMs: input.rateLimitMs,
    maxRetries: input.maxRetries,
    createdAt: now,
    updatedAt: now,
  };
  const jobs: BulkJob[] = input.rollNos.map((r) => ({
    id: `${id}:${r}`,
    batchId: id,
    rollNo: r,
    status: "queued",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  }));
  await bulkDB.transaction("rw", bulkDB.batches, bulkDB.jobs, async () => {
    await bulkDB.batches.add(batch);
    await bulkDB.jobs.bulkAdd(jobs);
  });
  return id;
}

export async function retryFailed(batchId: string): Promise<number> {
  const failed = await bulkDB.jobs
    .where("batchId")
    .equals(batchId)
    .and((j) => j.status === "failed")
    .toArray();
  const now = Date.now();
  await bulkDB.jobs.bulkPut(
    failed.map((j) => ({
      ...j,
      status: "queued",
      error: undefined,
      errorCode: undefined,
      attempts: 0,
      updatedAt: now,
    })),
  );
  await bulkDB.batches.update(batchId, { state: "running", updatedAt: now });
  return failed.length;
}

export async function deleteBatch(batchId: string): Promise<void> {
  if (state.batchId === batchId) cancel();
  await bulkDB.transaction("rw", bulkDB.batches, bulkDB.jobs, async () => {
    await bulkDB.jobs.where("batchId").equals(batchId).delete();
    await bulkDB.batches.delete(batchId);
  });
}
