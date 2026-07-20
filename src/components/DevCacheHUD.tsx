// Dev-only cache-status HUD. Never rendered for audiences.
// Activation: `?dev=1` in URL, OR press Ctrl+Shift+D once loaded.
// Shows the last 12 fetch events with LIVE vs CACHE tag so the presenter
// always knows real-time upstream risk without any audience-visible UI.
import { useEffect, useSyncExternalStore, useState } from "react";
import { getEvents, subscribe, type CacheEvent } from "@/lib/result-cache";

function useEvents(): readonly CacheEvent[] {
  return useSyncExternalStore(subscribe, getEvents, getEvents);
}

export function DevCacheHUD() {
  const [visible, setVisible] = useState(false);
  const events = useEvents();

  useEffect(() => {
    // URL flag: opt-in per tab.
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("dev") === "1") setVisible(true);
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        setVisible((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!visible) return null;

  const recent = events.slice(-12).reverse();

  return (
    <div
      className="fixed bottom-3 right-3 z-50 max-w-xs border-thick bg-background p-3 font-mono text-[10px] shadow-lg"
      style={{ borderColor: "var(--color-foreground)" }}
      role="status"
      aria-label="Developer cache status"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="label-caps">DEV · Cache HUD</span>
        <button
          onClick={() => setVisible(false)}
          className="opacity-60 hover:opacity-100"
          aria-label="Hide dev HUD"
        >
          ×
        </button>
      </div>
      {recent.length === 0 ? (
        <div className="opacity-60">No fetch events yet.</div>
      ) : (
        <ul className="space-y-1">
          {recent.map((e, i) => (
            <li key={i} className="flex items-center justify-between gap-2">
              <span className="truncate">
                sem{e.semId} · {e.session}
              </span>
              <span
                className={
                  e.source === "LIVE"
                    ? "border-thick px-1.5 py-0.5 bg-foreground text-background"
                    : "border-thick px-1.5 py-0.5"
                }
              >
                {e.source}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 opacity-50">Ctrl+Shift+D to toggle</div>
    </div>
  );
}
