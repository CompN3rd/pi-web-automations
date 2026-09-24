import { join } from "node:path";
import { PI_WEB_HOST_PI_SESSIONS_CAPABILITY, PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY, PI_WEB_HOST_WORKSPACES_CAPABILITY } from "@jmfederico/pi-web/server-plugin-api";
import type { PiWebServerPlugin, ServerPluginActivation, ServerPluginActivationContext } from "@jmfederico/pi-web/server-plugin-api";
import { AutomationBackend } from "./server/automation-backend.js";
import { AutomationService, type AutomationServiceLogger } from "./server/automation-service.js";
import { AutomationSessionRunner } from "./server/automation-session-runner.js";
import { AutomationStore } from "./server/automation-store.js";

const plugin: PiWebServerPlugin = {
  apiVersion: 3,
  name: "Automations",
  requires: [PI_WEB_HOST_PI_SESSIONS_CAPABILITY, PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY, PI_WEB_HOST_WORKSPACES_CAPABILITY],
  activate: createAutomationActivation,
};
export default plugin;

export function createAutomationActivation(context: ServerPluginActivationContext): ServerPluginActivation {
  let store: AutomationStore | undefined;
  let service: AutomationService | undefined;
  let phase = "inactive";
  let failure: string | undefined;
  const backend = new AutomationBackend(() => phase === "ready" && !context.lifetimeSignal.aborted ? service : undefined);
  const quiesce = () => {
    phase = "stopping";
    // Synchronously stop ingress, scheduling and deadlines before host disposal disconnects dependencies.
    void service?.stop().catch((error: unknown) => { context.logger.error(`Automations shutdown failed: ${String(error)}`); });
  };
  context.lifetimeSignal.addEventListener("abort", quiesce, { once: true });
  return {
    peer: { request(request) { request.signal.throwIfAborted(); context.lifetimeSignal.throwIfAborted(); return backend.request(request); } },
    start({ capabilities }) {
      try {
        context.lifetimeSignal.throwIfAborted();
        const sessions = capabilities.resolve(PI_WEB_HOST_PI_SESSIONS_CAPABILITY);
        const events = capabilities.resolve(PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY);
        const workspaces = capabilities.resolve(PI_WEB_HOST_WORKSPACES_CAPABILITY);
        store = new AutomationStore(join(context.dataDirectory, "automations.sqlite"));
        service = new AutomationService(store, new AutomationSessionRunner(sessions, events, workspaces, context.lifetimeSignal), pluginLogger(context));
        service.start();
        phase = "ready";
      } catch (error) {
        phase = "failed";
        failure = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
    async dispose() {
      if (phase === "stopped") return;
      context.lifetimeSignal.removeEventListener("abort", quiesce);
      try { await service?.stop(); }
      finally {
        if (service) service.dispose(); else store?.close();
        phase = "stopped";
      }
    },
    health() {
      if (phase === "ready") return { status: "healthy" };
      if (phase === "failed") return { status: "unhealthy", message: failure ?? "Automations failed" };
      return { status: "degraded", message: `Automations service is ${phase}` };
    },
  };
}
function pluginLogger(context: ServerPluginActivationContext): AutomationServiceLogger {
  return {
    info: (details, message) => { context.logger.info(message, jsonDetails(details)); },
    warn: (details, message) => { context.logger.warn(message, jsonDetails(details)); },
    error: (details, message) => { context.logger.error(message, jsonDetails(details)); },
  };
}
function jsonDetails(details: Record<string, unknown>): Record<string, string | number | boolean | null> {
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [key, jsonScalar(value)]));
}
function jsonScalar(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Error) return value.message;
  try { return JSON.stringify(value); } catch { return Object.prototype.toString.call(value); }
}
