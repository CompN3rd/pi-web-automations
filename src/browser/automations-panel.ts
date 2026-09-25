import type {
  HtmlTemplateTag,
  PluginContributions,
  SvgTemplateTag,
  WorkspacePanelContext,
  WorkspacePanelContribution,
} from "@jmfederico/pi-web/plugin-api";
import {
  AutomationsController,
  availableThinkingLevels,
  hasActiveRuns,
  type AutomationEditor,
  type AutomationPanelState,
} from "./automations-controller.js";
import type {
  AutomationDefinition,
  AutomationModelPolicy,
  AutomationRun,
  AutomationThinkingPolicy,
  AutomationTrigger,
  AutomationUsageSnapshot,
} from "./contracts.js";

import { automationColor, costSummary, formatCost, runTimeline, sessionHref } from "./run-visualization.js";

const AUTOMATIONS_PANEL_ID = "workspace.automations";
const activityElementTag = "pi-web-automations-activity";

export function createAutomationsBrowserContributions(html: HtmlTemplateTag, svg: SvgTemplateTag): PluginContributions {
  const controller = new AutomationsController();
  defineActivityElement();
  return { workspacePanels: [createPanel(html, svg, controller)] };
}

function createPanel(html: HtmlTemplateTag, svg: SvgTemplateTag, controller: AutomationsController): WorkspacePanelContribution {
  return {
    id: AUTOMATIONS_PANEL_ID,
    title: "Automations",
    order: 25,
    icon: svg`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4M16 2v4M3 10h18"/><rect x="3" y="4" width="18" height="17" rx="2"/><path d="m9 15 2 2 4-4"/></svg>`,
    visible: (context) => context.peer?.request !== undefined,
    badge: (context) => {
      const snapshot = controller.state(context).snapshot;
      const active = snapshot?.runs.filter((run) => activeRun(run)).length ?? 0;
      return active === 0 ? undefined : active;
    },
    onInvalidate: (context) => controller.invalidate(context),
    render: (context) => renderPanel(html, controller, context),
  };
}

function renderPanel(html: HtmlTemplateTag, controller: AutomationsController, context: WorkspacePanelContext) {
  const state = controller.state(context);
  return html`
    <section class="automations-panel">
      <style .textContent=${styles}></style>
      <pi-web-automations-activity .controller=${controller} .context=${context}></pi-web-automations-activity>
      <header class="automations-toolbar">
        <div><h2>Automations</h2><p>Machine-local schedules for ${context.workspace.label}</p></div>
        <div class="actions">
          <button type="button" ?disabled=${state.loading || state.mutating} @click=${() => { void controller.refresh(context); }}>Refresh</button>
          <button type="button" ?disabled=${state.mutating} @click=${() => { controller.beginCreate(context); }}>New automation</button>
        </div>
      </header>
      ${state.error === undefined ? null : html`<div class="message error" role="alert">${state.error}</div>`}
      ${state.notice === undefined ? null : html`<div class="message" role="status">${state.notice}</div>`}
      ${state.editor === undefined ? null : renderEditor(html, controller, context, state)}
      ${renderDefinitions(html, controller, context, state)}
      ${renderRuns(html, controller, context, state)}
    </section>
  `;
}

