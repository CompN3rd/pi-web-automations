import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { createAutomationsBrowserContributions } from "./automations-panel.js";

const plugin: PiWebPlugin = {
  apiVersion: 4,
  name: "Automations",
  activate: ({ html, svg }) => ({ contributions: createAutomationsBrowserContributions(html, svg) }),
};

export default plugin;
