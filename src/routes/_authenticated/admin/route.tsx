// Admin layout: authenticated (via parent) + admin-role-gated. Non-admin
// signed-in users see a "Not authorized" screen instead of the dashboard.
import { createFileRoute, Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Suspense } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getMyRoles } from "@/lib/admin.functions";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({
    meta: [{ title: "Admin — BPUT Result Fetcher" }, { name: "robots", content: "noindex" }],
  }),
  component: AdminLayout,
});

function AdminLayout() {
  return (
    <div className="min-h-screen bg-background">
      <Suspense fallback={<AdminLoading />}>
        <RoleGate />
      </Suspense>
    </div>
  );
}

function AdminLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-sm text-muted-foreground">Checking permissions…</p>
    </div>
  );
}

function RoleGate() {
  const fetchRoles = useServerFn(getMyRoles);
  const { data: roles } = useSuspenseQuery({
    queryKey: ["my-roles"],
    queryFn: () => fetchRoles(),
    staleTime: 60_000,
  });

  if (!roles.includes("admin")) {
    return <NotAuthorized />;
  }

  return (
    <>
      <AdminHeader />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <AccessBanner />
        <PrivacyBanner />
        <Outlet />
      </main>
    </>
  );
}

function NotAuthorized() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  async function signOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md space-y-4 text-center">
        <h1 className="text-xl font-semibold">Not authorized</h1>
        <p className="text-sm text-muted-foreground">
          Your account is signed in but doesn't have admin access to this surface. To request bulk
          access, DM us on Instagram.
        </p>
        <a
          href="https://www.instagram.com/vibes.him"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          @vibes.him on Instagram
        </a>
        <div className="flex justify-center gap-2 pt-2">
          <Button variant="outline" onClick={() => navigate({ to: "/" })}>
            Go home
          </Button>
          <Button onClick={signOut}>Sign out</Button>
        </div>
      </div>
    </div>
  );
}

function AdminHeader() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  async function signOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            Admin
          </span>
          <h1 className="text-sm font-semibold">BPUT Result Fetcher</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/admin">Batches</Link>
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/admin/analytics">Analytics</Link>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/" })}>
            Public site
          </Button>
          <Button variant="outline" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}

function AccessBanner() {
  return (
    <div className="mb-6 flex flex-col items-start justify-between gap-3 rounded-md border border-primary/20 bg-primary/5 px-4 py-3 sm:flex-row sm:items-center">
      <div className="text-sm">
        <strong className="text-foreground">Need bulk access?</strong>{" "}
        <span className="text-muted-foreground">Contact us on Instagram for admin approval.</span>
      </div>
      <a
        href="https://www.instagram.com/vibes.him"
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
      >
        @vibes.him
      </a>
    </div>
  );
}

function PrivacyBanner() {
  return (
    <div className="mb-6 rounded-md border border-amber-300/40 bg-amber-50/60 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200">
      <strong>Admin surface.</strong> Bulk lookups against BPUT are on your responsibility as an
      admin, including having a lawful basis for the registration numbers you query. Public users on{" "}
      <code>/</code> never see or trigger anything on this page.
    </div>
  );
}
