// IndexedDB schema for the admin bulk-fetch queue. Everything lives in the
// admin's browser, no server-side persistence of results. Deleting the
// browser profile wipes the queue and cached results.
import Dexie, { type Table } from "dexie";
import type { StudentDetails, SubjectsResponse } from "@/lib/sgpa";

export type JobStatus = "queued" | "running" | "done" | "failed" | "not_found" | "cancelled";

export interface BulkJob {
  id: string; // batchId:rollNo
  batchId: string;
  rollNo: string;
  status: JobStatus;
  attempts: number;
  error?: string;
  errorCode?: string;
  student?: StudentDetails;
  semesters?: Array<{
    semId: string;
    session: string;
    status: "done" | "empty" | "error";
    error?: string;
    data?: SubjectsResponse;
    /**
     * Every non-empty attempt for this semester, in chronological order
     * (primary first, then back-paper republications). `data`/`session`
     * mirror the LAST (winning) attempt for SGPA/CGPA math.
     */
    attempts?: Array<{ session: string; data: SubjectsResponse }>;
  }>;
  sgpaAvg?: number;
  cgpa?: number;
  createdAt: number;
  updatedAt: number;
}

export interface BulkBatch {
  id: string;
  label: string;
  start: string;
  end: string;
  total: number;
  state: "running" | "paused" | "completed" | "cancelled";
  rateLimitMs: number;
  maxRetries: number;
  createdAt: number;
  updatedAt: number;
}

class BulkDB extends Dexie {
  jobs!: Table<BulkJob, string>;
  batches!: Table<BulkBatch, string>;

  constructor() {
    super("bput-admin-bulk");
    this.version(1).stores({
      batches: "id, createdAt, state",
      jobs: "id, batchId, rollNo, status, updatedAt, [batchId+status]",
    });
  }
}

export const bulkDB = new BulkDB();
