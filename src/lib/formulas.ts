// Single source of truth for the SGPA / CGPA formulas + their legends.
// Both the on-screen KaTeX renderer (src/routes/index.tsx) and the exported
// PDF (src/lib/pdf.ts) import from here so the formula shown to the user
// and the one embedded in downloads can never drift apart.

export const SGPA_FORMULA_TEX = String.raw`\text{SGPA} = \frac{\sum_{i=1}^{n} C_i \times G_i}{\sum_{i=1}^{n} C_i}`;

export const CGPA_FORMULA_TEX = String.raw`\text{CGPA} = \frac{\sum_{n=1}^{k} \text{SGPA}_n \times C_n}{\sum_{n=1}^{k} C_n}`;

export const SGPA_LEGEND = "C = credits, G = grade point, n = subject index";

export const CGPA_LEGEND = "C = credits, n = semester index, k = published semesters";
