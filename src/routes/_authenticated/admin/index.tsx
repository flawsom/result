// Admin bulk-fetch dashboard: create a batch from a reg-no range, watch
// progress live from IndexedDB, pause/resume/cancel/retry, export PDFs.
import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { bulkDB, type BulkBatch, type BulkJob } from "@/lib/bulk/db";
import { expandRange } from "@/lib/bulk/range";
import {
  cancel,
  createBatch,
  deleteBatch,
  pause,
  resume,
  retryFailed,
  runBatch,
  subscribeRunner,
} from "@/lib/bulk/runner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { toast } from "sonner";
import { CensusControl } from "@/components/admin/CensusControl";
import { createResultPDFBlob, getResultPdfFilename, type PdfSemester } from "@/lib/pdf";
import { exportBatchPdfZip, getBatchPdfZipFilename } from "@/lib/bulk/export";
import { Download, FileText } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/")({
  component: AdminDashboard,
});

function AdminDashboard() {
  return (
    <div className="space-y-6">
      <NewBatchForm />
      <ActiveRunner />
      <CensusControl />
      <BatchList />
    </div>
  );
}

function NewBatchForm() {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [label, setLabel] = useState("");
  const [rateLimit, setRateLimit] = useState(300);
  const [maxRetries, setMaxRetries] = useState(2);
  const [busy, setBusy] = useState(false);

  const preview = useMemo(() => {
    if (!start || !end) return null;
    try {
      const r = expandRange(start, end);
      return { count: r.rollNos.length, first: r.rollNos[0], last: r.rollNos.at(-1) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [start, end]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { rollNos } = expandRange(start, end);
      const id = await createBatch({
        label: label.trim() || `${start}–${end}`,
        rollNos,
        start,
        end,
        rateLimitMs: Math.max(200, Math.min(10_000, rateLimit)),
        maxRetries: Math.max(0, Math.min(5, maxRetries)),
      });
      toast.success(`Queued ${rollNos.length} registration numbers.`);
      void runBatch(id);
      setStart("");
      setEnd("");
      setLabel("");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border bg-card p-6">
      <h2 className="text-base font-semibold">New bulk batch</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Enter a registration-number range. The runner fetches student details and all 8 semesters
        per roll number, sequentially, at the pace below.
      </p>
      <form onSubmit={submit} className="mt-4 grid gap-4 md:grid-cols-6">
        <div className="md:col-span-2">
          <Label htmlFor="start">Start reg no</Label>
          <Input
            id="start"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            placeholder="2101010001"
            inputMode="numeric"
            required
          />
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="end">End reg no</Label>
          <Input
            id="end"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            placeholder="2101010120"
            inputMode="numeric"
            required
          />
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="label">Label (optional)</Label>
          <Input
            id="label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="CSE 2021 batch"
          />
        </div>
        <div>
          <Label htmlFor="rate">Delay per request (ms)</Label>
          <Input
            id="rate"
            type="number"
            min={200}
            max={10000}
            step={100}
            value={rateLimit}
            onChange={(e) => setRateLimit(Number(e.target.value))}
          />
        </div>
        <div>
          <Label htmlFor="retry">Max retries</Label>
          <Input
            id="retry"
            type="number"
            min={0}
            max={5}
            value={maxRetries}
            onChange={(e) => setMaxRetries(Number(e.target.value))}
          />
        </div>
        <div className="flex items-end md:col-span-4">
          <Button type="submit" disabled={busy || !preview || "error" in (preview ?? {})}>
            {busy ? "Queuing…" : "Start batch"}
          </Button>
        </div>
      </form>
      <div className="mt-3 text-xs text-muted-foreground">
        {preview && "error" in preview ? (
          <span className="text-destructive">{preview.error}</span>
        ) : preview ? (
          <span>
            {preview.count} registration numbers — {preview.first} … {preview.last}. Est. runtime ≈{" "}
            {estimateMinutes(preview.count, rateLimit)} min at current pace.
          </span>
        ) : (
          <span>Ranges up to 5,000 registration numbers are supported per batch.</span>
        )}
      </div>
    </section>
  );
}

function estimateMinutes(count: number, rateMs: number): string {
  // Rough: (1 details + 8 subjects) * rateLimit + latency per request
  const perRoll = (1 + 8) * (rateMs + 400);
  return ((count * perRoll) / 60_000).toFixed(1);
}

function useRunner() {
  const [s, setS] = useState({
    batchId: null as string | null,
    running: false,
    paused: false,
    cancelled: false,
    currentRollNo: null as string | null,
  });
  useEffect(() => subscribeRunner((n) => setS(n)), []);
  return s;
}

function ActiveRunner() {
  const runner = useRunner();
  const batch = useLiveQuery<BulkBatch | undefined>(
    async () => (runner.batchId ? await bulkDB.batches.get(runner.batchId) : undefined),
    [runner.batchId],
  );
  const counts = useLiveQuery(async () => {
    if (!runner.batchId) return null;
    const all = await bulkDB.jobs.where("batchId").equals(runner.batchId).toArray();
    const by: Record<string, number> = {};
    for (const j of all) by[j.status] = (by[j.status] ?? 0) + 1;
    return { total: all.length, by };
  }, [runner.batchId]);

  if (!runner.batchId || !batch) return null;
  const done = (counts?.by.done ?? 0) + (counts?.by.not_found ?? 0);
  const failed = counts?.by.failed ?? 0;
  const total = counts?.total ?? batch.total;
  const pct = total > 0 ? Math.round(((done + failed) / total) * 100) : 0;

  return (
    <section className="rounded-lg border bg-card p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Running: {batch.label}</h2>
          <p className="text-xs text-muted-foreground">
            {runner.paused
              ? "Paused"
              : runner.currentRollNo
                ? `Fetching ${runner.currentRollNo}…`
                : "Working…"}
          </p>
        </div>
        <div className="flex gap-2">
          {runner.paused ? (
            <Button size="sm" onClick={resume}>
              Resume
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={pause}>
              Pause
            </Button>
          )}
          <Button size="sm" variant="destructive" onClick={cancel}>
            Cancel
          </Button>
        </div>
      </div>
      <div className="mt-4">
        <Progress value={pct} />
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span>
            {done + failed} / {total} processed
          </span>
          <span>· {counts?.by.done ?? 0} succeeded</span>
          <span>· {counts?.by.not_found ?? 0} not found</span>
          <span className="text-destructive">· {failed} failed</span>
          <span>· {counts?.by.queued ?? 0} queued</span>
        </div>
      </div>
    </section>
  );
}

function BatchList() {
  const batches = useLiveQuery(() => bulkDB.batches.orderBy("createdAt").reverse().toArray(), []);
  if (!batches) return null;
  if (batches.length === 0) {
    return (
      <section className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        No batches yet. Start one above.
      </section>
    );
  }
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">Batches</h2>
      {batches.map((b) => (
        <BatchRow key={b.id} batch={b} />
      ))}
    </section>
  );
}

function BatchRow({ batch }: { batch: BulkBatch }) {
  const runner = useRunner();
  const isActive = runner.batchId === batch.id;
  const [bulkPdfBusy, setBulkPdfBusy] = useState(false);
  const [bulkPdfProgress, setBulkPdfProgress] = useState("");
  const [bulkPdfLink, setBulkPdfLink] = useState<{ url: string; filename: string } | null>(null);
  const counts = useLiveQuery(async () => {
    const all = await bulkDB.jobs.where("batchId").equals(batch.id).toArray();
    const by: Record<string, number> = {};
    for (const j of all) by[j.status] = (by[j.status] ?? 0) + 1;
    return { total: all.length, by };
  }, [batch.id]);
  const [expanded, setExpanded] = useState(false);

  const done = (counts?.by.done ?? 0) + (counts?.by.not_found ?? 0);
  const failed = counts?.by.failed ?? 0;
  const total = counts?.total ?? batch.total;
  const pct = total > 0 ? Math.round(((done + failed) / total) * 100) : 0;

  useEffect(() => {
    return () => {
      if (bulkPdfLink) URL.revokeObjectURL(bulkPdfLink.url);
    };
  }, [bulkPdfLink]);

  async function onResume() {
    if (isActive || runner.running) {
      toast.error("Another batch is running.");
      return;
    }
    void runBatch(batch.id);
  }
  async function onRetryFailed() {
    const n = await retryFailed(batch.id);
    if (n === 0) {
      toast.info("No failed jobs to retry.");
      return;
    }
    toast.success(`Requeued ${n} failed jobs.`);
    if (!runner.running) void runBatch(batch.id);
  }
  async function onDelete() {
    if (!confirm(`Delete batch "${batch.label}" and all its results?`)) return;
    await deleteBatch(batch.id);
    toast.success("Batch deleted.");
  }
  async function onDownloadBatchPdf() {
    const filename = getBatchPdfZipFilename(batch);
    setBulkPdfBusy(true);
    setBulkPdfProgress("starting");
    toast.info("Building PDF ZIP…");
    try {
      const blob = await exportBatchPdfZip(batch.id, ({ completed, total }) => {
        setBulkPdfProgress(`${completed}/${total}`);
      });
      const url = URL.createObjectURL(blob);
      setBulkPdfLink({ url, filename });
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      a.target = "_blank";
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.success("ZIP ready. If nothing downloaded, click the 'ready' link.");
    } catch (err) {
      console.error("Bulk PDF failed", err);
      toast.error((err as Error).message);
    } finally {
      setBulkPdfBusy(false);
      setBulkPdfProgress("");
    }
  }

  const pdfReadyCount = counts?.by.done ?? 0;

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium">{batch.label}</p>
            <StatusBadge state={batch.state} active={isActive} paused={runner.paused && isActive} />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {batch.start}–{batch.end} · {batch.total} rolls · {batch.rateLimitMs}ms ·{" "}
            {new Date(batch.createdAt).toLocaleString()}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!isActive && (counts?.by.queued ?? 0) > 0 && (
            <Button size="sm" onClick={onResume}>
              Resume
            </Button>
          )}
          {failed > 0 && (
            <Button size="sm" variant="outline" onClick={onRetryFailed}>
              Retry failed ({failed})
            </Button>
          )}
          {pdfReadyCount > 0 && (
            <Button size="sm" variant="outline" onClick={onDownloadBatchPdf} disabled={bulkPdfBusy}>
              <Download className="mr-1 h-3.5 w-3.5" />
              {bulkPdfBusy ? `Preparing ${bulkPdfProgress}` : `Download PDFs (${pdfReadyCount})`}
            </Button>
          )}
          {bulkPdfLink && (
            <a
              href={bulkPdfLink.url}
              download={bulkPdfLink.filename}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center rounded-md border px-3 text-xs font-medium text-primary hover:bg-muted"
            >
              PDF ZIP ready
            </a>
          )}
          <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Hide students" : `View students (${counts?.by.done ?? 0})`}
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>
      <div className="px-4 pb-4">
        <Progress value={pct} />
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span>
            {done + failed}/{total}
          </span>
          <span>· {counts?.by.done ?? 0} ok</span>
          <span>· {counts?.by.not_found ?? 0} not found</span>
          <span className="text-destructive">· {failed} failed</span>
          <span>· {counts?.by.queued ?? 0} queued</span>
        </div>
      </div>
      {expanded && <StudentCards batchId={batch.id} />}
    </div>
  );
}

