import { join } from "node:path";
import type {
  PiWebServerPlugin,
  ServerPluginActivation,
  ServerPluginActivationContext,
  ServerPluginHealth,
} from "@jmfederico/pi-web/server-plugin-api";
import { AutomationBackend } from "./server/automation-backend.js";
import { AutomationService, type AutomationServiceLogger } from "./server/automation-service.js";
import { AutomationSessionRunner } from "./server/automation-session-runner.js";
import { AutomationStore } from "./server/automation-store.js";

const plugin: PiWebServerPlugin = {
  apiVersion: 1,
  name: "Automations",
  activate: (context) => createAutomationActivation(context),
};

export default plugin;

export function createAutomationActivation(context: ServerPluginActivationContext): ServerPluginActivation {
  let store: AutomationStore | undefined;
  let service: AutomationService | undefined;
  let phase: "inactive" | "started" | "ready" | "quiescing" | "stopped" | "failed" = "inactive";
  let failure: string | undefined;
  const backend = new AutomationBackend(() => phase === "ready" ? service : undefined);

  return {
    workspaceBackend: { request: (request) => backend.request(request) },
    start() {
      try {
        store = new AutomationStore(join(context.stateDirectory, "automations.sqlite"));
        phase = "started";
      } catch (error) {
        phase = "failed";
        failure = errorMessage(error);
        throw error;
      }
    },
    ready(readyContext) {
      if (store === undefined || phase !== "started") throw new Error("Automations store is not started");
      try {
        service = new AutomationService(store, new AutomationSessionRunner(readyContext.backgroundSessions), pluginLogger(context));
        service.start();
        phase = "ready";
      } catch (error) {
        phase = "failed";
        failure = errorMessage(error);
        throw error;
      }
    },
    async quiesce() {
      if (phase === "stopped" || phase === "quiescing") return;
      phase = "quiescing";
      await service?.stop(500);
    },
    async stop() {
      if (phase === "stopped") return;
      try {
        await service?.stop(250);
      } finally {
        if (service !== undefined) service.dispose();
        else store?.close();
        phase = "stopped";
      }
    },
    health(): ServerPluginHealth {
      if (phase === "ready") return { status: "healthy" };
      if (phase === "quiescing" || phase === "stopped") return { status: "degraded", message: `Automations service is ${phase}` };
      if (phase === "failed") return { status: "unhealthy", message: failure ?? "Automations service failed" };
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
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