function renderEditor(html: HtmlTemplateTag, controller: AutomationsController, context: WorkspacePanelContext, state: AutomationPanelState) {
  const editor = state.editor;
  if (editor === undefined) return null;
  const snapshot = state.snapshot;
  const thinkingLevels = availableThinkingLevels(snapshot, editor.model);
  // The select value binding precedes iterable option insertion on first mount;
  // selected attributes also establish the saved policy's initial selection.
  return html`
    <form class="automation-editor" @submit=${(event: SubmitEvent) => { event.preventDefault(); void controller.saveEditor(context); }}>
      <header><h3>${editor.automationId === undefined ? "Create automation" : "Edit automation"}</h3><span>Saved definition changes require another successful test run.</span></header>
      <div class="form-grid">
        <label>Name<input required maxlength="120" .value=${editor.name} @input=${(event: Event) => { controller.updateEditor(context, { name: inputValue(event) }); }}></label>
        <label>Description<input maxlength="500" .value=${editor.description} @input=${(event: Event) => { controller.updateEditor(context, { description: inputValue(event) }); }}></label>
        <label class="wide">Prompt<textarea required rows="6" .value=${editor.prompt} @input=${(event: Event) => { controller.updateEditor(context, { prompt: inputValue(event) }); }}></textarea></label>
        ${renderTriggerEditor(html, controller, context, editor)}
        ${renderModelEditor(html, controller, context, editor)}
        <label>Thinking
          <select .value=${thinkingValue(editor.thinking)} @change=${(event: Event) => { controller.updateEditor(context, { thinking: parseThinking(inputValue(event)) }); }}>
            <option value="default" ?selected=${editor.thinking.mode === "default"}>Machine default</option>
            ${thinkingLevels.map((level) => html`<option value=${`fixed:${level}`} ?selected=${editor.thinking.mode === "fixed" && editor.thinking.level === level}>${level}</option>`)}
          </select>
        </label>
        <label>Timeout (minutes)<input required type="number" min=${minutes(snapshot?.minTimeoutMs ?? 1)} max=${minutes(snapshot?.maxTimeoutMs ?? 86_400_000)} step="1" .value=${String(minutes(editor.timeoutMs))} @input=${(event: Event) => { controller.updateEditor(context, { timeoutMs: Math.round(Number(inputValue(event)) * 60_000) }); }}></label>
      </div>
      <div class="actions"><button type="submit" ?disabled=${state.mutating}>${editor.automationId === undefined ? "Create disabled draft" : "Save changes"}</button><button type="button" @click=${() => { controller.cancelEdit(context); }}>Cancel</button></div>
    </form>
  `;
}

function renderTriggerEditor(html: HtmlTemplateTag, controller: AutomationsController, context: WorkspacePanelContext, editor: AutomationEditor) {
  const trigger = editor.trigger;
  return html`
    <label>Schedule
      <select .value=${trigger.type} @change=${(event: Event) => { controller.updateEditor(context, { trigger: defaultTrigger(inputValue(event)) }); }}>
        <option value="manual">Manual only</option><option value="once">One time</option><option value="interval">Interval</option><option value="cron">Cron</option>
      </select>
    </label>
    ${trigger.type === "once" ? html`<label>Run at<input required type="datetime-local" .value=${toLocalDateTime(trigger.at)} @input=${(event: Event) => { controller.updateEditor(context, { trigger: updatedOnceTrigger(inputValue(event), trigger) }); }}></label>` : null}
    ${trigger.type === "interval" ? html`<label>Interval (minutes)<input required type="number" min="1" step="1" .value=${String(Math.round(trigger.intervalMs / 60_000))} @input=${(event: Event) => { controller.updateEditor(context, { trigger: { type: "interval", intervalMs: Math.round(Number(inputValue(event)) * 60_000) } }); }}></label>` : null}
    ${trigger.type === "cron" ? html`
      <label>Six-field cron<input required aria-describedby="automation-cron-help" .value=${trigger.expression} @input=${(event: Event) => { controller.updateEditor(context, { trigger: { ...trigger, expression: inputValue(event) } }); }}><small id="automation-cron-help">second minute hour day month weekday</small></label>
      <label>Time zone<input required list="automation-timezones" .value=${trigger.timeZone} @input=${(event: Event) => { controller.updateEditor(context, { trigger: { ...trigger, timeZone: inputValue(event) } }); }}><datalist id="automation-timezones"><option value="UTC"></option><option value=${localTimeZone()}></option></datalist></label>
    ` : null}
  `;
}

