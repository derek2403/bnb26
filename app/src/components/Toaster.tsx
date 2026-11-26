"use client";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type ToastKind = "info" | "pending" | "success" | "error";
export type Toast = { id: number; kind: ToastKind; title: string; body?: string; lines?: string[]; href?: string; hrefLabel?: string };

type Ctx = {
  push: (t: Omit<Toast, "id">) => number;
  update: (id: number, t: Partial<Omit<Toast, "id">>) => void;
  dismiss: (id: number) => void;
};

const ToastCtx = createContext<Ctx | null>(null);
let seq = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const schedule = useCallback(
    (id: number, kind: ToastKind) => {
      if (kind === "success" || kind === "info") setTimeout(() => dismiss(id), 12_000);
    },
    [dismiss],
  );
  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = seq++;
      setToasts((ts) => [...ts.slice(-4), { ...t, id }]);
      schedule(id, t.kind);
      return id;
    },
    [schedule],
  );
  const update = useCallback(
    (id: number, patch: Partial<Omit<Toast, "id">>) => {
      setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
      if (patch.kind) schedule(id, patch.kind);
    },
    [schedule],
  );
  const value = useMemo(() => ({ push, update, dismiss }), [push, update, dismiss]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(380px,calc(100vw-32px))] flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto rounded-card border bg-surface p-3 shadow-lg ${
              t.kind === "error" ? "border-bad/50" : t.kind === "success" ? "border-good/50" : "border-line"
            }`}
          >
            <div className="flex items-start gap-2">
              <span
                className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${
                  t.kind === "error" ? "bg-bad" : t.kind === "success" ? "bg-good" : t.kind === "pending" ? "animate-pulse bg-stable" : "bg-muted"
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-ink">{t.title}</div>
                {t.body && <div className="mt-0.5 break-words text-xs text-muted">{t.body}</div>}
                {t.lines && t.lines.length > 0 && (
                  <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-muted">
                    {t.lines.slice(0, 6).map((l, i) => (
                      <li key={i} className="break-all">
                        {l}
                      </li>
                    ))}
                  </ul>
                )}
                {t.href && (
                  <a className="mt-1 inline-block text-xs font-medium text-stable hover:underline" href={t.href} target="_blank" rel="noreferrer">
                    {t.hrefLabel ?? "View on BscScan"} ↗
                  </a>
                )}
              </div>
              <button className="text-xs text-faint hover:text-ink" onClick={() => dismiss(t.id)} aria-label="Dismiss">
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast(): Ctx {
  const c = useContext(ToastCtx);
  if (!c) throw new Error("useToast outside ToastProvider");
  return c;
}
