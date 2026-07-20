// Client-side PDF generation for BPUT results. Multi-semester layout with
// per-semester table + CGPA total. Marked as an unofficial copy throughout.
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import QRCode from "qrcode";

import type { StudentDetails, SubjectsResponse } from "./sgpa";
import { SGPA_FORMULA_TEX, CGPA_FORMULA_TEX, SGPA_LEGEND, CGPA_LEGEND } from "./formulas";

// ---------------------------------------------------------------------------
// KaTeX -> PNG rendering
// ---------------------------------------------------------------------------
// Renders a LaTeX string to a high-DPI PNG data URL using the same KaTeX
// source that drives the on-screen formulas. Cached at module scope so the
// admin bulk PDF-zip export never re-rasterises the same formula.

interface RenderedFormula {
  dataUrl: string;
  width: number; // natural CSS px
  height: number;
}

const formulaCache = new Map<string, Promise<RenderedFormula>>();

interface MathJaxSvgRenderer {
  renderSvg: (math: string) => string;
}

let mathJaxSvgRendererPromise: Promise<MathJaxSvgRenderer> | null = null;

async function getMathJaxSvgRenderer(): Promise<MathJaxSvgRenderer> {
  mathJaxSvgRendererPromise ??= (async () => {
    const [mathjaxMod, texMod, svgMod, adaptorMod, htmlMod, packagesMod] = await Promise.all([
      import("mathjax-full/js/mathjax.js"),
      import("mathjax-full/js/input/tex.js"),
      import("mathjax-full/js/output/svg.js"),
      import("mathjax-full/js/adaptors/liteAdaptor.js"),
      import("mathjax-full/js/handlers/html.js"),
      import("mathjax-full/js/input/tex/AllPackages.js"),
    ]);

    const adaptor = adaptorMod.liteAdaptor();
    htmlMod.RegisterHTMLHandler(adaptor);
    const tex = new texMod.TeX({ packages: packagesMod.AllPackages });
    const svg = new svgMod.SVG({ fontCache: "none" });
    const html = mathjaxMod.mathjax.document("", {
      InputJax: tex,
      OutputJax: svg,
    });

    return {
      renderSvg(math: string) {
        const node = html.convert(math, { display: true });
        const outer = adaptor.outerHTML(node);
        const svgMatch = outer.match(/<svg[\s\S]*<\/svg>/);
        if (!svgMatch) throw new Error("Formula SVG render failed");
        return svgMatch[0].replace(/currentColor/g, "#000000");
      },
    };
  })();

  return mathJaxSvgRendererPromise;
}

async function rasterizeSvgFormulaToPng(svgMarkup: string): Promise<RenderedFormula> {
  const viewBoxMatch = svgMarkup.match(/viewBox="([^"]+)"/);
  const widthMatch = svgMarkup.match(/width="([\d.]+)ex"/);
  const heightMatch = svgMarkup.match(/height="([\d.]+)ex"/);
  const viewBox = viewBoxMatch?.[1].split(/\s+/).map(Number) ?? [];
  const viewBoxRatio = viewBox.length === 4 && viewBox[3] > 0 ? viewBox[2] / viewBox[3] : 0;
  const exWidth = widthMatch ? Number(widthMatch[1]) : 0;
  const exHeight = heightMatch ? Number(heightMatch[1]) : 0;
  const ratio = viewBoxRatio || (exHeight > 0 ? exWidth / exHeight : 1);
  const height = Math.max(72, Math.ceil((exHeight || 6) * 16));
  const width = Math.max(1, Math.ceil(height * ratio));
  const sizedSvg = svgMarkup
    .replace(/\swidth="[^"]+"/, ` width="${width}"`)
    .replace(/\sheight="[^"]+"/, ` height="${height}"`);

  console.log("[pdf] Formula SVG before raster snapshot", {
    renderer: "MathJax SVG paths (no web-font dependency)",
    width,
    height,
    viewBox: viewBoxMatch?.[1] ?? null,
  });

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load formula SVG image"));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sizedSvg)}`;
  });

  const scale = 3;
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable for PDF formula rendering");
  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);

  return {
    dataUrl: canvas.toDataURL("image/png"),
    width,
    height,
  };
}

