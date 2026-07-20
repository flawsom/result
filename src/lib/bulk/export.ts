// Export helpers for completed bulk results.
import JSZip from "jszip";
import { createResultPDFBlob, deliverBlob, type PdfSemester } from "../pdf";
import { bulkDB, type BulkBatch, type BulkJob } from "./db";

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function exportBatchCsv(batchId: string): Promise<Blob> {
  const jobs = await bulkDB.jobs.where("batchId").equals(batchId).toArray();
  const rows: string[] = [];
  const header = [
    "rollNo",
    "studentName",
    "branch",
    "batch",
    "college",
    "semId",
    "session",
    "semStatus",
    "sgpa",
    "credits",
    "totalGradePoints",
    "cgpa",
    "sgpaAvg",
    "jobStatus",
    "jobError",
  ];
  rows.push(header.join(","));

  for (const job of jobs) {
    const base = {
      rollNo: job.rollNo,
      studentName: job.student?.studentName ?? "",
      branch: job.student?.branchName ?? "",
      batch: job.student?.batch ?? "",
      college: job.student?.collegeName ?? "",
      cgpa: job.cgpa ?? "",
      sgpaAvg: job.sgpaAvg ?? "",
      jobStatus: job.status,
      jobError: job.error ?? "",
    };
    if (!job.semesters || job.semesters.length === 0) {
      rows.push(
        [
          base.rollNo,
          base.studentName,
          base.branch,
          base.batch,
          base.college,
          "",
          "",
          "",
          "",
          "",
          "",
          base.cgpa,
          base.sgpaAvg,
          base.jobStatus,
          base.jobError,
        ]
          .map(csvEscape)
          .join(","),
      );
      continue;
    }
    for (const s of job.semesters) {
      rows.push(
        [
          base.rollNo,
          base.studentName,
          base.branch,
          base.batch,
          base.college,
          s.semId,
          s.session,
          s.status,
          s.data?.sgpadetails?.sgpa ?? "",
          s.data?.sgpadetails?.cretits ?? "",
          s.data?.sgpadetails?.totalGradePoints ?? "",
          base.cgpa,
          base.sgpaAvg,
          base.jobStatus,
          base.jobError,
        ]
          .map(csvEscape)
          .join(","),
      );
    }
  }

  return new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
}

export function downloadBlob(blob: Blob, filename: string): void {
  deliverBlob(blob, filename);
}

function safeFilenamePart(value: string) {
  return (
    value
      .trim()
      .replace(/[^a-z0-9._-]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "batch"
  );
}

export function getBatchPdfZipFilename(batch: Pick<BulkBatch, "label" | "start" | "end">) {
  return `BPUT_Results_${safeFilenamePart(batch.label)}_${batch.start}-${batch.end}.zip`;
}

function getPdfSemesters(job: BulkJob): PdfSemester[] {
  return (job.semesters ?? [])
    .filter((s) => s.status === "done" && s.data)
    .map((s) => {
      const raw =
        s.attempts && s.attempts.length > 0 ? s.attempts : [{ session: s.session, data: s.data! }];
      const [primary, ...rest] = raw;
      return {
        semId: s.semId,
        session: primary.session,
        subjects: primary.data,
        attempts: rest.map((a) => ({ session: a.session, subjects: a.data })),
      };
    });
}

export function isPdfReadyJob(job: BulkJob) {
  return job.status === "done" && !!job.student && getPdfSemesters(job).length > 0;
}

export async function exportBatchPdfZip(
  batchId: string,
  onProgress?: (progress: { completed: number; total: number; rollNo: string }) => void,
): Promise<Blob> {
  const jobs = await bulkDB.jobs.where("batchId").equals(batchId).toArray();
  const readyJobs = jobs.filter(isPdfReadyJob).sort((a, b) => a.rollNo.localeCompare(b.rollNo));

  if (readyJobs.length === 0) {
    throw new Error("No fetched student results are ready for PDF download.");
  }

  const zip = new JSZip();
  const folder = zip.folder("BPUT_Results") ?? zip;
  let completed = 0;

  for (const job of readyJobs) {
    const semesters = getPdfSemesters(job);
    const { blob, filename } = await createResultPDFBlob({
      student: job.student!,
      semesters,
      cgpa: Number.isFinite(job.cgpa) ? (job.cgpa as number) : null,
    });
    folder.file(filename, blob);
    completed += 1;
    onProgress?.({ completed, total: readyJobs.length, rollNo: job.rollNo });
  }

  return zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

function countJobsByStatus(jobs: BulkJob[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const j of jobs) out[j.status] = (out[j.status] ?? 0) + 1;
  return out;
}

export { countJobsByStatus };