function renderModelEditor(html: HtmlTemplateTag, controller: AutomationsController, context: WorkspacePanelContext, editor: AutomationEditor) {
  const policy = editor.model;
  return html`
    <label>Model policy
      <select .value=${policy.mode} @change=${(event: Event) => { controller.updateEditor(context, { model: inputValue(event) === "fixed" ? { mode: "fixed", provider: "", id: "" } : { mode: "default" } }); }}>
        <option value="default">Machine default</option><option value="fixed">Fixed provider/model</option>
      </select>
    </label>
    ${policy.mode === "fixed" ? html`
      <label>Provider<input required .value=${policy.provider} @input=${(event: Event) => { controller.updateEditor(context, { model: { ...policy, provider: inputValue(event) } }); }}></label>
      <label>Model id<input required .value=${policy.id} @input=${(event: Event) => { controller.updateEditor(context, { model: { ...policy, id: inputValue(event) } }); }}></label>
    ` : null}
    <p>No pre-session model catalog is available. Fixed policies are validated by the companion at test/run; they never fall back.</p>
  `;
}

function renderDefinitions(html: HtmlTemplateTag, controller: AutomationsController, context: WorkspacePanelContext, state: AutomationPanelState) {
  const definitions = state.snapshot?.definitions;
  if (definitions === undefined) return html`<p class="empty">${state.loading ? "Loading automations…" : "Automations unavailable."}</p>`;
  if (definitions.length === 0) return html`<section><h3>Definitions</h3><p class="empty">No automations yet. Create a disabled draft, run it successfully, then enable its schedule.</p></section>`;
  return html`
    <section><h3>Definitions</h3><div class="cards">${definitions.map((definition) => renderDefinition(html, controller, context, state, definition))}</div></section>
  `;
}

function renderDefinition(html: HtmlTemplateTag, controller: AutomationsController, context: WorkspacePanelContext, state: AutomationPanelState, definition: AutomationDefinition) {
  const tested = definition.testedRevision === definition.revision;
  const runs = (state.snapshot?.runs ?? []).filter((run) => run.automationId === definition.id);
  const latestSession = [...runs].filter((run) => run.sessionId !== undefined).sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))[0];
  const statistics = state.snapshot?.costStatistics;
  const stats = statistics?.find((entry) => entry.automationId === definition.id) ?? { count: 0, priced: 0, totalMicros: 0 };
  const costs = statistics === undefined ? costSummary(runs) : { count: stats.count, priced: stats.priced, total: stats.priced === 0 ? undefined : stats.totalMicros, average: stats.priced === 0 ? undefined : stats.totalMicros / stats.priced };
  return html`
    <article class="definition-card" style=${`border-top:3px solid ${automationColor(definition.id)}`}>
      <header><div><h4>${definition.name}</h4>${definition.description === undefined ? null : html`<p>${definition.description}</p>`}</div><span class=${definition.enabled ? "status enabled" : "status"}>${definition.enabled ? "enabled" : "paused"}</span></header>
      <dl><div><dt>Schedule</dt><dd>${formatTrigger(definition.trigger)}</dd></div><div><dt>Model</dt><dd>${formatModel(definition.model)}</dd></div><div><dt>Thinking</dt><dd>${formatThinking(definition.thinking)}</dd></div><div><dt>Revision</dt><dd>${definition.revision}${tested ? " · tested" : " · needs test"}</dd></div><div><dt>Next run</dt><dd>${definition.nextRunAt === undefined ? "—" : formatDate(definition.nextRunAt)}</dd></div></dl>
      <div class="cost-summary"><strong>Estimated costs · ${statistics === undefined ? "recent history" : "all retained history"}</strong><dl><div><dt>Total</dt><dd>${formatCost(costs.total)}</dd></div><div><dt>Average / priced run</dt><dd>${formatCost(costs.average)}</dd></div></dl><small>${costs.priced} of ${costs.count} runs have cost data. Includes partial usage.${statistics === undefined ? " Limited to loaded history." : ""}</small></div>
      ${latestSession === undefined ? null : renderSessionLink(html, context, latestSession, "Open latest session")}
      <details><summary>Prompt</summary><pre>${definition.prompt}</pre></details>
      <div class="actions">
        <button type="button" ?disabled=${state.mutating} @click=${() => { void controller.runNow(context, definition); }}>Run now / test</button>
        <button type="button" ?disabled=${state.mutating} @click=${() => { controller.beginEdit(context, definition); }}>Edit</button>
        <button type="button" ?disabled=${state.mutating || (!definition.enabled && !tested)} title=${!definition.enabled && !tested ? "Run this exact revision successfully before enabling" : ""} @click=${() => { void controller.setEnabled(context, definition, !definition.enabled); }}>${definition.enabled ? "Pause" : "Enable"}</button>
        <button type="button" class="danger" ?disabled=${state.mutating} @click=${() => { if (globalThis.confirm(`Delete ${definition.name}? Run history is retained.`)) void controller.delete(context, definition); }}>Delete</button>
      </div>
    </article>
  `;
}