async function renderKatexToPng(math: string): Promise<RenderedFormula> {
  const cached = formulaCache.get(math);
  if (cached) return cached;

  const task = (async (): Promise<RenderedFormula> => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      throw new Error("PDF export must run in the browser");
    }

    const renderer = await getMathJaxSvgRenderer();
    const svgMarkup = renderer.renderSvg(math);
    return rasterizeSvgFormulaToPng(svgMarkup);
  })();

  formulaCache.set(math, task);
  try {
    return await task;
  } catch (err) {
    formulaCache.delete(math);
    throw err;
  }
}

export interface PdfSemesterAttempt {
  session: string;
  subjects: SubjectsResponse;
}

export interface PdfSemester {
  semId: string;
  session: string;
  subjects: SubjectsResponse;
  /**
   * Additional attempts for this semester (back-paper republications).
   * When present, each attempt is rendered as its own table under the
   * semester heading in chronological order after the primary. The
   * `session`/`subjects` pair above is treated as the primary attempt.
   */
  attempts?: PdfSemesterAttempt[];
}

export interface ResultPdfOptions {
  student: StudentDetails;
  semesters: PdfSemester[];
  cgpa: number | null;
}

export function getResultPdfFilename(student: StudentDetails, semesters: PdfSemester[]) {
  const semIdList = semesters.map((s) => s.semId).join("-") || "none";
  return `BPUT_Result_${student.rollNo}_Sem${semIdList}.pdf`;
}

export function openDownloadTarget(filename: string): Window | null {
  try {
    const target = window.open("", "_blank");
    if (!target) return null;
    target.document.title = `Preparing ${filename}`;
    target.document.body.style.margin = "0";
    target.document.body.style.fontFamily = "system-ui, sans-serif";
    target.document.body.style.background = "#ffffff";
    target.document.body.style.color = "#111827";
    target.document.body.textContent = "";

    const main = target.document.createElement("main");
    main.style.minHeight = "100vh";
    main.style.display = "grid";
    main.style.placeItems = "center";
    main.style.padding = "32px";
    main.style.textAlign = "center";

    const wrap = target.document.createElement("div");
    const heading = target.document.createElement("h1");
    heading.style.fontSize = "18px";
    heading.style.margin = "0 0 8px";
    heading.textContent = "Preparing download…";
    const detail = target.document.createElement("p");
    detail.style.fontSize = "13px";
    detail.style.margin = "0";
    detail.style.color = "#4b5563";
    detail.textContent = filename;

    wrap.append(heading, detail);
    main.append(wrap);
    target.document.body.append(main);
    return target;
  } catch {
    return null;
  }
}

