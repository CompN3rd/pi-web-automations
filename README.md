# PI WEB Automations

Durable, machine-local scheduled Pi jobs with a workspace panel, SQLite history, and a bundled Pi companion extension.

**Cooperative scheduler, built on upstream's user-owned session contract.** Version `0.2.0` requires Node.js **22.19+**, PI WEB **`^1.202610.9`** (browser and server API v5), and Pi coding agent **`^1.4.0`**. Older hosts and Pi 0.x/2.x are unsupported.

## Updated in 0.2.0

Browser and chat management share the host's scoped backend transport; chat no longer needs an open browser or a browser-established binding. Registered-project/workspace discovery includes empty targets, with exact-ID selection for new drafts. The management tool is deferred and discoverable through tool search. SQLite now comes from Node (`node:sqlite`), with no native addon; existing schema-v1 definitions and history remain readable in place. The correlated execution runner and its safety checks are retained—see the [host-runner assessment](docs/migration.md#host-runner-decision).

See the [0.2.0 release notes](docs/releases/0.2.0.md) for compatibility, verification and upgrade guidance. The minor version marks the raised host baseline and removed legacy management transport, not a database schema break. Publication uses [GitHub Actions and npm trusted publishing](docs/publishing.md); a prepared checkout is not proof that a version is public.

## Earlier releases

The companion now handles Pi 1.2's user/custom-message startup event types. An unrelated custom-message run ends automation attribution as `unknown`; it must not be cancelled or counted as successful automation work. Development dependencies, compatibility peers, and browser test fixtures have been updated for current PI WEB. No storage migration or change to cooperative cancellation is required.

