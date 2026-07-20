import { useEffect, useRef, useState } from "react";

interface Props {
  /** When false, the overlay renders nothing. */
  active: boolean;
}

const TYPED_LINE = "> inspection_blocked.exe";

export function DevToolsCaughtOverlay({ active }: Props) {
  const [typed, setTyped] = useState("");
  const intervalRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);

  // Hide sibling body children while the overlay is up so the real app
  // isn't visible or interactive behind it, then restore on unmount/close.
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    const restored: Array<[HTMLElement, string]> = [];
    for (const el of Array.from(document.body.children)) {
      if (!(el instanceof HTMLElement)) continue;
      if (el.dataset.dtgOverlayRoot === "true") continue;
      const tag = el.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "LINK") continue;
      restored.push([el, el.style.display]);
      el.style.display = "none";
    }
    const prevHtmlOverflow = document.documentElement.style.overflow;
    const prevBodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";

    return () => {
      restored.forEach(([el, prev]) => {
        el.style.display = prev;
      });
      document.documentElement.style.overflow = prevHtmlOverflow;
      document.body.style.overflow = prevBodyOverflow;
    };
  }, [active]);

  // Typewriter effect — respects reduced motion (fills instantly).
  useEffect(() => {
    if (!active) {
      setTyped("");
      return;
    }
    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced) {
      setTyped(TYPED_LINE);
      return;
    }
    setTyped("");
    let i = 0;
    // Start typing after the headline lands (~500ms entrance).
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      intervalRef.current = window.setInterval(() => {
        i += 1;
        setTyped(TYPED_LINE.slice(0, i));
        if (i >= TYPED_LINE.length) {
          if (intervalRef.current != null) {
            window.clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
        }
      }, 45);
    }, 500);
    return () => {
      if (intervalRef.current != null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (timeoutRef.current != null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [active]);

  if (!active) return null;

  return (
    <div
      data-dtg-overlay-root="true"
      role="dialog"
      aria-modal="true"
      aria-label="Inspection blocked"
      className="dtg-bg"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483647,
        overflow: "hidden",
        background:
          "radial-gradient(1200px 800px at 20% 10%, color-mix(in oklab, var(--primary, #2563eb) 22%, transparent), transparent 60%), radial-gradient(900px 700px at 85% 90%, color-mix(in oklab, var(--foreground) 18%, transparent), transparent 65%), var(--background)",
        color: "var(--foreground)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
        userSelect: "none",
        WebkitUserSelect: "none",
        animation: "dtg-bg-fade 400ms ease-out both",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
      }}
    >
      {/* Animated grid backdrop */}
      <div
        aria-hidden
        className="dtg-grid"
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "linear-gradient(to right, color-mix(in oklab, var(--foreground) 8%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in oklab, var(--foreground) 8%, transparent) 1px, transparent 1px)",
          backgroundSize: "80px 80px",
          animation: "dtg-grid-pan 12s linear infinite",
          maskImage: "radial-gradient(ellipse at center, black 40%, transparent 80%)",
        }}
      />

      {/* Slow floating blobs */}
      <div
        aria-hidden
        className="dtg-blob"
        style={{
          position: "absolute",
          top: "-10vh",
          left: "-10vw",
          width: "50vw",
          height: "50vw",
          background:
            "radial-gradient(circle, color-mix(in oklab, var(--primary, #2563eb) 40%, transparent), transparent 70%)",
          filter: "blur(80px)",
          animation: "dtg-blob 18s ease-in-out infinite",
        }}
      />
      <div
        aria-hidden
        className="dtg-blob"
        style={{
          position: "absolute",
          bottom: "-15vh",
          right: "-10vw",
          width: "55vw",
          height: "55vw",
          background:
            "radial-gradient(circle, color-mix(in oklab, var(--foreground) 25%, transparent), transparent 70%)",
          filter: "blur(90px)",
          animation: "dtg-blob 22s ease-in-out infinite reverse",
        }}
      />

      {/* Scanline */}
      <div
        aria-hidden
        className="dtg-scanline"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          height: "2px",
          background:
            "linear-gradient(to right, transparent, color-mix(in oklab, var(--foreground) 50%, transparent), transparent)",
          animation: "dtg-scanline 6s linear infinite",
          pointerEvents: "none",
        }}
      />

      {/* Content */}
      <div
        style={{
          position: "relative",
          zIndex: 1,
          maxWidth: "min(92vw, 640px)",
          textAlign: "center",
          padding: "3rem 2rem",
          border: "5px solid var(--foreground)",
          background: "color-mix(in oklab, var(--background) 60%, transparent)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
        }}
      >
        {/* Typed terminal line */}
        <div
          className="dtg-line"
          style={{
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            fontSize: "0.85rem",
            letterSpacing: "0.1em",
            textAlign: "left",
            opacity: 0,
            animation: "dtg-slide-up 400ms cubic-bezier(0.2, 0.9, 0.3, 1) 300ms both",
            marginBottom: "1.25rem",
            color: "color-mix(in oklab, var(--foreground) 75%, transparent)",
            minHeight: "1.2em",
          }}
        >
          {typed}
          <span
            className="dtg-caret"
            aria-hidden
            style={{
              display: "inline-block",
              width: "0.6ch",
              marginLeft: "2px",
              background: "var(--foreground)",
              animation: "dtg-caret 900ms steps(1, end) infinite",
            }}
          >
            &nbsp;
          </span>
        </div>

        {/* Headline */}
        <h1
          className="dtg-headline"
          style={{
            fontFamily: "var(--font-display, 'Archivo Black', system-ui, sans-serif)",
            fontSize: "clamp(3.5rem, 14vw, 8rem)",
            lineHeight: 0.9,
            letterSpacing: "-0.04em",
            margin: 0,
            opacity: 0,
            animation: "dtg-headline-in 700ms cubic-bezier(0.34, 1.56, 0.64, 1) 100ms both",
          }}
        >
          Gotcha!
        </h1>

        {/* Divider */}
        <div
          aria-hidden
          className="dtg-line"
          style={{
            height: "3px",
            width: "80px",
            background: "var(--foreground)",
            margin: "1.75rem auto",
            opacity: 0,
            animation: "dtg-slide-up 400ms ease-out 550ms both",
          }}
        />

        {/* Follow line */}
        <p
          className="dtg-line"
          style={{
            margin: "0 0 1.5rem 0",
            fontSize: "clamp(0.95rem, 2vw, 1.15rem)",
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            opacity: 0,
            animation: "dtg-slide-up 500ms ease-out 700ms both",
          }}
        >
          Follow me on Instagram
        </p>

        {/* Instagram pill */}
        <div
          className="dtg-pill-wrap"
          style={{
            opacity: 0,
            animation: "dtg-slide-up 500ms cubic-bezier(0.2, 0.9, 0.3, 1) 850ms both",
          }}
        >
          <a
            href="https://instagram.com/vibes.him"
            target="_blank"
            rel="noopener noreferrer"
            className="dtg-pill"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.75rem",
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              fontSize: "clamp(1rem, 2.4vw, 1.35rem)",
              fontWeight: 700,
              padding: "0.85rem 1.5rem",
              background: "var(--foreground)",
              color: "var(--background)",
              textDecoration: "none",
              border: "3px solid var(--foreground)",
              transition: "transform 200ms ease, background 200ms ease",
              animation: "dtg-pill-glow 2.4s ease-in-out infinite 1400ms",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "scale(1.05)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "scale(1)";
            }}
          >
            <InstagramIcon />
            <span>@vibes.him</span>
          </a>
        </div>
      </div>
    </div>
  );
}

function InstagramIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden
    >
      <rect x="3" y="3" width="18" height="18" rx="0" ry="0" />
      <circle cx="12" cy="12" r="4.2" />
      <circle cx="17.4" cy="6.6" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}
