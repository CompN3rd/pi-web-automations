import type { HtmlTemplateTag, WorkspaceLabelContribution, WorkspaceLabelContext } from "@jmfederico/pi-web/plugin-api";
import { CHAT_BIND } from "./chat-protocol.js";

const tag = "pi-web-automations-chat-binding";

export function chatLabel(html: HtmlTemplateTag): WorkspaceLabelContribution {
  defineBindingElement();
  return {
    id: "chat.automations", order: 25,
    items: (context) => [{ type: "render", render: () => html`<pi-web-automations-chat-binding .context=${context}></pi-web-automations-chat-binding>` }],
  };
}

function defineBindingElement(): void {
  if (typeof customElements === "undefined" || customElements.get(tag)) return;
  class BindingElement extends HTMLElement {
    private current: WorkspaceLabelContext | undefined;
    private timer: ReturnType<typeof setInterval> | undefined;
    private request: AbortController | undefined;
    private key = "";
    set context(value: WorkspaceLabelContext) {
      this.current = value;
      const key = JSON.stringify([value.machine.id, value.workspace.projectId, value.workspace.id, value.state?.selectedSession?.id, value.state?.selectedSession?.pending]);
      if (this.key !== key) { this.key = key; this.request?.abort(); this.request = undefined; void this.bind(); }
    }
    connectedCallback() {
      this.timer = setInterval(() => { void this.bind(); }, 3_000);
      void this.bind();
    }
    disconnectedCallback() { clearInterval(this.timer); this.request?.abort(); this.request = undefined; }
    private async bind() {
      const context = this.current;
      if (!this.isConnected || !context || this.request) return;
      const session = context.state?.selectedSession;
      if (!session || session.pending || session.cwd !== context.workspace.path) {
        this.textContent = "Automation chat: select a hosted workspace session"; return;
      }
      if (!context.peer?.request) { this.textContent = "Automation chat unavailable on selected machine"; return; }
      const key = this.key;
      const request = new AbortController(); this.request = request;
      if (this.textContent !== "Automation chat ready") this.textContent = "Automation chat: connecting…";
      try {
        await context.peer.request(CHAT_BIND, { sessionId: session.id, machineId: context.machine.id, machineName: context.machine.name }, { signal: request.signal });
        if (this.key === key && !request.signal.aborted) {
          this.textContent = "Automation chat ready";
          this.title = "Ask: List my automations across workspaces, or inspect an automation's saved requirements. Uses this session's machine; never falls back to local.";
        }
      } catch (error) {
        if (this.key === key && !request.signal.aborted) { this.textContent = "Automation chat unavailable"; this.title = String(error); }
      } finally { if (this.request === request) this.request = undefined; }
    }
  }
  customElements.define(tag, BindingElement);
}
