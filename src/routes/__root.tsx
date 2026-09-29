import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportError } from "../lib/error-reporting";
import { initDevToolsGuard, subscribeDevToolsGuard } from "../lib/devtools-guard";
import { DevToolsCaughtOverlay } from "../components/DevToolsCaughtOverlay";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "BPUT Result Fetcher · SGPA in seconds" },
      {
        name: "description",
        content:
          "Fetch your official BPUT semester result and auto-calculated SGPA by registration number. Live BPUT results, SGPA/CGPA, and downloadable PDF marksheets.",
      },
      { property: "og:title", content: "BPUT Result Fetcher · SGPA in seconds" },
      {
        property: "og:description",
        content:
          "Official BPUT semester result + SGPA, fetched live. Enter your registration number to get results, SGPA/CGPA and a PDF marksheet.",
      },
      { property: "og:type", content: "website" },
      { property: "og:image", content: "https://result.unifies.codes/og-image.png" },
      { property: "og:site_name", content: "BPUT Result Fetcher" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "BPUT Result Fetcher · SGPA in seconds" },
      {
        name: "twitter:description",
        content:
          "Official BPUT semester result + SGPA, fetched live. Get your results, SGPA/CGPA and a PDF marksheet.",
      },
      { name: "twitter:image", content: "https://result.unifies.codes/og-image.png" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
      { rel: "apple-touch-icon", href: "/favicon.ico" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Archivo+Black&family=Work+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap",
      },
      {
        rel: "stylesheet",
        href: "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css",
        integrity: "sha384-nB0miv6/jRmo5UMMR1wu3Gz6NLsoTkbqJghGIsx//Rlm+ZU03BU6SQNC66uf4l5+",
        crossOrigin: "anonymous",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": "https://result.unifies.codes/#website",
        url: "https://result.unifies.codes/",
        name: "BPUT Result Fetcher",
        description:
          "Fetch official BPUT semester results and auto-calculated SGPA/CGPA by registration number, with downloadable PDF marksheets.",
        inLanguage: "en",
        logo: {
          "@type": "ImageObject",
          url: "https://result.unifies.codes/favicon.ico",
          width: 48,
          height: 48,
        },
      },
      {
        "@type": "WebApplication",
        "@id": "https://result.unifies.codes/#webapp",
        name: "BPUT Result Fetcher",
        url: "https://result.unifies.codes/",
        description:
          "Look up BPUT semester results by registration number and get auto-calculated SGPA/CGPA with a downloadable PDF marksheet.",
        applicationCategory: "UtilitiesApplication",
        operatingSystem: "Any",
        offers: { "@type": "Offer", price: "0", priceCurrency: "INR" },
        inLanguage: "en",
        logo: {
          "@type": "ImageObject",
          url: "https://result.unifies.codes/favicon.ico",
          width: 48,
          height: 48,
        },
      },
    ],
  };

  return (
    <html lang="en">
      <head>
        <HeadContent />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const [caught, setCaught] = useState(false);

  useEffect(() => {
    initDevToolsGuard();
    const unsub = subscribeDevToolsGuard(setCaught);
    return unsub;
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
      <DevToolsCaughtOverlay active={caught} />
    </QueryClientProvider>
  );
}