function StatusBadge({
  state,
  active,
  paused,
}: {
  state: BulkBatch["state"];
  active: boolean;
  paused: boolean;
}) {
  const label = active ? (paused ? "paused" : "running") : state;
  const variant: "default" | "secondary" | "destructive" | "outline" =
    label === "completed"
      ? "secondary"
      : label === "cancelled"
        ? "outline"
        : label === "running"
          ? "default"
          : label === "paused"
            ? "outline"
            : "secondary";
  return <Badge variant={variant}>{label}</Badge>;
}

function StudentCards({ batchId }: { batchId: string }) {
  const [filter, setFilter] = useState<"all" | "failed" | "not_found" | "done">("done");
  const [search, setSearch] = useState("");
  const jobs = useLiveQuery(async () => {
    const arr = await bulkDB.jobs.where("batchId").equals(batchId).toArray();
    return arr.sort((a, b) => a.rollNo.localeCompare(b.rollNo));
  }, [batchId]);

  const filtered = useMemo(() => {
    if (!jobs) return [];
    const q = search.trim().toLowerCase();
    return jobs.filter((j) => {
      if (filter !== "all" && j.status !== filter) return false;
      if (!q) return true;
      return (
        j.rollNo.toLowerCase().includes(q) ||
        (j.student?.studentName ?? "").toLowerCase().includes(q) ||
        (j.student?.branchName ?? "").toLowerCase().includes(q)
      );
    });
  }, [jobs, filter, search]);

  return (
    <div className="border-t px-4 py-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex gap-1 text-xs">
          {(["all", "done", "not_found", "failed"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded px-2 py-1 ${filter === f ? "bg-primary text-primary-foreground" : "bg-muted"}`}
            >
              {f}
            </button>
          ))}
        </div>
        <Input
          placeholder="Search roll no, name, branch…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 max-w-xs text-xs"
        />
        <span className="ml-auto text-xs text-muted-foreground">
          {filtered.length} student{filtered.length === 1 ? "" : "s"}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="rounded border border-dashed p-6 text-center text-xs text-muted-foreground">
          No students match this filter.
        </p>
      ) : (
        <div className="max-h-[36rem] space-y-2 overflow-auto pr-1">
          <Accordion type="multiple" className="space-y-2">
            {filtered.slice(0, 500).map((j) => (
              <StudentCard key={j.id} job={j} />
            ))}
          </Accordion>
          {filtered.length > 500 && (
            <p className="text-center text-xs text-muted-foreground">
              Showing first 500 of {filtered.length}. Refine search to see more.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function StudentCard({ job }: { job: BulkJob }) {
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfLink, setPdfLink] = useState<{ url: string; filename: string } | null>(null);

  useEffect(() => {
    return () => {
      if (pdfLink) URL.revokeObjectURL(pdfLink.url);
    };
  }, [pdfLink]);

  const pdfSemesters: PdfSemester[] = useMemo(() => {
    return (job.semesters ?? [])
      .filter((s) => s.status === "done" && s.data)
      .map((s) => {
        const raw =
          s.attempts && s.attempts.length > 0
            ? s.attempts
            : [{ session: s.session, data: s.data! }];
        const [primary, ...rest] = raw;
        return {
          semId: s.semId,
          session: primary.session,
          subjects: primary.data,
          attempts: rest.map((a) => ({ session: a.session, subjects: a.data })),
        };
      });
  }, [job.semesters]);

  async function onDownloadPdf(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (!job.student || pdfSemesters.length === 0) {
      toast.error("No result data to render.");
      return;
    }
    const filename = getResultPdfFilename(job.student, pdfSemesters);
    setPdfBusy(true);
    toast.info(`Generating PDF for ${job.rollNo}…`);
    try {
      const { blob } = await createResultPDFBlob({
        student: job.student,
        semesters: pdfSemesters,
        cgpa: Number.isFinite(job.cgpa) ? (job.cgpa as number) : null,
      });
      const url = URL.createObjectURL(blob);
      setPdfLink({ url, filename });
      // Try direct download first.
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      a.target = "_blank";
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.success("PDF ready. If nothing downloaded, click the 'ready' link.");
    } catch (err) {
      console.error("PDF generation failed", err);
      toast.error(`PDF failed: ${(err as Error).message}`);
    } finally {
      setPdfBusy(false);
    }
  }

  const semCount = pdfSemesters.length;
  const canPdf = job.status === "done" && semCount > 0 && !!job.student;

  return (
    <AccordionItem value={job.id} className="rounded-md border bg-background">
      <div className="flex items-center gap-2 pr-3">
        <AccordionTrigger className="flex-1 px-3 py-3 hover:no-underline">
          <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 text-left">
            <span className="font-mono text-xs">{job.rollNo}</span>
            <span className="text-sm font-medium">{job.student?.studentName ?? "—"}</span>
            <span className="text-xs text-muted-foreground">{job.student?.branchName ?? ""}</span>
            <span className="ml-auto flex items-center gap-3 text-xs">
              <span>
                SGPA avg: <b>{Number.isFinite(job.sgpaAvg) ? job.sgpaAvg : "—"}</b>
              </span>
              <span>
                CGPA: <b>{Number.isFinite(job.cgpa) ? job.cgpa : "—"}</b>
              </span>
              <JobStatusBadge status={job.status} />
            </span>
          </div>
        </AccordionTrigger>
        <Button
          size="sm"
          variant="outline"
          disabled={!canPdf || pdfBusy}
          onClick={onDownloadPdf}
          title={canPdf ? "Download result PDF" : "No published semesters"}
        >
          <Download className="mr-1 h-3.5 w-3.5" />
          {pdfBusy ? "…" : "PDF"}
        </Button>
        {pdfLink && (
          <a
            href={pdfLink.url}
            download={pdfLink.filename}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-xs font-medium text-primary underline-offset-4 hover:underline"
          >
            ready
          </a>
        )}
      </div>
      <AccordionContent className="px-3">
        {job.error && <p className="mb-2 text-xs text-destructive">Error: {job.error}</p>}
        {job.student && (
          <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground md:grid-cols-3">
            <div>
              <span className="font-medium text-foreground">Batch:</span> {job.student.batch}
            </div>
            <div>
              <span className="font-medium text-foreground">College:</span>{" "}
              {job.student.collegeName}
            </div>
            <div>
              <span className="font-medium text-foreground">Course:</span> {job.student.courseName}
            </div>
          </div>
        )}
        {(job.semesters ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">No semesters fetched.</p>
        ) : (
          <Accordion type="multiple" className="space-y-2">
            {(job.semesters ?? []).map((s) => (
              <SemesterCard key={s.semId} sem={s} />
            ))}
          </Accordion>
        )}
      </AccordionContent>
    </AccordionItem>
  );
}

function SemesterCard({ sem }: { sem: NonNullable<BulkJob["semesters"]>[number] }) {
  const semLabel = sem.data?.grades[0]?.semester ?? sem.semId;
  const disabled = sem.status !== "done" || !sem.data;
  const attempts =
    sem.attempts && sem.attempts.length > 0
      ? sem.attempts
      : sem.data
        ? [{ session: sem.session, data: sem.data }]
        : [];
  const hasBackPapers = attempts.length > 1;
  return (
    <AccordionItem value={sem.semId} className="rounded border bg-muted/30">
      <AccordionTrigger className="px-3 py-2 hover:no-underline" disabled={disabled}>
        <div className="flex w-full items-center gap-3 text-left text-xs">
          <FileText className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium">Semester {semLabel}</span>
          <span className="text-muted-foreground">· {sem.session}</span>
          {hasBackPapers && (
            <Badge variant="outline" className="text-[10px]">
              +{attempts.length - 1} back-paper
            </Badge>
          )}
          <span className="ml-auto flex items-center gap-3">
            {sem.data?.sgpadetails?.sgpa && (
              <span>
                SGPA: <b>{sem.data.sgpadetails.sgpa}</b>
              </span>
            )}
            <Badge
              variant={
                sem.status === "done"
                  ? "default"
                  : sem.status === "empty"
                    ? "outline"
                    : "destructive"
              }
            >
              {sem.status}
            </Badge>
          </span>
        </div>
      </AccordionTrigger>
      <AccordionContent className="px-3">
        {sem.status === "error" && <p className="text-xs text-destructive">{sem.error}</p>}
        <div className="space-y-4">
          {attempts.map((att, idx) => (
            <div key={`${att.session}-${idx}`}>
              <div className="mb-1 flex items-center gap-2 text-xs">
                <span className="font-medium">
                  {idx === 0 ? "Primary result" : `Back paper republication #${idx}`}
                </span>
                <span className="text-muted-foreground">· {att.session}</span>
              </div>
              <div className="overflow-auto rounded border">
                <table className="w-full text-xs">
                  <thead className="bg-muted text-left">
                    <tr>
                      <th className="px-2 py-1.5">Code</th>
                      <th className="px-2 py-1.5">Subject</th>
                      <th className="px-2 py-1.5">Type</th>
                      <th className="px-2 py-1.5">Credits</th>
                      <th className="px-2 py-1.5">Grade</th>
                      <th className="px-2 py-1.5">Points</th>
                      <th className="px-2 py-1.5">Credit Pts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {att.data.grades.map((g, i) => (
                      <tr key={`${g.subjectCODE}-${i}`} className="border-t">
                        <td className="px-2 py-1 font-mono">{g.subjectCODE}</td>
                        <td className="px-2 py-1">
                          {g.subjectName}
                          {g.recheck ? " *" : ""}
                        </td>
                        <td className="px-2 py-1">{g.subjectTP}</td>
                        <td className="px-2 py-1">{g.subjectCredits}</td>
                        <td className="px-2 py-1 font-medium">{g.grade}</td>
                        <td className="px-2 py-1">{g.points}</td>
                        <td className="px-2 py-1">{g.creditPoints}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
                <span>
                  Total Credits: <b className="text-foreground">{att.data.sgpadetails.cretits}</b>
                </span>
                <span>
                  Total Grade Points:{" "}
                  <b className="text-foreground">{att.data.sgpadetails.totalGradePoints}</b>
                </span>
                <span>
                  SGPA: <b className="text-foreground">{att.data.sgpadetails.sgpa}</b>
                </span>
              </div>
            </div>
          ))}
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

function JobStatusBadge({ status }: { status: BulkJob["status"] }) {
  const variant: "default" | "secondary" | "destructive" | "outline" =
    status === "done"
      ? "default"
      : status === "failed"
        ? "destructive"
        : status === "not_found"
          ? "outline"
          : "secondary";
  return <Badge variant={variant}>{status}</Badge>;
}
