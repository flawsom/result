// Polished empty/error states. Any of these can genuinely fire in front of
// judges since the app has no fallback data path, so each one is designed
// rather than a raw error string.
import { useEffect, useState } from "react";
import { ERR } from "@/lib/bput.functions";

function Frame({
  tone = "neutral",
  tag,
  title,
  children,
}: {
  tone?: "neutral" | "warn" | "danger";
  tag: string;
  title: string;
  children?: React.ReactNode;
}) {
  const border =
    tone === "danger"
      ? "border-destructive"
      : tone === "warn"
        ? "border-foreground"
        : "border-foreground";
  return (
    <div className={`border-thick ${border} bg-background p-6`}>
      <div
        className={
          "label-caps " + (tone === "danger" ? "text-destructive" : "text-muted-foreground")
        }
      >
        {tag}
      </div>
      <div className="font-display mt-1 text-2xl leading-tight">{title}</div>
      {children && <div className="mt-3 font-mono text-sm">{children}</div>}
    </div>
  );
}

export function InvalidInputState({ detail }: { detail?: string }) {
  return (
    <Frame tone="warn" tag="Input · Rejected" title="That registration number doesn't look right.">
      <p>BPUT registration numbers are 8–12 digits. {detail}</p>
    </Frame>
  );
}

export function NotPublishedState({ label }: { label?: string }) {
  return (
    <Frame
      tag="Upstream · Not published"
      title={label ? `${label} isn't published yet.` : "This semester isn't published yet."}
    >
      <p>
        BPUT hasn't released this result. The fetch itself succeeded; there just isn't a result to
        show.
      </p>
    </Frame>
  );
}

export function UpstreamUnreachableState({
  detail,
  onRetry,
  retrying,
}: {
  detail?: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <Frame tone="danger" tag="Upstream · Unreachable" title="Couldn't reach results.bput.ac.in.">
      <p>
        The upstream portal didn't respond in time. This is on their side:{" "}
        {detail ?? "network timeout"}.
      </p>
      {onRetry && (
        <button
          onClick={onRetry}
          disabled={retrying}
          className="border-thick mt-4 bg-foreground px-4 py-2 font-mono text-xs font-bold uppercase tracking-widest text-background hover:bg-background hover:text-foreground disabled:opacity-40"
        >
          {retrying ? "Retrying…" : "↻ Retry"}
        </button>
      )}
    </Frame>
  );
}

function parseRetryAfter(msg: string | undefined): number {
  if (!msg) return 30;
  const m = msg.match(/retry-after=(\d+)/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 300) : 30;
}

export function RateLimitedState({ detail, onRetry }: { detail?: string; onRetry?: () => void }) {
  const initial = parseRetryAfter(detail);
  const [remaining, setRemaining] = useState(initial);
  useEffect(() => {
    if (remaining <= 0) return;
    const t = setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000);
    return () => clearInterval(t);
  }, [remaining]);

  const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
  const ss = String(remaining % 60).padStart(2, "0");

  return (
    <Frame tone="warn" tag="Upstream · Rate limited" title="BPUT asked us to slow down.">
      <p>We're waiting before hitting the portal again to avoid amplifying the load.</p>
      <div className="mt-4 flex items-center gap-4">
        <div className="font-display text-4xl">
          {mm}:{ss}
        </div>
        <button
          onClick={onRetry}
          disabled={remaining > 0 || !onRetry}
          className="border-thick bg-foreground px-4 py-2 font-mono text-xs font-bold uppercase tracking-widest text-background hover:bg-background hover:text-foreground disabled:opacity-40"
        >
          {remaining > 0 ? "Waiting…" : "↻ Retry"}
        </button>
      </div>
    </Frame>
  );
}

// Route a raw error message to the appropriate state component.
function classifyError(
  msg: string,
): "invalid" | "not_published" | "rate_limited" | "unreachable" | "unknown" {
  if (msg.startsWith(ERR.BAD_INPUT)) return "invalid";
  if (msg.startsWith(ERR.NOT_PUBLISHED)) return "not_published";
  if (msg.startsWith(ERR.RATE_LIMITED)) return "rate_limited";
  if (
    msg.startsWith(ERR.TIMEOUT) ||
    msg.startsWith(ERR.UNREACHABLE) ||
    msg.startsWith(ERR.UPSTREAM)
  )
    return "unreachable";
  return "unknown";
}

export function ErrorStateForMessage({
  message,
  onRetry,
  retrying,
  label,
}: {
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
  label?: string;
}) {
  const kind = classifyError(message);
  if (kind === "invalid")
    return <InvalidInputState detail={message.replace(/^BPUT_BAD_INPUT:\s*/, "")} />;
  if (kind === "not_published") return <NotPublishedState label={label} />;
  if (kind === "rate_limited") return <RateLimitedState detail={message} onRetry={onRetry} />;
  if (kind === "unreachable")
    return (
      <UpstreamUnreachableState
        detail={message.replace(/^BPUT_[A-Z_]+:\s*/, "")}
        onRetry={onRetry}
        retrying={retrying}
      />
    );
  return (
    <Frame tone="danger" tag="Error" title="Something unexpected happened.">
      <p>{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          disabled={retrying}
          className="border-thick mt-4 bg-foreground px-4 py-2 font-mono text-xs font-bold uppercase tracking-widest text-background hover:bg-background hover:text-foreground disabled:opacity-40"
        >
          {retrying ? "Retrying…" : "↻ Retry"}
        </button>
      )}
    </Frame>
  );
}
