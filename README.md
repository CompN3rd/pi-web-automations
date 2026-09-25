# PI WEB Automations

Durable, machine-local scheduled Pi jobs with a workspace panel, SQLite history, and a bundled Pi companion extension.

**Unreleased cooperative scheduler, built on upstream's user-owned session contract.** Requires PI WEB `>=1.202609.1` (browser API v4, server API v3) and a compatible Pi coding agent (`>=0.87.0`). PI WEB `1.202609.0` predates these APIs and is not compatible.

## Try it safely

1. Use Node.js 22.19+, then run `npm ci && npm run verify` against the released host development dependency.
2. Install the built checkout as a **local Pi package** on the target machine, so both the PI WEB entries and `dist/companion.js` are discovered. Trust/enable its Pi extension and enable the `automations` PI WEB plugin. A plugin-only symlink is insufficient for companion discovery.
3. When safe, restart the target session daemon and reload the browser. Do not restart a daemon hosting work you need to keep running.
4. Open **Automations**, save a disabled draft, use **Run now / test**, then enable that tested revision's schedule.

Fixed provider/model IDs are entered manually and validated by the companion at test/run. No silent fallback is used. Sessions are visible, user-owned conversations—not exclusively leased background runtimes. Unconfirmed execution blocks the definition, including after edits and restarts; inspect Sessions before creating a replacement.

The Automations panel includes session links on definition cards (latest session in loaded history) and run rows, plus a duration-block timeline with stable per-automation colors. The timeline shows the latest 200 workspace runs. Each definition's estimated total and average cost cover **all retained runs**, independently of that limit; averages exclude runs without cost data and include known zero-cost runs. Coverage counts are shown because usage can be missing or partial, not a complete billing total.

Read the [migration and compatibility report](docs/migration.md) **before moving existing state**. It covers storage relocation, cancellation limits, partial usage, installation, operation and validation gaps. No daemon or live-state migration is performed by the build.

Plugins and prompts execute with the target machine's account permissions. Review sources and prompts; cancellation cannot undo completed effects.

MIT; see [LICENSE](LICENSE).
