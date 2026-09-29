// Public sign-in page. Supports email/password and "Continue with Google"
// via Supabase's OAuth provider directly. The `next` search param is preserved so
// the user lands on their intended protected route after auth.
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type Search = { next?: string };

export const Route = createFileRoute("/auth")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    next: typeof s.next === "string" ? s.next : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Sign in · BPUT Result Fetcher Admin" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AuthPage,
});

function sanitizeNext(next: string | undefined): string {
  if (!next) return "/admin";
  // Only allow same-origin relative paths.
  if (!next.startsWith("/") || next.startsWith("//")) return "/admin";
  return next;
}

function AuthPage() {
  const navigate = useNavigate();
  const { next } = useSearch({ from: "/auth" }) as Search;
  const dest = sanitizeNext(next);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  // If already signed in, bounce to destination.
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) navigate({ to: dest, replace: true });
    });
  }, [dest, navigate]);

  async function handleEmailSignIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    navigate({ to: dest, replace: true });
  }

  async function handleGoogle() {
    setBusy(true);
    try {
      // Save the intended destination client-side; Google full-page flow
      // returns to /auth/callback where we read it back.
      sessionStorage.setItem("bput.auth.next", dest);
    } catch {
      /* ignore */
    }
    // Direct Supabase OAuth (self-hosted friendly, no third-party OAuth broker).
    // Google redirects to Supabase's callback, which then returns here.
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) {
      setBusy(false);
      toast.error(error.message || "Google sign-in failed");
    }
    // On success the browser navigates away to Google.
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Admin sign in</h1>
          <p className="text-sm text-muted-foreground">
            Restricted surface. The public results tool is at{" "}
            <a href="/" className="underline">
              /
            </a>
            .
          </p>
        </div>

        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={handleGoogle}
          disabled={busy}
        >
          Continue with Google
        </Button>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-background px-2 text-muted-foreground">or</span>
          </div>
        </div>

        <form onSubmit={handleEmailSignIn} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <p className="text-center text-xs text-muted-foreground">
          Sign-up is disabled. Contact an existing admin to be added.
        </p>
      </div>
    </div>
  );
}
