# Upstream plugin rewrite: migration and compatibility

## Status and assessment

This is an **unreleased cooperative scheduler** adopting upstream's user-owned session contract. It is not a drop-in replacement for the fork's exclusive background-session service. Requires released `@jmfederico/pi-web@1.202609.1` or newer with public browser API **v4** and server API **v3**, plus compatible Pi extension types (`@earendil-works/pi-coding-agent@^0.87.1`). Registry `1.202609.0` predates these APIs and is not compatible.

Automations uses the public upstream contract for durable definitions, schedules, run history, a machine-scoped workspace UI and agent execution. User-owned sessions, cooperative cancellation and partial usage accounting are accepted operating constraints, not blockers awaiting additional host APIs. Scheduling/persistence remain plugin-owned. Agent control belongs in the bundled Pi extension, not in private PI WEB routes or subprocesses.

| Original need | Public upstream representation | Difference / gap |
| --- | --- | --- |
| Persistent database | Server `dataDirectory` + SQLite | Directory relocation needs an operator-controlled copy; no automatic migration |
| Workspace validation | Exact `workspaces@1` + `pi-sessions@1` capabilities | IDs are re-resolved at every run; paths from saved definitions are not execution authority |
| UI transport | Browser `peer.request`, server `peer.request` | Existing scoped JSON operations and polling retained; no private HTTP routes |
| Fresh session | `pi-sessions.create` | Published session belongs to the user; no exclusive lease or mutation fencing |
| Model/thinking selection | Companion `modelRegistry`, `setModel`, thinking APIs | No catalog before creating a session. Manual fixed IDs; invalid/unauthenticated policies fail rather than falling back |
| Prompt/completion | Session-local correlated messages, Pi `sendUserMessage` / `agent_settled` | `emit` is not acknowledgement. `agent_end` is not final settlement. Loss is not success |
| Cancellation | Correlated companion request + `ctx.abort()` | Cooperative only; never a force-stop guarantee, process kill, or daemon stop |
| Runtime shutdown | `lifetimeSignal`, then `dispose` | Event connections are revoked; do not assume disposal can cancel published work |
| Usage | Observed assistant `message_end` usage | Partial assistant-message totals, not complete root-session accounting |

No host source edits, private imports/routes, Pi CLI subprocess execution, or compatibility shims are used. Runtime PI WEB imports are limited to the three public capability constants from `@jmfederico/pi-web/server-plugin-api`; Pi APIs are a type-only extension boundary.

## Development bootstrap

Use Node.js 22.19+ and install the registry dependencies; no host source build is required:

```sh
npm ci
npm run verify
npm run pack:dry
```

CI runs the same checks against the released host package on Windows and Linux. Production dependencies remain `better-sqlite3` and `croner`; the host and Pi coding agent are development/type dependencies. The package ships browser and server entries, the companion, and these docs. Import and real-pack validators run in `npm run verify`. The package itself is not yet published.

## Install and activate

Install the built directory as a local package using the target machine's **Settings → Pi packages**. The package declares `pi.extensions: ["dist/companion.js"]` as well as paired `piWeb.plugins` entries. Ensure the Pi package/extension is enabled and trusted. Merely linking the PI WEB plugin does not install the companion into Pi sessions.

Enable `automations` in **Settings → PI WEB plugins**. Restart the target session daemon when safe, then reload the browser. Rebuild source edits with `npm run build`; server or companion changes require appropriate daemon/session reloads. Fresh automation sessions must see the companion. Do not modify plugin configuration or restart the daemon from a hosted session that must survive.

The plugin is `machineSpecific: true`. Each target needs compatible host and package installations, its own credentials, and its own state. Gateway/UI reloads do not stop schedules. Mixed gateway/target host revisions are unsupported. No definitions fail over or copy automatically.

## Existing state: staged migration only

The previous fork stored `automations.sqlite` under `$PI_WEB_DATA_DIR/plugin-state/automations`. The rewrite supplies a different `dataDirectory` (currently `$PI_WEB_DATA_DIR/plugin-data/automations`); the implementation uses only that supplied directory. It does **not** search or copy the old path.

