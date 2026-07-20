# BPUT Result Fetcher

An unofficial live result viewer and PDF marksheet exporter for **Biju Patnaik University of Technology (BPUT)** students. It fetches published semester results directly from `results.bput.ac.in`, computes SGPA/CGPA on the fly, visualizes trends, and exports a clean PDF marksheet — with no student login required.

> This is an independent, student-built tool. It is **not** affiliated with or endorsed by BPUT. The authoritative source for any official record remains [results.bput.ac.in](https://results.bput.ac.in).

---

## Tech Stack

Verified against `package.json` and `vite.config.ts`.

- **Framework:** [TanStack Start v1](https://tanstack.com/start) (React 19, file-based routing, SSR)
- **Build tool:** Vite 8, configured via the project's Vite + TanStack Start config (`vite.config.ts`)
- **Server bundler / hosting:** [Nitro](https://nitro.build) — auto-targets Vercel, Netlify, or Cloudflare Workers based on the deploying platform's env vars (Cloudflare Workers by default when built locally).
- **Language:** TypeScript 5.8 (strict)
- **Styling:** Tailwind CSS v4 (`@tailwindcss/vite`), `tw-animate-css`, `class-variance-authority`, `tailwind-merge`
- **UI:** shadcn/ui on Radix UI, `lucide-react`, `sonner`, `vaul`, `cmdk`
- **Data:** `@tanstack/react-query` v5
- **Charts:** Recharts 2
- **Math rendering:** KaTeX 0.16 (`katex.renderToString`)
- **Forms/validation:** `react-hook-form`, `@hookform/resolvers`, `zod`
- **PDF / assets:** `jspdf`, `jspdf-autotable`, `html2canvas`, `qrcode`, `jszip`
- **Client storage (admin):** `dexie` + `dexie-react-hooks` (IndexedDB)
- **Auth / DB (admin only):** Supabase via `@supabase/supabase-js`
- **Dates:** `date-fns`
- **Lint / format:** ESLint 9 (flat config) + Prettier 3

---

## Features

**Public student flow (`/`, no login):**

- Live result lookup by roll no + DOB + session; all published semesters fetched in parallel.
- Back-paper preservation — probes subsequent sessions per semester so republished attempts are kept alongside the primary.
- SGPA per semester + running CGPA (credit-weighted).
- KaTeX-rendered formulas, SGPA/CGPA trend chart, grade distribution chart.
- Reverse SGPA (target CGPA) calculator.
- PDF marksheet export via jsPDF + jspdf-autotable with a QR back to `results.bput.ac.in`.

**Home "BPUT Results Intelligence" analytics (`/`, no login):**

- Live aggregate dashboard: total records tracked, YoY delta, 24h live pulse (distinct semesters + total lookups), year-wise volume area chart with peak annotation, k-anonymised branch lollipops (k≥25), clickable year strip, seaborn-style bell-curve small multiples per semester.
- Mouse-reactive: cursor spotlight + grid reveal on the area chart, parallax peak label, hover ripples on branch lollipops, staggered draw-in on sparklines.
- Fed by two SECURITY DEFINER Postgres functions (`log_result_view`, `get_results_analytics`). Only counts by year, semester, branch are stored — never roll numbers, names, grades, IPs. Cohorts under 25 are folded into "Other".

**Admin surface (`/admin`, `admin` role required):**

- Google + email/password sign-in via Supabase, role gated by `has_role()` and the `user_roles` table.
- Bulk range fetch with pause/resume/cancel/retry, persisted in IndexedDB (Dexie).
- CSV + ZIP-of-PDFs export.
- Client-side analytics dashboard (CGPA distributions, grade mix, branch comparison, leaderboard, toughest subjects) — distinct from the public home analytics and computed entirely from the admin's local IndexedDB cache.

---

## Local Development — Quickstart

The **fastest** path if you only want to run the public flow (`/` search, PDF export, trend charts — everything except the home analytics section and `/admin`):

```bash
# 1. Prereqs: Node 20+ and Bun 1.x (or npm)
node --version   # v20 or newer
bun --version    # 1.x

# 2. Clone + install
git clone <this-repo> bput-result-fetcher
cd bput-result-fetcher
bun install       # or: npm install

# 3. No .env needed for the public flow — just start dev
bun run dev       # or: npm run dev
# → http://localhost:5173
```

That's it. The homepage, live result search, PDF export, and KaTeX/trend charts all work. **The "BPUT Results Intelligence" section at the bottom will render "Analytics unavailable"** because it needs Supabase; the rest of the app is unaffected.

To make the analytics section AND `/admin` work, keep reading — you need Supabase.

### Prerequisites

- [Node.js](https://nodejs.org) 20+ (no version is pinned; `@types/node` is v22 and the Cloudflare Workers target expects ≥ 20)
- [Bun](https://bun.sh) 1.x _or_ npm — both `bun.lock` and `package-lock.json` are checked in; pick one and stick with it
- (Optional, for the analytics section and `/admin`) either a hosted [Supabase](https://supabase.com) project OR [Supabase CLI](https://supabase.com/docs/guides/local-development) + [Docker Desktop](https://www.docker.com/products/docker-desktop/) for a fully local stack

### Scripts

| Script      | What it does                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `dev`       | `vite dev` — start local dev server on http://localhost:5173 with HMR                                                      |
| `build`     | `vite build` — production build; Nitro picks the preset from the deploying platform (Vercel / Netlify / Cloudflare / etc.) |
| `build:dev` | `vite build --mode development` (includes SSR prerender — useful to reproduce Vercel/Netlify SSR errors locally)           |
| `preview`   | Serve the last `npm run build` output locally. Note: `vite preview` does **not** work for this Nitro build (it looks for `dist/`, but the build emits `.output/`). Use `npx nitro preview` instead, or `npm run dev` for local checks. |
| `lint`      | `eslint .`                                                                                                                 |
| `format`    | `prettier --write .`                                                                                                       |

---

## Running the analytics locally

The home page's "BPUT Results Intelligence" section (year-wise volume, branch lollipops, semester small multiples, live pulse) is driven by two Postgres RPCs plus a small aggregates table. Pick **one** of the two paths below — you do **not** need both.

The database objects you must have in your Supabase project are:

| Object                                           | Kind                                | Purpose                                                                                                                                                                     |
| ------------------------------------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public.analytics_events`                        | table                               | One row per successful result fetch (year, semester, branch, served_at). Powers the 24h live pulse.                                                                         |
| `public.analytics_seed`                          | table                               | Pre-seeded historical aggregate counters, folded into the "all-time" totals so the charts aren't empty on day one.                                                          |
| `public.log_result_view(year, semester, branch)` | function (SECURITY DEFINER)         | Anonymous fire-and-forget writer called from the browser after every successful fetch. Validates ranges, trims branch to 80 chars, inserts one row into `analytics_events`. |
| `public.get_results_analytics()`                 | function (SECURITY DEFINER, STABLE) | Returns the single JSON payload the home chart consumes. Applies k=25 anonymity: any branch bucket with fewer than 25 total records is folded into `Other`.                 |

Both are defined in `supabase/migrations/20260714150001_*.sql` — running the migrations below creates all four.

### Path A — Point at a hosted Supabase project (easiest)

Use this if you don't want to install Docker.

1. **Create a project** at [supabase.com/dashboard](https://supabase.com/dashboard) → New project. Pick any region; the free tier is enough.
2. **Grab the URL + anon key** from **Project Settings → API**:
   - `Project URL` → goes into `SUPABASE_URL` and `VITE_SUPABASE_URL`
   - `Project API keys → anon / publishable` → goes into `SUPABASE_PUBLISHABLE_KEY` and `VITE_SUPABASE_PUBLISHABLE_KEY`
   - `Project ref` (the `xxxxx` in `xxxxx.supabase.co`) → goes into `SUPABASE_PROJECT_ID` and `VITE_SUPABASE_PROJECT_ID`
3. **Copy `.env.example` → `.env`** and paste those three values into both the server and client-side variables (they must match — server functions read `process.env.SUPABASE_*`, browser code reads `import.meta.env.VITE_SUPABASE_*`).
   ```bash
   cp .env.example .env
   # edit .env with your real values
   ```
4. **Run the migrations** against the hosted project. Install the [Supabase CLI](https://supabase.com/docs/guides/cli), then:

   ```bash
   # one-time: log in and link this repo to your project
   supabase login
   supabase link --project-ref <your-project-ref>

   # push every SQL file under supabase/migrations/ in order
   supabase db push
   ```

   This creates `user_roles`, `analytics_events`, `analytics_seed`, both RPCs, all GRANTs, and RLS policies. If you'd rather skip the CLI, open **SQL Editor** in the Supabase dashboard and paste each file under `supabase/migrations/` in filename order (they're timestamped) and run them one by one.

5. **Verify** — in the Supabase SQL editor:
   ```sql
   select count(*) from public.analytics_seed;         -- should be > 0 (the seed baseline)
   select public.get_results_analytics() -> 'total';   -- should return a positive number
   ```
6. **Start the app**:
   ```bash
   bun run dev
   ```
   Scroll to "BPUT RESULTS INTELLIGENCE" at the bottom of the homepage. Charts should render immediately from the seed baseline. Fetch a real result at the top of the page and refresh — the 24h live pulse should tick up.

### Path B — Fully local Supabase (needs Docker)

Use this if you want zero external dependencies.

1. **Install Docker Desktop** and the [Supabase CLI](https://supabase.com/docs/guides/cli/getting-started).
2. **Start the local stack** from the repo root — this reads `supabase/config.toml`, spins up Postgres/Auth/PostgREST in Docker, and applies every file under `supabase/migrations/` automatically:
   ```bash
   supabase start
   ```
   When it finishes it prints something like:
   ```
   API URL: http://127.0.0.1:54321
   DB URL:  postgresql://postgres:postgres@127.0.0.1:54322/postgres
   Studio URL: http://127.0.0.1:54323
   anon key: eyJhbGciOi... (copy this)
   service_role key: eyJhbGciOi... (copy this)
   ```
3. **Copy `.env.example` → `.env`** and paste those into all six SUPABASE* / VITE_SUPABASE* variables:

   ```env
   SUPABASE_PROJECT_ID="local"
   SUPABASE_URL="http://127.0.0.1:54321"
   SUPABASE_PUBLISHABLE_KEY="<anon key from `supabase start`>"

   VITE_SUPABASE_PROJECT_ID="local"
   VITE_SUPABASE_URL="http://127.0.0.1:54321"
   VITE_SUPABASE_PUBLISHABLE_KEY="<same anon key>"

   SUPABASE_SERVICE_ROLE_KEY="<service_role key>"   # optional; only if you use supabaseAdmin
   ```

4. **Start the app** — leave `supabase start` running in one terminal, and in another:
   ```bash
   bun run dev
   ```
5. **Inspect data** at [http://127.0.0.1:54323](http://127.0.0.1:54323) (Supabase Studio). Useful checks:
   ```sql
   select count(*) from public.analytics_events;
   select public.get_results_analytics();
   ```
6. **Stop the stack** when you're done: `supabase stop`. Data persists across restarts; to wipe, `supabase stop --no-backup` then `supabase start`.

### Making a code change to the analytics

- **Change a chart or the client aggregation** → edit `src/components/HomeAnalytics.tsx` or `src/lib/analytics-client.ts`. HMR reflects it instantly.
- **Change what gets stored or aggregated (schema, RPC logic, k-anonymity threshold)** → create a **new** SQL file under `supabase/migrations/` (do NOT edit an existing one — migrations are append-only). Name it `YYYYMMDDHHMMSS_short-description.sql`. Then:
  - Path A: `supabase db push`
  - Path B: `supabase migration up` (or just restart `supabase start`, which reapplies)
- **Add fresh seed rows** → insert into `public.analytics_seed` (columns: `year int`, `semester int`, `branch text`, `count int`). Keep them realistic and clearly labelled as synthetic in the commit message.

### Common analytics gotchas

| Symptom                                                                                                       | Cause / Fix                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Section shows "Analytics unavailable. Could not find the table 'public.analytics_events' in the schema cache" | Migrations haven't run against this project. Run `supabase db push` (Path A) or `supabase start` (Path B).                                                                                                                                          |
| Section shows "Analytics unavailable. permission denied for function get_results_analytics"                   | The `GRANT EXECUTE ... TO anon, authenticated` on the RPC didn't apply. Re-run the analytics migration, or in the SQL editor: `grant execute on function public.get_results_analytics() to anon, authenticated;`                                    |
| Charts render but "Live pulse · 24h" stays at 0                                                               | Nothing has called `log_result_view` yet in the last 24h. Fetch a real result at the top of the homepage — the client fires the RPC after each successful lookup (`src/lib/analytics-client.ts`).                                                   |
| PostgREST error `Expected 3 parts in JWT; got 1`                                                              | You pasted a new-format `sb_publishable_...` opaque key into a hand-rolled `createClient` somewhere. Use the generated `@/integrations/supabase/client` (browser) or `@/integrations/supabase/auth-middleware` (server) — both handle it correctly. |
| Same error, but only after you added a new SQL file                                                           | Schema cache is stale. In the Supabase SQL editor: `NOTIFY pgrst, 'reload schema';`. Hosted projects also auto-reload on the next migration push.                                                                                                   |

---

## Environment Variables

All variables listed here were located by searching `process.env.` and `import.meta.env.` across `src/`. Nothing else in the app source reads env vars.

The **public student search flow requires zero environment variables** — it talks to BPUT directly. Supabase env vars are needed for **both** the home "BPUT Results Intelligence" section (analytics RPCs) and the `/admin` surface (auth + role gate + bulk fetch).

| Variable                        | Scope            | Required?            | Purpose                                                                                                                                                                                                                         |
| ------------------------------- | ---------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL`             | Client (browser) | Analytics + `/admin` | Supabase project URL used by the browser Supabase client.                                                                                                                                                                       |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Client (browser) | Analytics + `/admin` | Supabase publishable/anon key used by the browser Supabase client.                                                                                                                                                              |
| `VITE_SUPABASE_PROJECT_ID`      | Client (browser) | Analytics + `/admin` | Project ref used to derive storage keys.                                                                                                                                                                                        |
| `SUPABASE_URL`                  | Server           | Analytics + `/admin` | Same URL, read inside server functions and the auth middleware. Also a fallback for the browser client during SSR.                                                                                                              |
| `SUPABASE_PUBLISHABLE_KEY`      | Server           | Analytics + `/admin` | Publishable/anon key read inside the auth middleware. Also an SSR fallback for the browser client.                                                                                                                              |
| `SUPABASE_PROJECT_ID`           | Server           | Analytics + `/admin` | Project ref for server-side helpers.                                                                                                                                                                                            |
| `SUPABASE_SERVICE_ROLE_KEY`     | Server           | Optional             | Read by `src/integrations/supabase/client.server.ts` to build a service-role client. Only needed if you add server-side code that calls `supabaseAdmin` (nothing in this repo currently does). **Never expose to the browser.** |

Notes:

- No other `process.env.*` or `import.meta.env.*` references exist in the app source.
- The bare search flow at `/` (roll no + DOB → PDF) will run with an entirely empty `.env`; only the analytics section at the bottom of the homepage will show "Analytics unavailable".
- Server (`SUPABASE_*`) and client (`VITE_SUPABASE_*`) values **must match** — same project, same anon key. Vite only exposes `VITE_`-prefixed variables to the browser bundle.
- On a managed platform these values may be auto-managed; otherwise you provide them from your own Supabase project (see §"Running the analytics locally" above).

---

## Google OAuth Setup

The `/admin` "Continue with Google" button calls Supabase's Google auth provider **directly** (`supabase.auth.signInWithOAuth`) — no third-party OAuth broker. That means it works on any host (Vercel, Netlify, Cloudflare, self-hosted, custom domain, or `localhost`) with the exact same code. There are **no `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` env vars in this repo** — all Google config lives in the Supabase dashboard. The public flow (`/`) needs none of this.

### 1. Create a Google OAuth client

1. Open [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. **Configure the OAuth consent screen** first (User type: **External**; add your Google account under Test users while in testing).
3. **Create Credentials → OAuth client ID → Web application.**
4. **Authorized JavaScript origins** — add every origin you'll sign in from:
   - `http://localhost:5173` (default Vite dev port)
   - `http://localhost:3000` (if you customized the port)
   - Your production URL (e.g. `https://result.unifies.codes` or `https://your-app.vercel.app`)
5. **Authorized redirect URIs** — add the Supabase callback exactly as shown in **Supabase Dashboard → Authentication → Providers → Google**. It looks like:
   ```
   https://<your-project-ref>.supabase.co/auth/v1/callback
   ```
   This is the ONLY redirect URI Google needs — it's Supabase's callback, not your app's. Do **not** add `/auth/callback` on your own domain here.
6. Save. Copy the **Client ID** and **Client secret**.

### 2. Wire the credentials into Supabase

1. **Supabase Dashboard → Authentication → Providers → Google** → enable it and paste the **Client ID** and **Client secret** from step 1.
2. **Authentication → URL Configuration:**
   - **Site URL:** your primary URL (e.g. `https://result.unifies.codes` in prod, `http://localhost:5173` for local dev).
   - **Redirect URLs (allowlist):** add every origin's `/auth/callback`:
     - `http://localhost:5173/auth/callback`
     - `https://result.unifies.codes/auth/callback`
     - `https://<your-preview-domain>/auth/callback` (Vercel preview, Netlify deploy previews, etc.)

     After Supabase finishes the Google round-trip it 302s the browser to one of these URLs (the app passes `redirectTo: ${window.location.origin}/auth/callback` from `src/routes/auth.tsx`), so every origin you sign in from must be allow-listed here.

### 3. Run it locally

```bash
cp .env.example .env       # then fill in your Supabase URL + anon key
bun install
bun run dev                # → http://localhost:5173
```

Visit [http://localhost:5173/auth](http://localhost:5173/auth) and click **Continue with Google**. First-time sign-in creates a Supabase user with no roles — grant yourself admin by inserting a row into `public.user_roles` (`user_id = auth.users.id`, `role = 'admin'`) via the Supabase SQL editor.

### Troubleshooting

| Symptom                                         | Fix                                                                                                                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redirect_uri_mismatch` from Google             | The exact `https://<ref>.supabase.co/auth/v1/callback` URL isn't in your Google OAuth client's **Authorized redirect URIs**. Paste it verbatim.          |
| 404 on `/~oauth/initiate`                       | You're on an older build that used a third-party OAuth broker. Pull latest — the auth page now calls Supabase directly and no `/~oauth/*` route is used. |
| Lands on `/auth` after Google returns           | The `${origin}/auth/callback` URL isn't in Supabase's Redirect URL allowlist. Add it.                                                                    |
| `Unsupported provider: provider is not enabled` | Google provider isn't toggled on in Supabase → Authentication → Providers.                                                                               |
| Signed in but `/admin` says Not authorized      | Expected — add a row to `public.user_roles` for your user with `role = 'admin'`.                                                                         |

---

## Deployment

### Build target

`vite build` runs [Nitro](https://nitro.build) via the project's Vite + TanStack Start config. Nitro **auto-detects the deployment target from the platform's own environment variables** (`VERCEL`, `NETLIFY`, `CF_PAGES`, etc.), so the same `npm run build` command produces the right output for whichever host runs it. Locally with no such env vars, it falls back to a Cloudflare Workers bundle.

You can force a target by setting `NITRO_PRESET` (e.g. `NITRO_PRESET=vercel`, `NITRO_PRESET=netlify`) as a build-time env var.

### Vercel

The project is deploy-ready — no `vercel.json` needed.

1. Import the repo at [vercel.com/new](https://vercel.com/new).
2. Framework preset: **Other**. Build command: `bun run build` (or `npm run build`). Output directory: leave default — Nitro's `vercel` preset writes the correct `.vercel/output/` structure automatically.
3. Add the env vars below in **Project Settings → Environment Variables** (only needed if you want `/admin` to work; the public flow needs none):
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` — exposed to the browser.
   - `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` — server-side, same values.
   - `SUPABASE_SERVICE_ROLE_KEY` — server-only, mark as **Sensitive**. Skip unless you need `supabaseAdmin`.
4. Deploy.

To pin the runtime explicitly, add `NITRO_PRESET=vercel` (Node functions) or `NITRO_PRESET=vercel-edge` (Edge) to the environment variables.

### Netlify

Also deploy-ready — no `netlify.toml` needed.

1. Import the repo at [app.netlify.com](https://app.netlify.com).
2. Build command: `bun run build` (or `npm run build`). Publish directory: leave default — Nitro's `netlify` preset writes to `.netlify/` automatically.
3. Add the same env vars listed above in **Site settings → Environment variables**. Mark `SUPABASE_SERVICE_ROLE_KEY` as sensitive.
4. Deploy.

To pin explicitly: `NITRO_PRESET=netlify` (Functions) or `NITRO_PRESET=netlify-edge`.

### Cloudflare Workers

`bun run build` locally emits a Workers bundle. Deploy with `wrangler deploy`, and set env vars in **Workers & Pages → your project → Settings → Variables**.

### Runtime notes

- `SUPABASE_SERVICE_ROLE_KEY` must **never** be prefixed with `VITE_` — that would ship it to the browser.
- Edge presets (`vercel-edge`, `netlify-edge`) run on Workers-like runtimes; the current code is already `workerd`-compatible, so either edge or Node target works.

---

## Data & Privacy

- Public flow sends only `rollNo`, `dob`, `session`, `semId` to BPUT; nothing is persisted server-side. The only client-side cache is an in-memory `Map` cleared on tab close.
- Server logs a single static label per upstream call — `rollNo`, `dob`, and query strings are deliberately never logged.
- Admin bulk-fetch results live **only** in the admin's browser IndexedDB (`bput-admin-bulk`, via Dexie). Nothing student-identifying is written to Supabase.
- The only Supabase table is `public.user_roles` (RLS: users can read only their own row; role checks go through the `SECURITY DEFINER` function `public.has_role`).

---

## Known Limitations

- Public flow is fully anonymous — no accounts, no history beyond the current tab.
- BPUT-specific only (endpoints, roll-number regex, and grade-point scale are hardcoded to BPUT).
- English UI only.
- Retry strategy is minimal: one retry with a fixed 400 ms backoff, no jitter.
- Coverage is stress-tested against B.Tech; other programs rely on the same upstream shape but may surface edge cases.
- Bulk-fetch admin runner is single-tab / single in-flight to stay polite toward BPUT.

---

---

## SEO

Technical SEO is built in and ships as static files plus a per-route document head. No environment variables and no external service are required.

**Static files (served from `public/`, available at the site root):**
- `public/robots.txt` — allows all crawlers, disallows `/admin`, and references the sitemap.
- `public/sitemap.xml` — lists the public routes (`/` and `/privacy`).
- `public/og-image.png` — the 1200×630 social-share image used for Open Graph and Twitter cards.

**Per-route document head** (root config in `src/routes/__root.tsx`, per-route overrides via each route's `head` export):
- `<title>`, meta `description`, and a canonical link on every route (home → `/`, `/privacy` → `/privacy`).
- Open Graph: `og:title`, `og:description`, `og:type`, `og:url`, `og:image` (the PNG above), `og:site_name`.
- Twitter: `twitter:card=summary_large_image` plus `twitter:title` / `twitter:description` / `twitter:image`.
- `apple-touch-icon` → `public/favicon.ico`.

**Structured data (JSON-LD):**
- Root: `WebSite` + `WebApplication` (with `logo`) on every page.
- `/privacy`: `FAQPage` with the eight FAQ entries — eligible for Google's FAQ rich result.

**To extend:** add a new public route under `src/routes/`, give it a `head` export (title / description / canonical), and add its URL to `public/sitemap.xml`. Re-run the `claude-seo` audit (`scripts/parse_html.py`) against a local/dev build to confirm the tags before deploying.

## License

No `LICENSE` file exists yet — until one is added, the code is "all rights reserved" by default.