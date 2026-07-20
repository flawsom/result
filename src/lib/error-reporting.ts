// Lightweight error reporting helper for the root error boundary.
// It forwards to the host platform's global error hook when present (e.g. window.__hostEvents
// injected by the host editor); in production that global is absent and the call is a safe no-op.

type ErrorMeta = {
  boundary?: string;
  extra?: Record<string, unknown>;
};

export function reportError(error: unknown, meta?: ErrorMeta) {
  const w = window as unknown as {
    __hostEvents?: {
      captureException?: (e: unknown, m?: ErrorMeta) => void;
    };
  };
  w.__hostEvents?.captureException?.(error, meta);
}
