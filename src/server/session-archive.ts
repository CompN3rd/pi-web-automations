import type { PluginCatalogV1, PluginSessionLifecycleV1, PluginSessionSelection } from "@jmfederico/pi-web/server-plugin-api";

import { SESSION_ARCHIVE_BATCH_LIMIT, type SessionArchiveResult, type SessionArchiveSummary } from "../browser/session-archive-result.js";

/** Finite, sequential traversal; callers may continue only after receiving a settled batch. */
export class SessionArchiver {
  private readonly active = new Set<string>();
  constructor(private readonly catalog: PluginCatalogV1, private readonly lifecycle: PluginSessionLifecycleV1) {}

  async batch(key: string, scope: { projectId: string; workspaceId: string }, page: (after?: string) => string[], signal: AbortSignal, deadline: number, after?: string): Promise<SessionArchiveSummary> {
    if (this.active.has(key)) throw new Error("Session archive request still in flight; inspect and retry later");
    this.active.add(key);
    const pending: Promise<unknown>[] = [];
    const timeout = new AbortController();
    const combined = AbortSignal.any([signal, timeout.signal]);
    const results: SessionArchiveResult[] = [];
    let cursor = after ?? "";
    let stopReason: SessionArchiveSummary["stopReason"];
    const summary = (traversalComplete: boolean): SessionArchiveSummary => ({ results, traversalComplete,
      ...(traversalComplete ? {} : { continuationAfter: cursor }), ...(stopReason ? { stopReason } : {}) });
    const call = async <T>(work: () => Promise<T>): Promise<T> => {
      combined.throwIfAborted();
      const remaining = Math.min(750, deadline - Date.now() - 500);
      if (remaining <= 0) {
        stopReason = "budget";
        timeout.abort(new Error("Session archive request budget exhausted; remaining sessions not attempted"));
        combined.throwIfAborted();
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      try {
        const cancelled = new Promise<never>((_resolve, reject) => {
          abort = () => { reject(combined.reason instanceof Error ? combined.reason : new Error("Session archive cancelled")); };
          combined.addEventListener("abort", abort, { once: true });
          timer = setTimeout(() => {
            stopReason = "timeout";
            timeout.abort(new Error("Session operation timed out; reconcile before retry"));
          }, remaining);
        });
        const value = await Promise.race([work(), cancelled]);
        combined.throwIfAborted();
        return value;
      } finally {
        clearTimeout(timer);
        if (abort) combined.removeEventListener("abort", abort);
      }
    };
    try {
      signal.throwIfAborted();
      while (results.length < SESSION_ARCHIVE_BATCH_LIMIT) {
        let ids: string[];
        try { ids = page(cursor); }
        catch (error) {
          if (results.length === 0) throw error;
          stopReason = "blocked";
          return summary(false);
        }
        const sessionId = ids[0];
        if (sessionId === undefined) return summary(true);
        const admission = { started: false, fenced: false };
        const target: PluginSessionSelection = { ...scope, sessionId };
        let result: SessionArchiveResult;
        try {
          const snapshot = await call(() => this.catalog.sessions.get(target, { signal: combined }));
          const state = await call(() => this.lifecycle.get(target, { signal: combined }));
          if (snapshot.id !== sessionId || state.sessionId !== sessionId) throw new Error("Host returned a different session identity");
          if (state.archived) result = { sessionId, status: "already-archived" };
          else if (state.pinned || !isUnpinned(snapshot.pinned)) result = { sessionId, status: "skipped-pinned" };
          else if (snapshot.runtime !== "idle" && snapshot.runtime !== "not-hosted") result = { sessionId, status: "skipped-busy" };
          else {
            // No await between the fresh automation fence and admission of this mutation.
            await call(() => {
              try { page(cursor); } catch (error) { admission.fenced = true; throw error; }
              combined.throwIfAborted();
              admission.started = true;
              const operation = this.lifecycle.archive(target, { signal: combined });
              pending.push(operation);
              return operation;
            });
            result = { sessionId, status: "archived" };
          }
        } catch (error) {
          if (signal.aborted) stopReason = "cancelled";
          if (admission.fenced) stopReason = "blocked";
          result = { sessionId, status: admission.started ? "uncertain" : combined.aborted ? "deferred" : "failed", detail: (error instanceof Error ? error.message : String(error)).slice(0, 1000) };
        }
        results.push(result);
        if (result.status !== "deferred") cursor = sessionId;
        if (stopReason) return summary(false);
        if (ids.length === 1) return summary(true);
      }
      return summary(false);
    } finally {
      // An admitted operation may outlive its reply deadline. Keep the fence until it settles.
      if (combined.aborted && pending.length > 0) void Promise.allSettled(pending).then(() => { this.active.delete(key); });
      else { await Promise.allSettled(pending); this.active.delete(key); }
    }
  }
}

function isUnpinned(value: unknown): boolean { return value === false; }