Version `0.1.2` introduced the chat-management tool: list and inspect automations, save disabled drafts and edits, run/test, enable/pause, delete, and cancel by exact ID. See [Manage automations from chat](#manage-automations-from-chat) and the [0.1.2 release notes](docs/releases/0.1.2.md).

## Fixed in 0.1.1

The published `0.1.0` server entry can fail with `Cannot find package '@jmfederico/pi-web'`. Pi-managed installs intentionally skip automatic peer installation, and the running host's installation is not necessarily visible to Node from the plugin directory. Rebooting does not fix that package-resolution error.

Version `0.1.1` fixed the packaging by bundling the public host capability helpers into the server entry. That fix is retained in `0.2.0` for server and companion helpers; Croner is now the only runtime dependency and SQLite is runtime-provided. The managed-install check verifies imports without either host peer installed. Updating the package does not activate server changes until a safe, operator-controlled daemon restart; do not interrupt active sessions to apply it. This issue is separate from a web-to-daemon connection failure.

## Try it safely

1. Use Node.js 22.19+ and a compatible PI WEB installation.
2. In the target machine's **Settings → Pi packages**, install the npm package `@compn3rd/pi-web-automations` (use `@compn3rd/pi-web-automations@0.2.0` to pin this release). Install it as a **Pi package**, so both the PI WEB entries and `dist/companion.js` are discovered. Trust/enable its Pi extension and enable the `automations` PI WEB plugin. A plugin-only symlink is insufficient for companion discovery.
3. When safe, restart the target session daemon and reload the browser. Do not restart a daemon hosting work you need to keep running.
4. Open **Automations**, save a disabled draft, use **Run now / test**, then enable that tested revision's schedule.

For source development, run `npm ci && npm run verify` in a checkout, then install the built directory as a local Pi package instead of the npm package. See the [0.2.0 release notes](docs/releases/0.2.0.md) for current compatibility and update guidance, the [0.1.1 release notes](docs/releases/0.1.1.md) for the retained packaging fix, and the [0.1.0 release notes](docs/releases/0.1.0.md) for initial features and operating limitations.

Fixed provider/model IDs are entered manually and validated by the companion at test/run. No silent fallback is used. Sessions are visible, user-owned conversations—not exclusively leased background runtimes. Unconfirmed execution blocks the definition, including after edits and restarts; inspect Sessions before creating a replacement.

In the Automations editor, **Target workspace** lists registered projects/workspaces on the selected machine, including workspaces with no saved automations. New drafts default to the currently selected workspace; choosing another target sends both exact IDs and the backend revalidates them before saving. After creating elsewhere, open that workspace's Automations panel to test and enable it. Editing a saved automation preserves its original target. Catalog failures are shown explicitly and never substitute gateway projects or guessed paths.

The Automations panel includes session links on definition cards (latest session in loaded history) and run rows, plus a continuous duration-block timeline with time flowing top to bottom and one column per automation across the horizontal axis. Runs on different days stay in the same column, and concurrent jobs align on the shared time axis. Colors are stable per automation; overlapping runs within one automation appear side by side, and very short runs retain a minimum visible size. Hover or focus blocks for details, or click linked blocks to open their sessions. The timeline shows the latest 200 workspace runs. Each definition's estimated total and average cost cover **all retained runs**, independently of that limit; averages exclude runs without cost data and include known zero-cost runs. Coverage counts are shown because usage can be missing or partial, not a complete billing total.

## Manage automations from chat

With the bundled companion trusted/enabled and the Automations server plugin active on the session’s **hosting machine**, ask **“List my automations across registered workspaces”**, **“Inspect this automation’s saved requirements”**, **“Save a disabled automation in this workspace to review changes every hour”**, or **“Change automation `<id>`’s saved prompt to …”**. Concise prompt guidance directs the agent to discover the deferred `automations` tool with tool search; its full management schema is loaded on demand. No skill loading or database discovery is needed. List results include empty registered workspaces and exact project/workspace IDs, with the unambiguous current workspace first; inspection by automation ID returns the full saved definition and latest 20 runs.

Chat calls the public host `createCompanionBackend` transport directly. No browser label, heartbeat, open tab, or browser-established session binding is needed. The host captures the concrete hosted session and backend revision, validates scoped IDs and revokes stale access. Each management query re-resolves target workspace authority. Listing omits inaccessible targets with a count rather than exposing their definitions. Exact-ID actions authorize only the stored target, independent of the chat’s original workspace. A remote hosted session uses its own daemon, never the gateway’s database. Machine attribution comes from that backend: `id: "local"` is relative to the hosting daemon, `name` is its OS hostname, and `scope` is `"backend machine"`—not a browser-selected gateway machine ID. Missing/disabled backends or non-hosted Pi usage fail explicitly, with no fallback. Retained backend facades are not cached across tool calls.

The tool supports `list`, `inspect`, `create`, `update`, `run`, `enable`, `pause`, `delete`, and `cancel`. Explicit, unambiguous requests execute immediately—no mandatory preview/confirmation. If the workspace, automation, or requested change is ambiguous, the agent should ask instead of guessing. Creation defaults to the current workspace only when the session cwd uniquely matches one registered catalog workspace. A path is merely a discovery hint, never execution authority. Aliased or missing matches require both exact `projectId` and `workspaceId`, obtained from `list`; both IDs are re-resolved by the host before saving. Explicit targets can include previously empty workspaces. Duplicate automation names across workspaces are not interchangeable.

`create` takes a `draft` with name, prompt, trigger, model and thinking policies, optional description and timeoutMs. Use `{mode:"default"}` for machine defaults, or fixed model `{mode:"fixed",provider:"…",id:"…"}` and thinking `{mode:"fixed",level:"high"}`. Triggers are `{type:"manual"}`, `{type:"once",at:"<future ISO timestamp>"}`, `{type:"interval",intervalMs:3600000}`, or `{type:"cron",expression:"0 0 9 * * *",timeZone:"Europe/Berlin"}`. Timeout is 1 minute–24 hours, default 60 minutes. Every new draft is disabled. `update` takes the exact automationId, the expectedRevision observed in list/inspect, and a nonempty `patch` of saved requirements (name, description, prompt, trigger, model, thinking, timeoutMs); an empty description clears it. Updates preserve omitted settings, pause the schedule, and clear the successful-test marker. A revision conflict is an error: re-inspect and reconcile, never silently overwrite. Both saves report the full saved definition with machine/project/workspace attribution, or an error. Timeout, cancellation, or a lost reply can mean the save occurred; inspect/list before retrying, especially before creating a duplicate draft.

Ask **“Run/test automation `<id>`”**, **“Enable (or pause) its schedule”**, **“Delete automation `<id>`”**, or **“Cancel run `<runId>` of automation `<id>`”**. `run`, `enable`, `pause`, and `delete` require exact automationId and caller-observed expectedRevision. `cancel` requires both automationId and exact runId from inspection, not a guessed latest run. Actions re-resolve target workspace authority immediately before mutation and report machine/project/workspace attribution; errors are surfaced without fallback. As with saves, a timeout/cancelled tool call/lost reply may mean an action already happened; inspect/list before retrying. Aborting the chat tool does **not** cancel an automation run.

`run` queues an existing manual run/test and returns its run record, not completed execution. Inspect again for status and the visible sessionId once created; sessions remain visible in Sessions and the tab. Successful retesting is required before enabling the edited revision; edits do not unblock unconfirmed work. `pause` disables future scheduling without cancelling existing runs. `delete` archives the definition and retains run history and session IDs; active/queued runs prevent deletion, and deleting an unknown-work definition does not stop or confirm its uncertain work. `cancel` uses existing cooperative cancellation: queued work can settle immediately without submission, but running work reports cancellation intent until companion-confirmed settlement. Inspect its run/session for the outcome; unknown is not stopped, and forceStopped remains false. There is no unblock workflow. Queries, saves, and scheduling changes do not create test sessions; only `run` (or an enabled schedule) starts execution.

Read the [migration and compatibility report](docs/migration.md) **before moving existing state**. It covers storage relocation, cancellation limits, partial usage, installation, operation and validation gaps. No daemon or live-state migration is performed by the build.

Plugins and prompts execute with the target machine's account permissions. Review sources and prompts; cancellation cannot undo completed effects.

MIT; see [LICENSE](LICENSE).

## Community discovery

This package declares `piWeb.plugins` and the `pi-web.dev-plugin`, `pi-package`,
and `pi-web-plugin` npm keywords required by the
[PI WEB community directory](https://pi-web.dev/community-plugins). No separate
registration or submission is needed. Discovery requires publishing a new public
npm version containing this metadata; npm search indexing may take time. Source
changes alone do not update the directory. The compatibility and installation
requirements above still apply.
