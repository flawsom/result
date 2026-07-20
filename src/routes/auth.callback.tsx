// OAuth callback landing page. Supabase handles the token
// exchange directly; we just wait for the session to be present, then navigate to
// the previously-saved destination.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/auth/callback")({
  ssr: false,
  head: () => ({
    meta: [{ title: "Signing in…" }, { name: "robots", content: "noindex" }],
  }),
  component: AuthCallback,
});

function AuthCallback() {
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;

    function readNext(): string {
      try {
        const n = sessionStorage.getItem("bput.auth.next");
        sessionStorage.removeItem("bput.auth.next");
        if (n && n.startsWith("/") && !n.startsWith("//")) return n;
      } catch {
        /* ignore */
      }
      return "/admin";
    }

    async function go() {
      const { data } = await supabase.auth.getUser();
      if (cancelled) return;
      if (data.user) {
        navigate({ to: readNext(), replace: true });
        return;
      }
      // Session may hydrate slightly after callback; listen once.
      const { data: sub } = supabase.auth.onAuthStateChange((event) => {
        if (event === "SIGNED_IN") {
          sub.subscription.unsubscribe();
          navigate({ to: readNext(), replace: true });
        }
      });
      // Safety timeout: after 8s give up and go to /auth.
      setTimeout(() => {
        if (cancelled) return;
        sub.subscription.unsubscribe();
        navigate({ to: "/auth", replace: true });
      }, 8000);
    }

    go();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <p className="text-sm text-muted-foreground">Completing sign-in…</p>
    </div>
  );
}
