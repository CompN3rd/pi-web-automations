import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { createAutomationsBrowserContributions } from "./automations-panel.js";

const plugin = {
  apiVersion: 5,
  name: "Automations",
  activate: ({ html, svg }) => ({ contributions: createAutomationsBrowserContributions(html, svg) }),
} satisfies PiWebPlugin;

export default plugin;
