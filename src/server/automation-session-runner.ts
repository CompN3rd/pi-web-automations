import type {
  BackgroundSessionLease,
  BackgroundSessionModel,
  BackgroundSessionPromptResult,
  BackgroundSessionService,
  BackgroundSessionSnapshot,
  BackgroundSessionUsage,
} from "@jmfederico/pi-web/server-plugin-api";
import type {
  AutomationModel,
  AutomationModelPolicy,
  AutomationThinkingPolicy,
  AutomationUsageSnapshot,
} from "./contracts.js";

export interface CreatedAutomationSession {
  sessionId: string;
  lease: BackgroundSessionLease;
  actualModel?: AutomationModel;
  actualThinkingLevel?: string;
}

export class AutomationSessionRunner {
  constructor(private readonly sessions: BackgroundSessionService) {}

  models(): AutomationModel[] {
    return this.sessions.listModels().map(modelFromHost);
  }

  async create(input: {
    projectId: string;
    workspaceId: string;
    model: AutomationModelPolicy;
    thinking: AutomationThinkingPolicy;
  }, onCreated: (session: CreatedAutomationSession) => void): Promise<CreatedAutomationSession> {
    if (input.model.mode === "fixed") this.requireAvailableModel(input.model.provider, input.model.id);
    const lease = await this.sessions.create({
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      ...(input.model.mode === "fixed" ? { model: { provider: input.model.provider, id: input.model.id } } : {}),
      ...(input.thinking.mode === "fixed" ? { thinkingLevel: input.thinking.level } : {}),
    });
    const snapshot = await lease.snapshot();
    const created = createdFromSnapshot(lease, snapshot);
    onCreated(created);
    return created;
  }

  async run(session: CreatedAutomationSession, prompt: string, capturedAt: () => string): Promise<AutomationUsageSnapshot> {
    const result = await session.lease.prompt(prompt);
    if (result.status === "failed") throw new AutomationPromptError(result.error ?? "Automation prompt failed", result);
    if (result.status === "aborted") throw new AutomationPromptError("Automation prompt was aborted", result);
    return usageFromHost(result.usage, capturedAt());
  }

  async snapshot(session: CreatedAutomationSession, capturedAt: string): Promise<AutomationUsageSnapshot | undefined> {
    try {
      return usageFromHost((await session.lease.snapshot()).usage, capturedAt);
    } catch {
      return undefined;
    }
  }

  abort(session: CreatedAutomationSession): Promise<void> {
    return session.lease.abort();
  }

  forceStop(session: CreatedAutomationSession): Promise<void> {
    return session.lease.forceStop();
  }

  release(session: CreatedAutomationSession): Promise<void> {
    return session.lease.release();
  }

  private requireAvailableModel(provider: string, modelId: string): void {
    if (!this.models().some((model) => model.provider === provider && model.id === modelId)) {
      throw new Error(`Configured model is unavailable: ${provider}/${modelId}`);
    }
  }
}

export class AutomationPromptError extends Error {
  constructor(message: string, readonly result: BackgroundSessionPromptResult) {
    super(message);
  }
}

function modelFromHost(model: BackgroundSessionModel): AutomationModel {
  return { provider: model.provider, id: model.id, name: model.name, thinkingLevels: [...model.thinkingLevels] };
}

function createdFromSnapshot(lease: BackgroundSessionLease, snapshot: BackgroundSessionSnapshot): CreatedAutomationSession {
  return {
    sessionId: lease.sessionId,
    lease,
    ...(snapshot.model === undefined ? {} : { actualModel: { ...snapshot.model, thinkingLevels: [] } }),
    actualThinkingLevel: snapshot.thinkingLevel,
  };
}

function usageFromHost(usage: BackgroundSessionUsage, capturedAt: string): AutomationUsageSnapshot {
  const estimatedCostMicros = usage.estimatedCostUsd === undefined
    ? undefined
    : Math.round(usage.estimatedCostUsd * 1_000_000);
  return {
    scope: "root_session",
    quality: "estimated",
    tokens: {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      total: usage.total,
    },
    ...(estimatedCostMicros === undefined ? {} : { estimatedCostMicros }),
    capturedAt,
  };
}