function renderRuns(html: HtmlTemplateTag, controller: AutomationsController, context: WorkspacePanelContext, state: AutomationPanelState) {
  const runs = state.snapshot?.runs ?? [];
  return html`
    <section class="runs"><h3>Recent runs</h3>
      ${renderTimeline(html, context, runs)}
      ${runs.length === 0 ? html`<p class="empty">No runs yet.</p>` : html`
        <div class="table-scroll"><table><caption>Recent automation run history and usage</caption><thead><tr><th>Automation</th><th>Status</th><th>Queued / duration</th><th>Model / thinking</th><th>Usage</th><th>Details</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
          ${runs.map((run) => html`<tr><td><strong>${run.automationName}</strong><small>${run.source} · revision ${run.automationRevision}</small></td><td><span class=${`run-status ${run.status}`}>${run.status.replaceAll("_", " ")}</span></td><td>${formatDate(run.queuedAt)}<small>${formatDuration(run)}</small></td><td>${run.actualModel?.name ?? formatModel(run.configuredModel)}<small>${run.actualThinkingLevel ?? formatThinking(run.configuredThinking)}</small></td><td>${formatUsage(run.usage)}</td><td>${renderRunDetails(html, context, run)}</td><td>${activeRun(run) ? html`<button type="button" ?disabled=${state.mutating || run.status === "cancelling"} @click=${() => { void controller.cancelRun(context, run); }}>Cancel</button>` : null}</td></tr>`)}
        </tbody></table></div>`}
    </section>
  `;
}

function renderSessionLink(html: HtmlTemplateTag, context: WorkspacePanelContext, run: AutomationRun, label = "Open session") {
  return run.sessionId === undefined ? null : html`<a href=${sessionHref(context.machine.id, context.workspace.projectId, context.workspace.id, run.sessionId)}>${label}</a>`;
}

function renderTimeline(html: HtmlTemplateTag, context: WorkspacePanelContext, runs: AutomationRun[]) {
  if (runs.length === 0) return null;
  const timeline = runTimeline(runs);
  const legend = [...new Map(runs.map((run) => [run.automationId, run.automationName])).entries()];
  return html`<details class="run-timeline" open><summary>Run timeline · ${runs.length} recent runs</summary>
    <div class="timeline-legend">${legend.map(([id, name]) => html`<span><i style=${`background:${automationColor(id)}`}></i>${name}</span>`)}</div>
    <div class="timeline-axis"><span>${formatDate(new Date(timeline.start).toISOString())}</span><span>${formatDate(new Date(timeline.end).toISOString())}</span></div>
    <div class="timeline-lanes">${timeline.blocks.map(({ run, left, width }) => {
      const label = `${run.automationName} · ${run.status.replaceAll("_", " ")} · ${formatDate(run.startedAt ?? run.queuedAt)} · ${formatDuration(run)}`;
      const style = `left:min(${String(left)}%, calc(100% - 6px));width:${String(width)}%;background:${automationColor(run.automationId)}`;
      return html`<div class="timeline-lane">${run.sessionId === undefined ? html`<span class="timeline-block" style=${style} tabindex="0" title=${label} aria-label=${label}></span>` : html`<a class="timeline-block" style=${style} href=${sessionHref(context.machine.id, context.workspace.projectId, context.workspace.id, run.sessionId)} title=${label} aria-label=${label}></a>`}</div>`;
    })}</div><small>Blocks show start to finish (or now for active runs); colors identify automations. Hover or focus for run details.</small>
  </details>`;
}

