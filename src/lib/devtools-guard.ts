// ⚠️ DETERRENT ONLY — NOT REAL SECURITY.
// This module discourages casual snooping. It does NOT protect anything:
//   • Users can disable JS, use "Disable JavaScript" in DevTools, or view-source: / curl the HTML.
//   • Remote debugging, browser extensions, or DevTools opened before page load bypass it.
//   • Mobile/embedded browsers may not fire keydown/contextmenu, or may lie about window sizes.
//   • The size + debugger heuristics have false positives (zoom, browser chrome, slow CPUs).
// Anything shipped to the client is inspectable. Enforce real security on the server.

const SIZE_THRESHOLD = 200;
const DEBUGGER_THRESHOLD_MS = 120;
const POLL_INTERVAL_MS = 1000;

type Listener = (detected: boolean) => void;

let initialized = false;
let currentDetected = false;
const listeners = new Set<Listener>();
let pollTimer: number | null = null;

function isTouchDevice(): boolean {
  return (
    "ontouchstart" in window ||
    navigator.maxTouchPoints > 0 ||
    /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  );
}

function sizeHeuristicTriggered(): boolean {
  if (isTouchDevice()) return false;
  const wDiff = Math.abs(window.outerWidth - window.innerWidth);
  const hDiff = Math.abs(window.outerHeight - window.innerHeight);
  return (wDiff > SIZE_THRESHOLD && hDiff > 100) || hDiff > SIZE_THRESHOLD * 1.5;
}

function debuggerHeuristicTriggered(): boolean {
  try {
    const start = performance.now();
    // eslint-disable-next-line no-debugger
    debugger;
    return performance.now() - start > DEBUGGER_THRESHOLD_MS;
  } catch {
    return false;
  }
}

function devToolsOpen(): boolean {
  return sizeHeuristicTriggered() || debuggerHeuristicTriggered();
}

function setDetected(next: boolean) {
  if (next === currentDetected) return;
  currentDetected = next;
  listeners.forEach((l) => {
    try {
      l(next);
    } catch {
      /* swallow listener errors so one bad subscriber can't break others */
    }
  });
}

function check() {
  setDetected(devToolsOpen());
}

/** Subscribe to detection state changes. Returns unsubscribe fn. */
export function subscribeDevToolsGuard(listener: Listener): () => void {
  listeners.add(listener);
  // Fire current state immediately so subscribers hydrate correctly.
  listener(currentDetected);
  return () => {
    listeners.delete(listener);
  };
}

export function getDevToolsDetected(): boolean {
  return currentDetected;
}

/**
 * Install global listeners (contextmenu, keydown blockers) and start polling
 * for DevTools. No-op in dev builds and on SSR.
 * Bypass the DEV check by passing { force: true } for local preview only.
 */
export function initDevToolsGuard(opts?: { force?: boolean }): void {
  if (!opts?.force && import.meta.env.DEV) return;
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (initialized) return;
  initialized = true;

  window.addEventListener("contextmenu", (e) => e.preventDefault(), { capture: true });

  window.addEventListener(
    "keydown",
    (e) => {
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      const isF12 = e.key === "F12";
      const isInspect = mod && (e.shiftKey || e.altKey) && (k === "i" || k === "j" || k === "c");
      const isViewSource = mod && k === "u";
      if (isF12 || isInspect || isViewSource) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true },
  );

  check();
  pollTimer = window.setInterval(check, POLL_INTERVAL_MS);
  window.addEventListener("resize", check);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) check();
  });
}
