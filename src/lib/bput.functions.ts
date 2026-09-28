// Server-side proxy to BPUT's undocumented result endpoints. Runs on the worker
// so the browser is never exposed to CORS from results.bput.ac.in and so the
// upstream integration is isolated behind one seam we control.
//
// The transport itself lives in `bput-upstream.ts`, which has no framework
// imports, so the identical calls can run headlessly in the scheduled census
// tick. These functions are the browser-facing wrapper around it.
import { createServerFn } from "@tanstack/react-start";
import type { ResultListItem, StudentDetails, SubjectsResponse } from "./sgpa";
import { resultList, studentDetails, subjects } from "./bput-upstream";

export { ERR } from "./bput-upstream";

export const fetchStudentDetails = createServerFn({ method: "POST" })
  .validator((data: { rollNo: string }) => data)
  .handler(async ({ data }): Promise<StudentDetails> => studentDetails(data.rollNo));

export const fetchResultList = createServerFn({ method: "POST" })
  .validator((data: { rollNo: string; dob: string; session: string }) => data)
  .handler(async ({ data }): Promise<ResultListItem[]> => resultList(data));

export const fetchSubjects = createServerFn({ method: "POST" })
  .validator((data: { rollNo: string; semId: string; session: string }) => data)
  .handler(async ({ data }): Promise<SubjectsResponse> => subjects(data));