Before an operator switches hosts:

1. Inspect all active sessions and schedules. Take a SQLite online backup or stop the old daemon before backing up; copying a live database file without its WAL is unsafe.
2. Retain the original backup. Stage a separate database copy for the new host, with schedules disabled. Do not have two plugin instances scheduling from either the same state or copied enabled schedules.
3. Verify the target host's actual `dataDirectory` and only place the staged database there during the planned cutover. Preserve permissions. Do not replace live state while sessiond is running.
4. Install exactly one owner of plugin id `automations`; inspect definitions/history and run a manual test before enabling schedules individually.

Existing schema, revision records and configured fixed policies are retained. Existing `root_session` usage remains readable; new companion usage has scope `assistant_messages` and quality `partial`. No new successful test is inferred from old or interrupted work. Starting/running/cancelling records recover as `unknown`, and **all unknown records (including inherited ones) block their definition**.

State backup/staging and real-host smoke are operator/parent responsibilities, not actions performed by this port. Tests use temporary directories or in-memory databases.

## Daily operation

Save a disabled draft, manually test it successfully, then enable that exact revision. Changes to definition content pause it and require another successful test. Optimistic revision checks protect concurrent browser edits.

Triggers: manual, one future occurrence, interval (minimum one minute), and six-field cron with an explicit IANA time zone. Two different definitions can run concurrently. An active definition does not overlap itself; colliding scheduled occurrences are recorded as skipped. Additional distinct jobs queue. There is no workspace-wide lock across definitions or user sessions.

Choose the machine default or enter a fixed provider and model ID. Thinking levels are provisional known Pi values; the companion rejects unsupported values after Pi clamps them. The panel never resets an existing fixed policy silently when editing a model. Catalog absence is explicit, and no hidden catalog-discovery sessions are created.

Each run creates a visible session and records its ID immediately, before connecting/preparing. Connection/model/handshake failures preserve that ID for inspection in Sessions. Session IDs are diagnostic text, not constructed private URLs. Empty failed setup conversations are not deleted by this plugin.

## Completion, cancellation and ambiguity

The backend subscribes before emitting a correlated request. Preparation must reply within five seconds; otherwise the run reports a missing/unavailable companion. Model and thinking validation occur in the fresh session before prompting. Current settings are rechecked at submission, and model/thinking changes after preparation or competing user messages are treated as interference. These checks are detection, **not atomic host-side fencing**. Other extensions can transform input, send messages or mutate settings; not every arbitrary extension interaction can be attributed reliably.

Completion waits for Pi `agent_settled`, including automatic retries and compaction/queued continuations. Provider error/abort without successful final response fails the run. A successful send, disconnected browser, `agent_end`, connection loss or expired deadline never proves success.

**Cancel** records intent and asks only the matching active companion task to abort. Before prompt admission it prevents submission locally. After submission the companion must confirm settlement. It refuses unsafe cancellation when other queued/user work interferes, and ignores delayed cancellation once its task has ended; it must not abort later user work. Maximum configured run duration is 24 hours (default 60 minutes, minimum 1 minute), starting after session preparation. Cancellation gets a 15-second grace period.

If settlement is not confirmed, the run becomes `unknown`, the definition is paused, its test marker is cleared, and **manual starts, scheduled starts and re-enabling remain blocked even after definition edits or restart**. No runtime is force-stopped and `forceStopped` remains false. Connection closure detaches observation only. Plugin lifetime shutdown stops ingress, polling and deadlines immediately, records unconfirmed active work conservatively and closes connections; it does not try to cancel over revoked dependencies. Queued work without an admitted attempt remains queued for the next start.

There is intentionally no acknowledgement/unblock button in this evaluation port. Inspect the recorded conversation and its actual work in Sessions; independently stop/wait for uncertain work. Only after that inspection, create a separately named replacement definition and test it. You may delete a blocked definition once it has no queued, starting, running or cancelling runs. Delete archives the definition and retains its run/attempt history, including unknown outcomes and session IDs; it does not stop or confirm any uncertain session work. Never create a replacement just to bypass a live unknown run. A future explicit inspection/acknowledgement workflow would be a separate product change.