function renderRunDetails(html: HtmlTemplateTag, context: WorkspacePanelContext, run: AutomationRun) {
  return html`${run.error === undefined ? null : html`<span class="run-error">${run.error}</span>`}${run.reason === undefined ? null : html`<small>Reason: ${run.reason}</small>`}${renderSessionLink(html, context, run)}${run.attempt?.forceStopped === true ? html`<small>Force stop requested; outcome unconfirmed.</small>` : null}`;
}

function activeRun(run: AutomationRun): boolean { return ["queued", "starting", "running", "cancelling"].includes(run.status); }
function minutes(ms: number): number { return Math.max(1, Math.round(ms / 60_000)); }
function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); }
function formatDuration(run: AutomationRun): string { if (run.startedAt === undefined) return "not started"; const end = run.completedAt === undefined ? Date.now() : new Date(run.completedAt).getTime(); const seconds = Math.max(0, Math.round((end - new Date(run.startedAt).getTime()) / 1000)); return seconds < 60 ? `${String(seconds)}s` : `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`; }
function formatUsage(usage: AutomationUsageSnapshot | undefined): string { if (usage === undefined) return "—"; const cost = usage.estimatedCostMicros === undefined ? "" : ` · $${(usage.estimatedCostMicros / 1_000_000).toFixed(4)}`; return `${usage.tokens.total.toLocaleString()} tokens${cost} (${usage.quality}${usage.scope === "assistant_messages" ? ", assistant messages; estimated cost" : ""})`; }
function formatTrigger(trigger: AutomationTrigger): string { if (trigger.type === "manual") return "Manual only"; if (trigger.type === "once") return `Once at ${formatDate(trigger.at)}`; if (trigger.type === "interval") return `Every ${String(minutes(trigger.intervalMs))} minutes`; return `${trigger.expression} (${trigger.timeZone})`; }
function formatModel(model: AutomationModelPolicy): string { return model.mode === "default" ? "Machine default" : (model.name ?? `${model.provider}/${model.id}`); }
function formatThinking(thinking: AutomationThinkingPolicy): string { return thinking.mode === "default" ? "Model default" : thinking.level; }
function thinkingValue(thinking: AutomationThinkingPolicy): string { return thinking.mode === "default" ? "default" : `fixed:${thinking.level}`; }
function parseThinking(value: string): AutomationThinkingPolicy { return value === "default" ? { mode: "default" } : { mode: "fixed", level: value.slice("fixed:".length) }; }
function defaultTrigger(type: string): AutomationTrigger { if (type === "once") return { type, at: new Date(Date.now() + 3_600_000).toISOString() }; if (type === "interval") return { type, intervalMs: 3_600_000 }; if (type === "cron") return { type, expression: "0 0 9 * * *", timeZone: localTimeZone() }; return { type: "manual" }; }
function updatedOnceTrigger(value: string, current: Extract<AutomationTrigger, { type: "once" }>): AutomationTrigger { const date = new Date(value); return Number.isNaN(date.getTime()) ? current : { type: "once", at: date.toISOString() }; }
function localTimeZone(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
function toLocalDateTime(value: string): string { const date = new Date(value); if (Number.isNaN(date.getTime())) return ""; const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000); return shifted.toISOString().slice(0, 16); }
function inputValue(event: Event): string {
  const target = event.currentTarget;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return target.value;
  throw new Error("Automations form event did not come from an input");
}

