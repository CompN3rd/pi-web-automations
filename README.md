# PI WEB Automations

Durable, machine-local scheduled Pi jobs with a workspace panel, SQLite history, and a bundled Pi companion extension.

**Cooperative scheduler, built on upstream's user-owned session contract.** Requires PI WEB `>=1.202609.1` (browser API v4, server API v3) and a compatible Pi coding agent (`>=0.87.0`). PI WEB `1.202609.0` predates these APIs and is not compatible.

## Try it safely

1. Use Node.js 22.19+ and a compatible PI WEB installation.
2. In the target machine's **Settings → Pi packages**, install the npm package `@compn3rd/pi-web-automations` (use `@compn3rd/pi-web-automations@0.1.0` to pin this release). Install it as a **Pi package**, so both the PI WEB entries and `dist/companion.js` are discovered. Trust/enable its Pi extension and enable the `automations` PI WEB plugin. A plugin-only symlink is insufficient for companion discovery.
3. When safe, restart the target session daemon and reload the browser. Do not restart a daemon hosting work you need to keep running.
4. Open **Automations**, save a disabled draft, use **Run now / test**, then enable that tested revision's schedule.

For source development, run `npm ci && npm run verify` in a checkout, then install the built directory as a local Pi package instead of the npm package. See the [0.1.0 release notes](docs/releases/0.1.0.md) for features and operating limitations.

Fixed provider/model IDs are entered manually and validated by the companion at test/run. No silent fallback is used. Sessions are visible, user-owned conversations—not exclusively leased background runtimes. Unconfirmed execution blocks the definition, including after edits and restarts; inspect Sessions before creating a replacement.

The Automations panel includes session links on definition cards (latest session in loaded history) and run rows, plus a continuous duration-block timeline with time flowing top to bottom and one column per automation across the horizontal axis. Runs on different days stay in the same column, and concurrent jobs align on the shared time axis. Colors are stable per automation; overlapping runs within one automation appear side by side, and very short runs retain a minimum visible size. Hover or focus blocks for details, or click linked blocks to open their sessions. The timeline shows the latest 200 workspace runs. Each definition's estimated total and average cost cover **all retained runs**, independently of that limit; averages exclude runs without cost data and include known zero-cost runs. Coverage counts are shown because usage can be missing or partial, not a complete billing total.

Read the [migration and compatibility report](docs/migration.md) **before moving existing state**. It covers storage relocation, cancellation limits, partial usage, installation, operation and validation gaps. No daemon or live-state migration is performed by the build.

Plugins and prompts execute with the target machine's account permissions. Review sources and prompts; cancellation cannot undo completed effects.

MIT; see [LICENSE](LICENSE).
