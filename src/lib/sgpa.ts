// Shared SGPA logic + BPUT response types. Single source of truth for
// grade-point math. Used by the manual/offline calculator and by tests as a
// cross-check against BPUT's server-computed sgpadetails.sgpa.

export const GRADE_POINTS = {
  O: 10,
  E: 9,
  A: 8,
  B: 7,
  C: 6,
  D: 5,
  F: 0,
  M: 0,
  S: 0,
} as const;

export type Grade = keyof typeof GRADE_POINTS;

export interface StudentDetails {
  rollNo: string;
  studentName: string;
  batch: string;
  branchId: string;
  studentPhoto: string;
  branchName: string;
  courseName: string;
  collegeCode: string;
  collegeName: string;
  semId: string | null;
  maxYear: string | null;
  leet: string | null;
}

export interface ResultListItem {
  semester: string;
  course: string;
  semId: string;
  branchName: string;
  rollNo: string;
  examSession: string;
}

export interface SubjectGrade {
  semester: string;
  course: string | null;
  semId: string;
  branchName: string | null;
  rollNo: string;
  subjectCODE: string;
  subjectTP: "T" | "P";
  subjectName: string;
  subjectCredits: number;
  grade: Grade;
  points: number;
  creditPoints: number;
  recheck: number;
}

export interface SubjectsResponse {
  grades: SubjectGrade[];
  sgpadetails: {
    cretits: number; // BPUT's typo, preserved as ground truth
    totalGradePoints: number;
    sgpa: string;
  };
}

export function calculateSGPA(subjects: Array<{ subjectCredits: number; grade: Grade }>): number {
  const totalCredits = subjects.reduce((s, x) => s + x.subjectCredits, 0);
  if (totalCredits === 0) return 0;
  const totalPoints = subjects.reduce((s, x) => s + x.subjectCredits * GRADE_POINTS[x.grade], 0);
  return Math.round((totalPoints / totalCredits) * 100) / 100;
}