A daemon/process crash can occur between host publication and SQLite recording; no public atomic transaction covers those systems. Inspect Sessions even when an interrupted record lacks an ID. During ordinary disposal the store is retained until bounded pending host calls return so late-created identities can still be recorded; this is not a durable host execution lease.

## Usage, privacy and safety

New usage sums assistant-message token and estimated cost fields observed during the companion task (including failed attempts preceding retries). It excludes compaction-only/provider work not represented by those assistant messages, tool/subagent usage and external services. It is explicitly labeled **partial, assistant messages**, not full root-session or billing usage. Old imported totals retain their original scope/quality.

Plugin code and Pi tools run with the daemon user's permissions. Sessions isolate conversation context, not files/processes/network access. Review prompts and credentials. Cancellation cannot undo filesystem writes, network calls or other completed effects. Prompts, history and SQLite backups can contain sensitive data.

## Validation boundaries

Unit tests cover storage/scheduler invariants, peer scoping, browser/controller behavior, synchronous handshake ordering, missing companion, policy rejection, settlement vs `agent_end`, cancellation, interference, connection loss, lifetime shutdown and unknown-run blocking. Distribution validators check public import boundaries, companion metadata and packed files.

The earlier Windows / Node 24.19.0 verification against the prerelease upstream source passed `npm run verify` (71 tests, typecheck, lint, build, public-import and real-package validation). The upstream full verification rerun passed 4,085 tests with 67 skipped; its initial run hit a five-second Vite-test timeout that passed both a focused rerun and the full rerun. Runtime-only npm audit reported no known vulnerabilities; the development dependency tree still reports four advisories.

An isolated real daemon/web/Pi SDK and compiled package, using a deterministic loopback model endpoint, passed these scenarios:

- Real Edge browser: package loading, create/edit/run, fixed model/thinking controls, history polling, partial usage, enable/pause, stale concurrent-tab edits, reload persistence, and closing all pages during a run.
- Public paired transport: stale host revision, invalid workspace, unsupported contract, caller-supplied scope and unknown operation rejected; valid work still succeeds afterward.
- Background execution: manual, one-time and recurring interval schedules; actual 60-second timeout; skipped overlapping occurrences; subsequent interval execution after completion; scheduled work starting and finishing with the web process offline; active work surviving web restart.
- Session lifecycle: cooperative cancellation, external user abort, same-daemon session closure producing unknown, subsequent user conversation, harmless late cancellation, daemon-loss recovery and persistent unknown-run blocking.
- Failure handling: unavailable model before prompt submission, missing companion, provider failure and preserved session identity.

Two defects found during evaluation were fixed: identical consumed user follow-ups must end automation attribution, and reopening the browser editor must display the saved fixed thinking level. The latter needs native selected-option markup because the select's value binding precedes dynamic option insertion. Unit coverage is supplemented by real-browser assertions; happy-dom alone does not reproduce native option-selection behavior reliably.

No real credentials or production prompts were used; all owned test processes and fake-model listeners were stopped. Existing local workspace IDs were separately checked through the read-only catalogue. These checks accept user-owned sessions and cooperative cancellation; they do not establish exclusive ownership or forced termination.

Not verified by the isolated evaluation: the user's full provider/extension profile, paid provider requests, remote federation, graceful POSIX disposal, or unresponsive-tool cancellation on a real host. A subsequent operator-controlled cutover installed this plugin on the running PI WEB host; this document's isolated evaluation results remain historical evidence, not proof of those untested scenarios or permission to publish the package.

### Provenance

Extracted from `CompN3rd/pi-web`, `feat/plugin-automations`, source commit `32962445305c5ec52d88bb19fc71357277e13e63`, `pi-web-plugins/automations`; standalone migration branch starts at `d3dc105`. Public design reference: [upstream PR #160 discussion](https://github.com/jmfederico/pi-web/pull/160#issuecomment-5735470984), [plugin guide](https://github.com/jmfederico/pi-web/blob/60a29acbfc710908e73b0df9857cb63b53b672d3/docs/plugins.md), Workspace Reviews and Captain's Log companion examples in that source revision.