class AutomationsActivityElement extends HTMLElement {
  private currentController?: AutomationsController;
  private currentContext?: WorkspacePanelContext;
  private readonly onVisibility = (): void => { if (this.currentController !== undefined && this.currentContext !== undefined) this.currentController.visibilityChanged(this.currentContext, document.visibilityState !== "hidden"); };
  set controller(value: AutomationsController) { this.currentController = value; this.tryConnect(); }
  set context(value: WorkspacePanelContext) { this.currentContext = value; this.tryConnect(); }
  connectedCallback(): void { document.addEventListener("visibilitychange", this.onVisibility); this.tryConnect(); }
  disconnectedCallback(): void { document.removeEventListener("visibilitychange", this.onVisibility); if (this.currentController !== undefined && this.currentContext !== undefined) this.currentController.disconnect(this.currentContext); }
  private tryConnect(): void { if (this.isConnected && this.currentController !== undefined && this.currentContext !== undefined) this.currentController.connect(this.currentContext, document.visibilityState !== "hidden"); }
}
function defineActivityElement(): void { if (customElements.get(activityElementTag) === undefined) customElements.define(activityElementTag, AutomationsActivityElement); }

const styles = `
.automations-panel a{color:var(--color-link,#79b8ff)}.cost-summary{display:grid;gap:6px;font-size:12px}.run-timeline{border:1px solid var(--color-border);border-radius:8px;padding:12px;margin-bottom:14px}.timeline-legend{display:flex;flex-wrap:wrap;gap:12px;margin:10px 0;font-size:12px}.timeline-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}.timeline-axis{display:flex;justify-content:space-between;gap:12px;font-size:11px;color:var(--color-text-muted);margin-bottom:6px}.timeline-lanes{max-height:320px;overflow-y:auto}.timeline-lane{position:relative;height:22px;border-bottom:1px solid var(--color-border)}.timeline-block{position:absolute;top:3px;height:15px;min-width:6px;max-width:100%;border-radius:3px;box-sizing:border-box}.timeline-block:focus-visible{outline:2px solid var(--color-text);outline-offset:1px}

.automations-panel{padding:16px;display:grid;gap:18px;color:var(--color-text)} h2,h3,h4,p{margin:0}.automations-toolbar,.automations-toolbar>div,.definition-card header,.automation-editor header{display:flex;align-items:center;justify-content:space-between;gap:12px}.automations-toolbar p,.automation-editor header span,small,.empty{color:var(--color-text-muted);font-size:12px}.actions{display:flex;gap:8px;flex-wrap:wrap}button,input,select,textarea{font:inherit}button{border:1px solid var(--color-border);background:var(--color-bg-secondary);color:inherit;border-radius:6px;padding:6px 10px;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}button.danger{color:var(--color-danger,#e66)}.message{padding:9px 12px;border:1px solid var(--color-border);border-radius:6px}.message.error,.run-error{color:var(--color-danger,#e66)}.automation-editor,.definition-card{border:1px solid var(--color-border);border-radius:8px;padding:14px;display:grid;gap:12px;background:var(--color-bg-secondary)}.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.form-grid label{display:grid;gap:5px;font-size:13px}.form-grid .wide{grid-column:1/-1}input,select,textarea{box-sizing:border-box;width:100%;border:1px solid var(--color-border);background:var(--color-bg);color:inherit;border-radius:5px;padding:7px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px;margin-top:9px}.definition-card header{align-items:flex-start}.definition-card header p{color:var(--color-text-muted);margin-top:3px}.status,.run-status{border-radius:999px;padding:3px 7px;background:var(--color-bg);font-size:11px;white-space:nowrap}.status.enabled,.run-status.completed{color:var(--color-success,#6c6)}.run-status.failed,.run-status.timed_out,.run-status.unknown{color:var(--color-danger,#e66)}dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0}dl div{min-width:0}dt{font-size:11px;color:var(--color-text-muted)}dd{margin:2px 0 0;font-size:13px;overflow-wrap:anywhere}details pre{white-space:pre-wrap;max-height:180px;overflow:auto}.runs h3{margin-bottom:9px}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px}caption{text-align:left;color:var(--color-text-muted);padding-bottom:6px}th,td{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid var(--color-border)}td small{display:block;margin-top:3px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:700px){.automations-toolbar{align-items:flex-start;flex-direction:column}.cards{grid-template-columns:1fr}dl{grid-template-columns:1fr}}
`;

export { hasActiveRuns };
