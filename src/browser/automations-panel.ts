import type {
  HtmlTemplateTag,
  PluginContributionsV5,
  SvgTemplateTag,
  WorkspacePanelContextV5,
  WorkspacePanelContributionV5,
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

import { automationColor, costSummary, formatCost, runTimeline, sessionHref, TIMELINE_HEIGHT } from "./run-visualization.js";



const AUTOMATIONS_PANEL_ID = "workspace.automations";
const activityElementTag = "pi-web-automations-activity";

export function createAutomationsBrowserContributions(html: HtmlTemplateTag, svg: SvgTemplateTag): PluginContributionsV5 {
  const controller = new AutomationsController();
  defineActivityElement();
  return { workspacePanels: [createPanel(html, svg, controller)] };
}

function createPanel(html: HtmlTemplateTag, svg: SvgTemplateTag, controller: AutomationsController): WorkspacePanelContributionV5 {
  return {
    id: AUTOMATIONS_PANEL_ID,
    title: "Automations",
    order: 25,
    icon: svg`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4M16 2v4M3 10h18"/><rect x="3" y="4" width="18" height="17" rx="2"/><path d="m9 15 2 2 4-4"/></svg>`,
    visible: (context) => context.peer?.request !== undefined && context.backend !== undefined,
    badge: (context) => {
      const snapshot = controller.state(context).snapshot;
      const active = snapshot?.runs.filter((run) => activeRun(run)).length ?? 0;
      return active === 0 ? undefined : active;
    },
    onInvalidate: (context) => controller.invalidate(context),
    render: (context) => renderPanel(html, controller, context),
  };
}

function renderPanel(html: HtmlTemplateTag, controller: AutomationsController, context: WorkspacePanelContextV5) {
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
      ${state.sessionArchive === undefined ? null : html`<section class="message" role="status" aria-label="Session archive batch results">
        <strong>Session archive progress · ${state.sessionArchive.automationId}</strong>
        <p>${state.sessionArchive.summary.results.length} recorded session outcomes · ${state.sessionArchive.summary.results.filter((result) => result.status === "archived" || result.status === "already-archived").length} confirmed archived · ${state.sessionArchive.summary.results.filter((result) => result.status.startsWith("skipped-")).length} skipped · ${state.sessionArchive.summary.results.filter((result) => ["failed", "uncertain", "deferred"].includes(result.status)).length} need attention.</p>
        ${state.sessionArchive.unconfirmedBatch === undefined ? html`<p>${state.archiveCancellation ? "Processing all recorded sessions automatically in bounded batches…" : state.sessionArchive.summary.traversalComplete ? "Traversal finished; skipped, failed or uncertain sessions are not confirmed archived." : "Traversal stopped; remaining sessions were not attempted. Inspect before continuing."}</p>` : html`<p role="alert">${state.sessionArchive.unconfirmedBatch} Sessions in the unconfirmed batch may already be archived. Snapshot refresh does not reconcile these outcomes.</p>`}
        ${state.sessionArchive.summary.results.map((result) => html`<p><code>${result.sessionId}</code>: ${result.status}${result.detail !== undefined ? ` — ${result.detail}` : ""}</p>`)}
        ${state.archiveCancellation ? html`<button type="button" @click=${() => { controller.stopSessionArchive(context); }}>Stop session archive</button>` : state.sessionArchive.summary.traversalComplete ? null : html`<button type="button" ?disabled=${state.mutating} @click=${() => { void controller.continueSessionArchive(context); }}>Continue remaining sessions</button>`}
        <p>To retry skipped/failed/uncertain sessions, select this automation in Archived and use Archive sessions / retry. This rechecks host state from the start. No automatic retry after a lost reply.</p>
      </section>`}
      ${state.editor === undefined ? null : renderEditor(html, controller, context, state)}
      ${renderDefinitions(html, controller, context, state)}
    </section>
  `;
}

function renderEditor(html: HtmlTemplateTag, controller: AutomationsController, context: WorkspacePanelContextV5, state: AutomationPanelState) {
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
        ${editor.automationId === undefined ? html`
          <label class="wide">Target workspace
            <select ?disabled=${state.mutating} .value=${JSON.stringify([editor.projectId, editor.workspaceId])} @change=${(event: Event) => {
              const target = state.targets?.find((item) => JSON.stringify([item.projectId, item.workspaceId]) === inputValue(event));
              if (target) controller.updateEditor(context, { projectId: target.projectId, workspaceId: target.workspaceId });
            }}>
              <option value=${JSON.stringify([context.workspace.projectId, context.workspace.id])} ?selected=${editor.projectId === context.workspace.projectId && editor.workspaceId === context.workspace.id}>Current: ${context.workspace.label} (${context.workspace.projectId} / ${context.workspace.id})</option>
              ${(state.targets ?? []).filter((target) => target.projectId !== context.workspace.projectId || target.workspaceId !== context.workspace.id).map((target) => html`<option value=${JSON.stringify([target.projectId, target.workspaceId])} ?selected=${editor.projectId === target.projectId && editor.workspaceId === target.workspaceId}>${target.label}</option>`)}
            </select>
            <small>Registered targets on ${context.machine.name}, including empty workspaces. The backend validates the selected IDs again when saving.</small>
          </label>
          ${state.targetError === undefined ? null : html`<p role="alert">${state.targetError} <button type="button" @click=${() => { void controller.discoverTargets(context); }}>Retry discovery</button></p>`}
        ` : html`<p class="wide">Target: ${editor.projectId} / ${editor.workspaceId} (saved target cannot be changed)</p>`}
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

function renderTriggerEditor(html: HtmlTemplateTag, controller: AutomationsController, context: WorkspacePanelContextV5, editor: AutomationEditor) {
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

function renderModelEditor(html: HtmlTemplateTag, controller: AutomationsController, context: WorkspacePanelContextV5, editor: AutomationEditor) {
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

function renderDefinitions(html: HtmlTemplateTag, controller: AutomationsController, context: WorkspacePanelContextV5, state: AutomationPanelState) {
  const definitions = state.snapshot?.definitions;
  if (definitions === undefined) return html`<p class="empty">${state.loading ? "Loading automations…" : "Automations unavailable."}</p>`;
  const archived = state.showArchived === true;
  const visible = definitions.filter((definition) => (definition.archivedAt !== undefined) === archived);
  const selected = visible.find((definition) => definition.id === state.selectedId);
  return html`
    <section class="automation-workbench" aria-label="Automation management">
      <nav class="automation-list" aria-label="Automations">
        <div class="view-switch" aria-label="Automation view">
          <button type="button" aria-pressed=${!archived} @click=${() => { controller.showArchived(context, false); }}>Current · ${definitions.filter((definition) => definition.archivedAt === undefined).length}</button>
          <button type="button" aria-pressed=${archived} @click=${() => { controller.showArchived(context, true); }}>Archived · ${definitions.filter((definition) => definition.archivedAt !== undefined).length}</button>
        </div>
        ${visible.length === 0 ? html`<p class="empty">${archived ? "No archived automations." : "No current automations. Create a disabled draft, test it, then enable its schedule."}</p>` : visible.map((definition) => html`
          <button type="button" class="automation-list-item" aria-current=${state.workspaceActivity !== true && selected?.id === definition.id ? "true" : "false"} @click=${() => { controller.selectDefinition(context, definition.id); }}>
            <strong>${definition.name}</strong><span class="list-state">${definition.archivedAt !== undefined ? "Archived" : definition.enabled ? "Enabled" : "Paused"} · ${formatTrigger(definition.trigger)}</span>
          </button>`)}
        <button type="button" class="activity-link" aria-pressed=${state.workspaceActivity === true} @click=${() => { controller.showWorkspaceActivity(context); }}>Workspace activity</button>
      </nav>
      <div class="automation-detail">
        ${state.workspaceActivity === true ? renderRuns(html, controller, context, state) : selected === undefined ? html`<p class="empty">${archived ? "Archived automations can be restored here. Restoring leaves scheduling paused." : "Select an automation to see its overview, runs, and configuration."}</p>` : renderDefinition(html, controller, context, state, selected)}
      </div>
    </section>
  `;
}

function renderDefinition(html: HtmlTemplateTag, controller: AutomationsController, context: WorkspacePanelContextV5, state: AutomationPanelState, definition: AutomationDefinition) {
  const tested = definition.testedRevision === definition.revision;
  const runs = (state.snapshot?.runs ?? []).filter((run) => run.automationId === definition.id);
  const latestSession = [...runs].filter((run) => run.sessionId !== undefined).sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))[0];
  const latestRun = [...runs].sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))[0];
  const archived = definition.archivedAt !== undefined;
  const tab = state.detailTab ?? "overview";
  const blocked = runs.some((run) => activeRun(run) || run.status === "unknown");
  const statistics = state.snapshot?.costStatistics;
  const stats = statistics?.find((entry) => entry.automationId === definition.id) ?? { count: 0, priced: 0, totalMicros: 0 };
  const costs = statistics === undefined ? costSummary(runs) : { count: stats.count, priced: stats.priced, total: stats.priced === 0 ? undefined : stats.totalMicros, average: stats.priced === 0 ? undefined : stats.totalMicros / stats.priced };
  return html`
    <article class="definition-card" style=${`border-top:3px solid ${automationColor(definition.id)}`}>
      <header><div><h3>${definition.name}</h3>${definition.description === undefined ? null : html`<p>${definition.description}</p>`}</div><span class=${definition.enabled ? "status enabled" : "status"}>${archived ? "archived" : definition.enabled ? "enabled" : "paused"}</span></header>
      <div class="actions definition-actions">
        ${archived ? html`<button type="button" class="primary" ?disabled=${state.mutating} @click=${() => { void controller.setArchived(context, definition, false); }}>Restore paused</button><button type="button" data-lifecycle-action="archive" ?disabled=${state.mutating || blocked} @click=${() => { controller.confirmLifecycle(context, definition, "archive"); }}>Archive sessions / retry</button>` : html`
          <button type="button" class="primary" ?disabled=${state.mutating} @click=${() => { void controller.runNow(context, definition); }}>Run now / test</button>
          <button type="button" ?disabled=${state.mutating || (!definition.enabled && !tested)} title=${!definition.enabled && !tested ? "Run this exact revision successfully before enabling" : ""} @click=${() => { void controller.setEnabled(context, definition, !definition.enabled); }}>${definition.enabled ? "Pause" : "Enable"}</button>
          <button type="button" ?disabled=${state.mutating} @click=${() => { controller.beginEdit(context, definition); }}>Edit</button>
          <button type="button" data-lifecycle-action="archive" ?disabled=${state.mutating || blocked} title="Archive pauses scheduling; active or unconfirmed runs must settle first" @click=${() => { controller.confirmLifecycle(context, definition, "archive"); }}>Archive</button>`}
        <button type="button" class="danger" data-lifecycle-action="delete" ?disabled=${state.mutating || runs.some(activeRun)} @click=${() => { controller.confirmLifecycle(context, definition, "delete"); }}>Delete</button>
      </div>
      ${state.confirmation?.definition.id !== definition.id ? null : html`
        <section class="lifecycle-confirmation" aria-label=${`Confirm ${state.confirmation.action}`}>
          <h4>${state.confirmation.action === "delete" ? "Delete" : "Archive"} ${state.confirmation.definition.name}?</h4>
          <p>${state.confirmation.action === "delete" ? "This removes the definition from management and cannot be undone. Run history is retained." : "Scheduling will pause and this automation will move to Archived. You can restore it later with scheduling paused."}</p>
          ${state.confirmation.action === "archive" ? html`<label><input type="checkbox" .checked=${state.confirmation.archiveSessions === true} ?disabled=${state.mutating} @change=${(event: Event) => { if (event.target instanceof HTMLInputElement) controller.setArchiveSessions(context, event.target.checked); }}> Also archive this automation’s sessions</label>
            <p class="session-retention">Unchecked by default. Sessions remain saved. Only exact recorded sessions, not descendants; pinned and busy sessions are skipped. All recorded sessions are processed automatically in bounded batches; progress and partial failures are shown. Stop prevents new work, not an admitted mutation. Retry from Archived rechecks host state. Restoring the automation never restores sessions.</p>` : html`<p class="session-retention">Sessions are retained. Permanent session deletion is outside this plugin’s scope.</p>`}
          <div class="actions"><button type="button" class=${state.confirmation.action === "delete" ? "danger" : "primary"} ?disabled=${state.mutating} @click=${() => { void controller.applyLifecycle(context); }}>Confirm ${state.confirmation.action}</button><button type="button" ?disabled=${state.mutating} @click=${(event: Event) => { focusDetailControl(event, `[data-lifecycle-action="${state.confirmation?.action ?? ""}"]`); controller.confirmLifecycle(context); }}>Cancel</button></div>
        </section>`}
      <nav class="detail-tabs" aria-label="Automation details">
        ${([ ["overview", "Overview"], ["runs", "Runs"], ["configuration", "Configuration"] ] as const).map(([id, label]) => html`<button type="button" data-detail-tab=${id} aria-pressed=${tab === id} @click=${() => { controller.showDetailTab(context, id); }}>${label}</button>`)}
      </nav>
      ${tab === "overview" ? html`
        <section class="schedule-summary"><h4>Schedule</h4><p>${formatTrigger(definition.trigger)}</p><small>${archived ? `Archived ${formatDate(definition.archivedAt ?? "")}` : definition.nextRunAt === undefined ? "No scheduled run" : `Next run ${formatDate(definition.nextRunAt)}`} · Revision ${definition.revision}${tested ? " tested" : " needs test"}</small></section>
        <section class="overview-metrics" aria-label="Run and cost summary">
          <div><h4>Latest run</h4><strong>${latestRun?.status.replaceAll("_", " ") ?? "No runs yet"}</strong><small>${latestRun === undefined ? "Run a test to get started" : `${formatDate(latestRun.queuedAt)} · ${formatDuration(latestRun)}`}</small>${latestSession === undefined ? null : renderSessionLink(html, context, latestSession, "Open latest session")}</div>
          <div><h4>Estimated total</h4><strong>${formatCost(costs.total)}</strong><small>${costs.priced} of ${costs.count} runs priced</small></div>
          <div><h4>Average / priced run</h4><strong>${formatCost(costs.average)}</strong><small>${statistics === undefined ? "Recent loaded history" : "All retained history"}</small></div>
        </section>
        <p class="usage-note">Estimated costs include partial usage.${statistics === undefined ? " Limited to loaded history." : ""}</p>
        <section class="recent-sessions"><header><h4>Recent runs</h4><button type="button" @click=${(event: Event) => { focusDetailControl(event, '[data-detail-tab="runs"]'); controller.showDetailTab(context, "runs"); }}>View run history</button></header>
          ${runs.length === 0 ? html`<p class="empty">No runs yet.</p>` : [...runs].sort((a, b) => b.queuedAt.localeCompare(a.queuedAt)).slice(0, 5).map((run) => html`<div class="recent-run"><span><span class=${`run-status ${run.status}`}>${run.status.replaceAll("_", " ")}</span><small>${formatDate(run.queuedAt)} · ${formatDuration(run)}</small></span>${renderRunDetails(html, context, run)}${activeRun(run) ? html`<button type="button" ?disabled=${state.mutating || run.status === "cancelling"} @click=${() => { void controller.cancelRun(context, run); }}>Cancel</button>` : null}</div>`)}
        </section>` : tab === "runs" ? renderRuns(html, controller, context, state, runs) : html`
        <section class="configuration"><h4>Execution settings</h4><dl><div><dt>Model</dt><dd>${formatModel(definition.model)}</dd></div><div><dt>Thinking</dt><dd>${formatThinking(definition.thinking)}</dd></div><div><dt>Timeout</dt><dd>${minutes(definition.timeoutMs)} minutes</dd></div><div><dt>Target</dt><dd>${definition.projectId} / ${definition.workspaceId}</dd></div><div><dt>Revision</dt><dd>${definition.revision}${tested ? " · tested" : " · needs test"}</dd></div></dl><h4>Prompt</h4><pre>${definition.prompt}</pre></section>`}
    </article>
  `;
}

function renderRuns(html: HtmlTemplateTag, controller: AutomationsController, context: WorkspacePanelContextV5, state: AutomationPanelState, runs = state.snapshot?.runs ?? []) {
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

function renderSessionLink(html: HtmlTemplateTag, context: WorkspacePanelContextV5, run: AutomationRun, label = "Open session") {
  return run.sessionId === undefined ? null : html`<a href=${sessionHref(context.machine.id, context.workspace.projectId, context.workspace.id, run.sessionId)}>${label}</a>`;
}

function renderTimeline(html: HtmlTemplateTag, context: WorkspacePanelContextV5, runs: AutomationRun[]) {
  if (runs.length === 0) return null;
  const timeline = runTimeline(runs);
  if (timeline.blocks.length === 0) return null;
  return html`<details class="run-timeline" open><summary>Run timeline · ${runs.length} recent runs</summary>
    <div class="timeline-scroll" tabindex="0" role="region" aria-label="Automation run timeline; time flows from top to bottom">
      <div class="timeline-grid" style=${`grid-template-columns:120px ${timeline.lanes.map((lane) => `minmax(${String(Math.max(140, lane.trackCount * 12))}px,1fr)`).join(" ")};--timeline-height:${String(TIMELINE_HEIGHT)}px`}>
        <div class="timeline-heading timeline-time-heading">Time ↓</div>
        ${timeline.lanes.map((lane) => html`<div class="timeline-heading"><i style=${`background:${automationColor(lane.automationId)}`}></i><strong>${lane.name}</strong></div>`)}
        <div class="timeline-axis">${timeline.ticks.map((tick) => html`<span class="timeline-tick" style=${`top:${String(tick.top)}%`}>${formatDate(new Date(tick.time).toISOString())}</span>`)}</div>
        ${timeline.lanes.map((lane) => html`<div class="timeline-lane" role="group" aria-label=${lane.name}>
          ${timeline.ticks.map((tick) => html`<div class="timeline-gridline" style=${`top:${String(tick.top)}%`} aria-hidden="true"></div>`)}
          ${lane.blocks.map(({ run, top, height, track }) => {
            const label = `${run.automationName} · ${run.status.replaceAll("_", " ")} · ${formatDate(run.startedAt ?? run.queuedAt)} · ${formatDuration(run)}`;
            const style = `top:${String(top)}%;height:${String(height)}%;left:calc(${String(100 * track / lane.trackCount)}% + 2px);width:calc(${String(100 / lane.trackCount)}% - 4px);background:${automationColor(run.automationId)}`;
            return run.sessionId === undefined ? html`<span class="timeline-block" style=${style} tabindex="0" title=${label} aria-label=${label}></span>` : html`<a class="timeline-block" style=${style} href=${sessionHref(context.machine.id, context.workspace.projectId, context.workspace.id, run.sessionId)} title=${label} aria-label=${label}></a>`;
          })}
        </div>`)}
      </div>
    </div><small>One column per automation on a shared, continuous time axis. Blocks show start to finish (or now for active runs); very short runs have a minimum visible size. Hover or focus for details; click linked blocks to open sessions.</small>
  </details>`;
}

function renderRunDetails(html: HtmlTemplateTag, context: WorkspacePanelContextV5, run: AutomationRun) {
  return html`${run.error === undefined ? null : html`<span class="run-error">${run.error}</span>`}${run.reason === undefined ? null : html`<small>Reason: ${run.reason}</small>`}${renderSessionLink(html, context, run)}${run.attempt?.forceStopped === true ? html`<small>Force stop requested; outcome unconfirmed.</small>` : null}`;
}

// Move focus before the host redraw removes an inline navigation/confirmation control.
// These destination controls persist across the corresponding detail-view update.
function focusDetailControl(event: Event, selector: string): void {
  if (!(event.currentTarget instanceof HTMLElement)) return;
  const card = event.currentTarget.closest(".definition-card");
  const origin = card?.querySelector<HTMLElement>(selector);
  const destination = origin !== null && origin !== undefined && !origin.matches(":disabled") ? origin : card?.querySelector<HTMLElement>('[data-detail-tab="runs"]');
  destination?.focus();
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
  private currentContext?: WorkspacePanelContextV5;
  private readonly onVisibility = (): void => { if (this.currentController !== undefined && this.currentContext !== undefined) this.currentController.visibilityChanged(this.currentContext, document.visibilityState !== "hidden"); };
  set controller(value: AutomationsController) { this.currentController = value; this.tryConnect(); }
  set context(value: WorkspacePanelContextV5) { this.currentContext = value; this.tryConnect(); }
  connectedCallback(): void { document.addEventListener("visibilitychange", this.onVisibility); this.tryConnect(); }
  disconnectedCallback(): void { document.removeEventListener("visibilitychange", this.onVisibility); if (this.currentController !== undefined && this.currentContext !== undefined) this.currentController.disconnect(this.currentContext); }
  private tryConnect(): void { if (this.isConnected && this.currentController !== undefined && this.currentContext !== undefined) this.currentController.connect(this.currentContext, document.visibilityState !== "hidden"); }
}
function defineActivityElement(): void { if (customElements.get(activityElementTag) === undefined) customElements.define(activityElementTag, AutomationsActivityElement); }

const styles = `
.automations-panel a{color:var(--color-link,#79b8ff)}.run-timeline{border:1px solid var(--color-border);border-radius:8px;padding:12px;margin-bottom:14px}.timeline-scroll{overflow-x:auto;padding:4px 3px 8px;margin:10px 0}.timeline-grid{display:grid;grid-template-rows:auto var(--timeline-height)}.timeline-heading{display:flex;align-items:center;gap:6px;padding:8px;min-width:0;font-size:12px;border-bottom:1px solid var(--color-border)}.timeline-heading strong{overflow-wrap:anywhere}.timeline-heading i{flex:none;width:10px;height:10px;border-radius:2px}.timeline-time-heading{color:var(--color-text-muted)}.timeline-axis{position:relative;height:var(--timeline-height);font-size:11px;color:var(--color-text-muted)}.timeline-tick{position:absolute;left:0;right:8px;transform:translateY(-50%);overflow-wrap:anywhere}.timeline-tick:first-child{transform:none}.timeline-tick:last-child{transform:translateY(-100%)}.timeline-lane{position:relative;height:var(--timeline-height);border-left:1px solid var(--color-border)}.timeline-gridline{position:absolute;left:0;right:0;border-top:1px solid var(--color-border);pointer-events:none}.timeline-gridline:last-of-type{transform:translateY(-1px)}.timeline-block{position:absolute;border-radius:3px;box-sizing:border-box;opacity:.85}.timeline-block:hover,.timeline-block:focus-visible{opacity:1;outline:2px solid var(--color-text);outline-offset:1px;z-index:1}

.automations-panel{padding:16px;display:grid;gap:18px;color:var(--color-text)}
.automations-panel :is(h2,h3,h4,p){margin:0}
.automations-toolbar,.definition-card header,.automation-editor header{display:flex;align-items:center;justify-content:space-between;gap:12px}
.automations-toolbar p,.automation-editor header span,.automations-panel small,.automations-panel .empty{color:var(--color-text-muted);font-size:12px}
.automations-panel .actions{display:flex;gap:8px;flex-wrap:wrap}
.automations-panel :is(button,input,select,textarea){font:inherit}
:where(.automations-panel) button{border:1px solid var(--color-border);background:var(--color-bg-secondary);color:inherit;border-radius:6px;padding:6px 10px;cursor:pointer}
.automations-panel button:disabled{opacity:.5;cursor:not-allowed}
.automations-panel button.danger{color:var(--color-danger,#e66)}
.automations-panel .message{padding:9px 12px;border:1px solid var(--color-border);border-radius:6px}
.automations-panel .message.error,.run-error{color:var(--color-danger,#e66)}
.automation-editor,.definition-card{border:1px solid var(--color-border);border-radius:8px;padding:14px;display:grid;gap:12px;background:var(--color-bg-secondary)}
.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.form-grid label{display:grid;gap:5px;font-size:13px}.form-grid .wide{grid-column:1/-1}
.automations-panel :is(input,select,textarea){box-sizing:border-box;width:100%;border:1px solid var(--color-border);background:var(--color-bg);color:inherit;border-radius:5px;padding:7px}
.definition-card header{align-items:flex-start}.definition-card header p{color:var(--color-text-muted);margin-top:3px}
.status,.run-status{border-radius:999px;padding:3px 7px;background:var(--color-bg);font-size:11px;white-space:nowrap}.status.enabled,.run-status.completed{color:var(--color-success,#6c6)}.run-status.failed,.run-status.timed_out,.run-status.unknown{color:var(--color-danger,#e66)}
.automations-panel dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0}.automations-panel dl div{min-width:0}.automations-panel dt{font-size:11px;color:var(--color-text-muted)}.automations-panel dd{margin:2px 0 0;font-size:13px;overflow-wrap:anywhere}
.runs h3{margin-bottom:9px}.table-scroll{overflow:auto}.automations-panel table{width:100%;border-collapse:collapse;font-size:12px}.automations-panel caption{text-align:left;color:var(--color-text-muted);padding-bottom:6px}.automations-panel :is(th,td){text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid var(--color-border)}.automations-panel td small{display:block;margin-top:3px}
.automations-panel .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:700px){.automations-toolbar{align-items:flex-start;flex-direction:column}.automations-panel dl{grid-template-columns:1fr}}
.automations-panel{font-size:14px;gap:20px;min-width:0}.automations-toolbar>div:first-child{display:block}.automations-toolbar h2{font-size:22px;font-weight:650;letter-spacing:-.025em}.automations-toolbar p{margin-top:4px}.automation-workbench{display:grid;grid-template-columns:minmax(200px,260px) minmax(0,1fr);border:1px solid var(--color-border);border-radius:10px;overflow:hidden;min-height:420px}.automation-list{border-right:1px solid var(--color-border);padding:12px;display:flex;flex-direction:column;gap:6px;background:var(--color-bg-secondary);min-width:0}.view-switch{display:flex;gap:4px;margin-bottom:10px;flex-wrap:wrap}.view-switch button{font-size:12px;padding:6px 8px}.view-switch button[aria-pressed=true],.detail-tabs button[aria-pressed=true]{color:var(--color-link,#79b8ff);border-color:var(--color-link,#79b8ff)}.automation-list-item{display:block;text-align:left;padding:12px;border:1px solid transparent;background:transparent;overflow-wrap:anywhere}.automation-list-item strong{display:block;font-size:13px;font-weight:600}.automation-list-item .list-state{display:block;color:var(--color-text-muted);font-size:11px;margin-top:5px}.automation-list-item[aria-current=true]{background:var(--color-bg);border-color:var(--color-border);box-shadow:inset 3px 0 var(--color-link,#79b8ff)}.activity-link{margin-top:14px;text-align:left;font-size:12px}.automation-detail{min-width:0;padding:22px}.automation-detail>.definition-card{border:0;border-radius:0;padding:0;background:transparent;gap:22px}.definition-card h3{font-size:22px;line-height:1.3;font-weight:650;letter-spacing:-.025em;overflow-wrap:anywhere}.definition-card header p{font-size:13px;line-height:1.6;max-width:65ch;margin-top:6px}.definition-actions{gap:6px}.automations-panel button.primary{background:var(--color-link,#79b8ff);color:var(--color-bg,#101318);border-color:var(--color-link,#79b8ff);font-weight:600}.detail-tabs{display:flex;gap:6px;border-bottom:1px solid var(--color-border);padding-bottom:10px;flex-wrap:wrap}.detail-tabs button{font-size:12px;background:transparent}.schedule-summary h4,.overview-metrics h4{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--color-text-muted);font-weight:500}.schedule-summary p{font-size:16px;margin:6px 0}.overview-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;border-block:1px solid var(--color-border);padding:18px 0}.overview-metrics>div{display:grid;align-content:start;gap:7px;min-width:0}.overview-metrics strong{font-size:18px;font-weight:600;overflow-wrap:anywhere}.overview-metrics small,.overview-metrics a{font-size:11px}.usage-note{font-size:11px;color:var(--color-text-muted);margin-top:-14px}.recent-sessions{display:grid;gap:10px}.recent-sessions h4,.configuration h4{font-size:14px;font-weight:600}.recent-run{display:flex;align-items:start;gap:12px;justify-content:space-between;border-bottom:1px solid var(--color-border);padding:10px 0;font-size:12px;overflow-wrap:anywhere}.recent-run small{display:block;margin-top:6px}.configuration{display:grid;gap:18px}.configuration pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.6;border:1px solid var(--color-border);border-radius:6px;padding:14px;max-height:420px;overflow:auto;margin:0}.lifecycle-confirmation{border:1px solid var(--color-border);border-radius:8px;padding:16px;display:grid;gap:12px}.lifecycle-confirmation p{font-size:13px;line-height:1.6}.session-retention{color:var(--color-text-muted)}.automations-panel button:focus-visible,.automations-panel a:focus-visible{outline:2px solid var(--color-link,#79b8ff);outline-offset:3px}.automation-detail>.empty{padding:12px}.automation-list>.empty{padding:12px;line-height:1.6}@media(max-width:850px){.automation-workbench{grid-template-columns:minmax(170px,210px) minmax(0,1fr)}.automation-detail{padding:16px}.overview-metrics{grid-template-columns:1fr;gap:16px}.overview-metrics strong{font-size:16px}}@media(max-width:600px){.automation-workbench{grid-template-columns:minmax(0,1fr)}.automation-list{border-right:0;border-bottom:1px solid var(--color-border);max-height:280px;overflow:auto}.automation-detail{padding:16px}.definition-card h3{font-size:20px}.recent-run{flex-wrap:wrap}}
`;

export { hasActiveRuns };
