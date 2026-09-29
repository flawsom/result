import { createFileRoute } from "@tanstack/react-router";
import { HeadContent } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy, Disclaimer & FAQ · BPUT Result Fetcher" },
      {
        name: "description",
        content:
          "How BPUT Result Fetcher handles your data: unofficial tool, no affiliation with BPUT, results fetched live and not stored, no data sold or shared. Plus FAQs on SGPA, CGPA, backlogs and revaluation.",
      },
      { property: "og:title", content: "Privacy, Disclaimer & FAQ · BPUT Result Fetcher" },
      {
        property: "og:description",
        content:
          "Unofficial BPUT result tool. Results fetched live, not stored. No data sold or shared. Not affiliated with BPUT.",
      },
      { property: "og:url", content: "https://result.unifies.codes/privacy" },
      { canonical: "https://result.unifies.codes/privacy" },
    ],
    links: [{ rel: "canonical", href: "https://result.unifies.codes/privacy" }],
  }),
  component: Privacy,
});

const FAQS = [
  {
    q: "What is BPUT Result Fetcher?",
    a: "BPUT Result Fetcher is an unofficial tool that lets you look up your BPUT (Biju Patnaik University of Technology) semester result by registration number and date of birth, and shows an auto-calculated SGPA and CGPA. It is not affiliated with or endorsed by BPUT.",
  },
  {
    q: "Is this an official BPUT website?",
    a: "No. This is an independent, unofficial utility. Your official marksheet and result remain on the university's own portal at results.bput.ac.in. Always cross-check critical decisions (backlogs, revaluation, eligibility) against the official BPUT result.",
  },
  {
    q: "How is my result fetched?",
    a: "When you submit a registration number and date of birth, the request is proxied server-side to the public BPUT result endpoint. We do not ask for or store your password, and we never impersonate you.",
  },
  {
    q: "Do you store my result or registration number?",
    a: "Results are fetched live and returned to you. We do not persist your registration number or result on our servers after the response is served. We log only anonymous, aggregated counts (e.g. how many lookups happened) for operational monitoring, never individual-level student data.",
  },
  {
    q: "Do you sell or share my data?",
    a: "No. We do not sell, rent, or share any personal data with third parties. There is no advertising network and no data broker integration.",
  },
  {
    q: "How is SGPA calculated?",
    a: "SGPA for a semester is the weighted average of grade points by credit: SGPA = Σ(credit × gradePoint) / Σ(credit). CGPA is the weighted average across all completed semesters. The exact credit and grade-point mapping follows BPUT's published scheme.",
  },
  {
    q: "What if my result is not published yet?",
    a: "If BPUT has not yet published the result for that registration number and session, the tool shows an honest 'not published' state. It never shows a fabricated or stale result.",
  },
  {
    q: "What happens if the source is slow or down?",
    a: "If BPUT's portal is slow or unreachable, the tool shows a clear error and a retry option. It does not fall back to invented data.",
  },
];

function Privacy() {
  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQS.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  return (
    <>
      <HeadContent />
      <main className="mx-auto max-w-3xl px-4 py-10 text-sm leading-relaxed text-foreground">
        <h1 className="mb-2 text-2xl font-bold">Privacy, Disclaimer &amp; FAQ</h1>
        <p className="mb-6 text-muted-foreground">
          Last updated: {new Date().getFullYear()}. This page explains, plainly, what this tool is,
          how it handles your data, and how it is not connected to BPUT.
        </p>

        <section className="mb-8">
          <h2 className="mb-2 text-lg font-semibold">Unofficial, not affiliated with BPUT</h2>
          <p>
            BPUT Result Fetcher is an <strong>unofficial</strong> utility built to make checking
            your semester result and SGPA a little easier. It is{" "}
            <strong>not affiliated with, endorsed by, or operated by</strong> Biju Patnaik
            University of Technology (BPUT) or any government body. The official result always lives
            on the university portal at <code>results.bput.ac.in</code>.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="mb-2 text-lg font-semibold">What we fetch vs. what we store</h2>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong>Fetched:</strong> your semester result is retrieved live, server-side, from
              the public BPUT endpoint when you request it.
            </li>
            <li>
              <strong>Not stored:</strong> we do not persist your registration number or result on
              our servers after the response is served to you.
            </li>
            <li>
              <strong>Aggregates only:</strong> we keep anonymous, aggregated counts (e.g. total
              lookups) for monitoring. Individual student data is never retained or surfaced.
            </li>
            <li>
              <strong>No credentials:</strong> we never ask for or store a BPUT password.
            </li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="mb-2 text-lg font-semibold">We do not sell or share your data</h2>
          <p>
            We do not sell, rent, or share personal data with any third party. There is no
            advertising network and no data-broker integration in this tool.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="mb-2 text-lg font-semibold">Honest failure states</h2>
          <p>
            If BPUT's portal is slow, down, or returns unexpected data, the tool shows a clear error
            and a retry option. It never presents a stale or invented result as current.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold">Frequently asked questions</h2>
          <div className="space-y-4">
            {FAQS.map((f) => (
              <div key={f.q}>
                <h3 className="font-medium">{f.q}</h3>
                <p className="text-muted-foreground">{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        <p className="mt-10 text-xs text-muted-foreground">
          This is an independent project. For official records, always refer to{" "}
          <code>results.bput.ac.in</code> and your university.
        </p>
      </main>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }}
      />
    </>
  );
}