export function deliverBlob(blob: Blob, filename: string, targetWindow?: Window | null) {
  const url = URL.createObjectURL(blob);
  const revokeLater = () => {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  if (targetWindow && !targetWindow.closed) {
    try {
      targetWindow.location.href = url;
      targetWindow.focus();
      revokeLater();
      return;
    } catch {
      // Fall back to the normal download path below.
    }
  }

  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch {
    try {
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      /* noop */
    }
  } finally {
    revokeLater();
  }
}

export async function createResultPDFBlob(opts: ResultPdfOptions) {
  const { student, semesters, cgpa } = opts;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 52; // slightly larger outer margin for breathing room
  const footerReserve = 32;
  console.log(`[pdf] footerReserve = ${footerReserve}`);
  let y = margin;

  // Pre-render both formulas once (module-level cache keeps this fast across
  // the admin bulk ZIP export where hundreds of PDFs are generated in a row).
  const [sgpaFormula, cgpaFormula] = await Promise.all([
    renderKatexToPng(SGPA_FORMULA_TEX),
    cgpa !== null
      ? renderKatexToPng(CGPA_FORMULA_TEX)
      : Promise.resolve(null as RenderedFormula | null),
  ]);

  // Fixed target heights (pt) for rendered KaTeX formula images, calibrated
  // against the 10pt summary line and 8pt legend so the formula reads as a
  // clear visual anchor without ballooning the layout. Tune these two
  // constants only — don't touch the spacing math below.
  const FORMULA_IMG_HEIGHT_PT = 30;
  const CGPA_FORMULA_IMG_HEIGHT_PT = 34;
  const FORMULA_GAP_ABOVE_PT = 10; // summary line -> formula
  const FORMULA_GAP_BELOW_PT = 10; // formula -> legend line

  const fitFormulaByHeight = (f: RenderedFormula, targetHeightPt: number) => {
    const ratio = f.width / f.height;
    return { w: targetHeightPt * ratio, h: targetHeightPt };
  };

  // ---------- Header ----------
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("BPUT / Result Fetcher", margin, y);
  y += 16;
  doc.setFont("helvetica", "italic");
  doc.setFontSize(10);
  doc.text("Unofficial copy — regenerated from BPUT's public result portal", margin, y);
  y += 12;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  doc.text(`Generated: ${stamp}`, margin, y);
  y += 10;
  doc.setDrawColor(0);
  doc.setLineWidth(1.5);
  doc.line(margin, y, pageW - margin, y);
  y += 20;

  // ---------- Student block with photo placeholder ----------
  const photoW = 90;
  const photoH = 110;
  const photoX = pageW - margin - photoW;
  const photoY = y;
  doc.setLineWidth(1);
  doc.rect(photoX, photoY, photoW, photoH);
  doc.setFont("helvetica", "italic");
  doc.setFontSize(8);
  doc.text("Photo", photoX + photoW / 2, photoY + photoH / 2, {
    align: "center",
    baseline: "middle",
  });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  const rows: Array<[string, string]> = [
    ["Reg No", student.rollNo],
    ["Name", student.studentName],
    ["College", `${student.collegeName} (${student.collegeCode})`],
    ["Branch", student.branchName],
    [
      "Semesters",
      `${semesters.length} fetched: ${semesters
        .map((s) => s.subjects.grades[0]?.semester ?? s.semId)
        .join(", ")}`,
    ],
  ];
  const labelMaxW = pageW - margin - photoW - 20 - (margin + 80);
  for (const [k, v] of rows) {
    doc.setFont("helvetica", "bold");
    doc.text(`${k}:`, margin, y);
    doc.setFont("helvetica", "normal");
    const vLines = doc.splitTextToSize(String(v ?? ""), labelMaxW);
    doc.text(vLines, margin + 80, y);
    y += 14 * vLines.length;
  }
  y = Math.max(y, photoY + photoH) + 20;

  // ---------- Per-semester tables ----------
  const pageBottom = () => pageH - margin - footerReserve;
  console.log(`[pdf] pageBottom() = ${pageBottom()}, pageH = ${pageH}, margin = ${margin}`);
  const ensureRoom = (needed: number) => {
    if (y + needed > pageBottom()) {
      doc.addPage();
      y = margin;
    }
  };

  // Target height matches ~2x body text so the fraction reads comfortably
  // at 100% zoom without dominating the page. Width follows the aspect
  // ratio of the rasterised glyphs (padding stripped in renderKatexToPng).
  const sgpaFormulaSize = fitFormulaByHeight(sgpaFormula, FORMULA_IMG_HEIGHT_PT);
  console.log(
    `[pdf] SGPA formula image: ${sgpaFormulaSize.w.toFixed(2)}pt x ${sgpaFormulaSize.h.toFixed(2)}pt (natural ${sgpaFormula.width}x${sgpaFormula.height}px)`,
  );
  const sgpaBlockH = FORMULA_GAP_ABOVE_PT + sgpaFormulaSize.h + FORMULA_GAP_BELOW_PT + 10; // + legend line height

  semesters.forEach((sem, semIdx) => {
    // Each semester starts on its own page.
    if (semIdx > 0) {
      doc.addPage();
      y = margin;
    }

    const semLabel = sem.subjects.grades[0]?.semester ?? sem.semId;

    // Primary + any back-paper republications, in chronological order.
    const allAttempts: PdfSemesterAttempt[] = [
      { session: sem.session, subjects: sem.subjects },
      ...(sem.attempts ?? []),
    ];

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(`Semester ${semLabel}`, margin, y);
    y += 14;

    allAttempts.forEach((att, idx) => {
      // Protect the attempt label from getting orphaned alone at the
      // bottom of a page. autoTable below paginates the table itself.
      ensureRoom(40);

      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      const attemptLabel =
        idx === 0
          ? `Primary result · ${att.session}`
          : `Back paper republication #${idx} · ${att.session}`;
      doc.text(attemptLabel, margin, y);
      y += 16;

      autoTable(doc, {
        startY: y,
        head: [["Code", "Subject", "Type", "Credits", "Grade", "Points", "Credit Pts"]],
        body: att.subjects.grades.map((g) => [
          g.subjectCODE,
          g.subjectName + (g.recheck ? " *" : ""),
          g.subjectTP,
          String(g.subjectCredits),
          g.grade,
          String(g.points),
          String(g.creditPoints),
        ]),
        styles: {
          font: "helvetica",
          fontSize: 9,
          cellPadding: { top: 6, right: 5, bottom: 6, left: 5 },
        },
        headStyles: {
          fillColor: [0, 0, 0],
          textColor: 255,
          cellPadding: { top: 7, right: 5, bottom: 7, left: 5 },
        },
        theme: "grid",
        pageBreak: "auto",
        rowPageBreak: "avoid",
        margin: { top: margin, left: margin, right: margin, bottom: margin + footerReserve },
      });
      const docWithTable = doc as jsPDF & { lastAutoTable: { finalY: number } };
      console.log(
        `[pdf] table finalY = ${docWithTable.lastAutoTable.finalY}, pageBottom = ${pageBottom()}, pageNumber = ${(doc.internal as unknown as { getNumberOfPages: () => number }).getNumberOfPages()}`,
      );
      y = docWithTable.lastAutoTable.finalY + 10;

      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.text(
        `Total Credits: ${att.subjects.sgpadetails.cretits}    Total Grade Points: ${att.subjects.sgpadetails.totalGradePoints}    SGPA: ${att.subjects.sgpadetails.sgpa}`,
        margin,
        y,
      );
      y += 8;
    });

    // Formula + legend must never split across a page — reserve room for
    // the whole block as a single unit.
    ensureRoom(sgpaBlockH);
    y += FORMULA_GAP_ABOVE_PT;
    doc.addImage(sgpaFormula.dataUrl, "PNG", margin, y, sgpaFormulaSize.w, sgpaFormulaSize.h);
    y += sgpaFormulaSize.h + FORMULA_GAP_BELOW_PT;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(60);
    doc.text(SGPA_LEGEND, margin, y);
    doc.setTextColor(0);
    y += 8;
  });

  // ---------- CGPA total ----------
  if (cgpa !== null && cgpaFormula) {
    const cgpaFormulaSize = fitFormulaByHeight(cgpaFormula, CGPA_FORMULA_IMG_HEIGHT_PT);
    console.log(
      `[pdf] CGPA formula image: ${cgpaFormulaSize.w.toFixed(2)}pt x ${cgpaFormulaSize.h.toFixed(2)}pt (natural ${cgpaFormula.width}x${cgpaFormula.height}px)`,
    );
    const cgpaBlockH =
      10 + 18 + FORMULA_GAP_ABOVE_PT + cgpaFormulaSize.h + FORMULA_GAP_BELOW_PT + 12;
    ensureRoom(cgpaBlockH + 8);
    y += 6;
    doc.setDrawColor(0);
    doc.setLineWidth(1);
    doc.line(margin, y, pageW - margin, y);
    y += 12;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text(
      `CGPA (across ${semesters.length} semester${semesters.length === 1 ? "" : "s"}): ${cgpa.toFixed(2)}`,
      margin,
      y,
    );
    y += FORMULA_GAP_ABOVE_PT;
    doc.addImage(cgpaFormula.dataUrl, "PNG", margin, y, cgpaFormulaSize.w, cgpaFormulaSize.h);
    y += cgpaFormulaSize.h + FORMULA_GAP_BELOW_PT;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(60);
    doc.text(`${CGPA_LEGEND}. Uses BPUT's own sgpa and credits per semester.`, margin, y);
    doc.setTextColor(0);
    y += 12;
  }

  // ---------- Disclaimer + QR (new page if tight) ----------
  ensureRoom(260);
  const qrDataUrl = await QRCode.toDataURL("https://results.bput.ac.in/", {
    margin: 1,
    width: 240,
  });
  const qrSize = 90;
  const qrX = pageW - margin - qrSize;
  const qrY = pageH - margin - 220;
  doc.addImage(qrDataUrl, "PNG", qrX, qrY, qrSize, qrSize);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  const qrCaption = doc.splitTextToSize(
    `Scan to verify independently at results.bput.ac.in — enter Reg. No. ${student.rollNo}.`,
    qrSize + 60,
  );
  doc.text(qrCaption, qrX - 10, qrY + qrSize + 12, { align: "left" });

  let dy = pageH - margin - 210;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text("For any query; Please email at: students@bput.ac.in", margin, dy);
  dy += 14;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  const notes = [
    "1. The result is provisional.",
    "2. In case of any typological error or discrepancy, the student is required to report at their respective college for neccessary intimation to the University.",
    "3. As per the provision of the Grading System of the University 'M' denotes MALPRACTICE (Grade Point 0) and 'S' denotes ABSENT (Grade Point 0) and F Grade in (Int=Internal, Ext=External, Pr=Practical).",
    "4. The SGPA shown for the subjects displayed in this page.",
    "5. WhOR(I)- Result Withheld for Non-Submission / Receipt of Registered Internal / Sessional / Practical.",
    "6. MPR- Malpractice Reported.",
    "7. Rechecking results will be marked with an asterisk (*) symbol.",
  ];
  const maxW = pageW - margin * 2 - qrSize - 20;
  for (const n of notes) {
    const lines = doc.splitTextToSize(n, maxW);
    doc.text(lines, margin, dy);
    dy += lines.length * 10;
  }
  dy += 6;
  doc.setFont("helvetica", "bold");
  doc.text("Director, Examinations", margin, dy);
  dy += 14;
  doc.setFont("helvetica", "bold");
  doc.text("Disclaimer:", margin, dy);
  dy += 10;
  doc.setFont("helvetica", "normal");
  const dis = [
    "1. The results published are provisional and subject to change after post publication scrutiny by BPUT.",
    "2. The university shall not be held responsible for any inadvertent error that may have crept into the results being displayed.",
  ];
  for (const d of dis) {
    const lines = doc.splitTextToSize(d, pageW - margin * 2);
    doc.text(lines, margin, dy);
    dy += lines.length * 10;
  }

  // Bottom footer on every page
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setDrawColor(150);
    doc.setLineWidth(0.5);
    doc.line(margin, pageH - margin - 14, pageW - margin, pageH - margin - 14);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(90);
    doc.text(
      `Source: https://results.bput.ac.in/ · Fetched via BPUT Result Fetcher (unofficial) · Page ${i} / ${total}`,
      pageW / 2,
      pageH - margin - 4,
      { align: "center" },
    );
    doc.setTextColor(0);
  }

  const filename = getResultPdfFilename(student, semesters);
  const blob = doc.output("blob");
  return { blob, filename };
}

export async function downloadResultPDF(
  opts: ResultPdfOptions & { openInNewTabFallback?: boolean },
) {
  const targetWindow = opts.openInNewTabFallback
    ? openDownloadTarget(getResultPdfFilename(opts.student, opts.semesters))
    : null;
  const { blob, filename } = await createResultPDFBlob(opts);
  deliverBlob(blob, filename, targetWindow);
}
