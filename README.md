# PI WEB Automations

`@compn3rd/pi-web-automations` provides durable, machine-local scheduled Pi jobs for a selected PI WEB workspace. It is a paired browser/server plugin with the id `automations` and is maintained separately from PI WEB.

> **Pre-release host requirement:** version 0.1.0 is an unpublished development release. It requires the background-service plugin APIs being developed for [PI WEB issue #159](https://github.com/jmfederico/pi-web/issues/159), currently available on [`CompN3rd/pi-web#feat/background-service-plugins`](https://github.com/CompN3rd/pi-web/tree/feat/background-service-plugins). It is **not compatible with the currently released PI WEB host**. The Git branch is a temporary development-only type dependency. Before the first npm release, it must be replaced by the first compatible released `@jmfederico/pi-web` semver dependency/peer range.

## Install from source (current workflow)

Node.js 22.19 or newer is required.

```bash
git clone https://github.com/CompN3rd/pi-web-automations.git
cd pi-web-automations
npm ci
npm run verify
```

Use a PI WEB checkout built from the required background-service plugin branch. Then either install this built checkout as a local Pi package (`pi install /absolute/path/to/pi-web-automations`, or the equivalent **Settings → Pi packages** source), or symlink the built repository into the target machine's local PI WEB plugin directory:

```bash
mkdir -p "${PI_WEB_DATA_DIR:-$HOME/.pi-web}/plugins"
ln -s /absolute/path/to/pi-web-automations \
  "${PI_WEB_DATA_DIR:-$HOME/.pi-web}/plugins/pi-web-automations"
```

On Windows, create the equivalent directory junction or symbolic link under `%PI_WEB_DATA_DIR%\plugins` (default `%USERPROFILE%\.pi-web\plugins`). Run `npm run build` again after source edits.

Do not use `npm:@compn3rd/pi-web-automations` yet: this package has not been published. After a future npm release, installation will be available through **Settings → Pi packages** with source `npm:@compn3rd/pi-web-automations`, or equivalently:

```bash
pi install npm:@compn3rd/pi-web-automations
```

That command documents the eventual workflow; it is not expected to work before publication.

## Enable and activate

Package installation and plugin enablement are separate. On the target machine, open **Settings → PI WEB plugins** and enable `automations`, or set the standard global PI WEB config:

```json
{
  "plugins": {
    "automations": { "enabled": true }
  }
}
```

Because Automations has a server entry, installation, updates, enablement changes, and source rebuilds require a manual restart of the **target machine's session daemon**, followed by a browser reload. For the native systemd user service:

```bash
systemctl --user restart pi-web-sessiond
```

A browser reload, web/UI autoreload, restart of only the web/API process, or Pi's `/reload` command does not activate changed server-plugin code. If startup recovery is needed, use the host's standard offline plugin controls, for example `pi-web plugins disable automations --restart`.

## Create, test, then enable

1. Select the machine, project, and workspace that should own the work.
2. Open the **Automations** workspace panel.
3. Select **New automation** and enter a name, prompt, trigger, model policy, thinking policy, and timeout.
4. Save the disabled draft.
5. Select **Run now / test** and wait for that revision to complete successfully.
6. Select **Enable** to start its schedule.

A successful manual run marks only that exact revision as tested. Editing its name, prompt, trigger, model, thinking level, or timeout creates a new revision, pauses the definition, and requires another successful manual test before it can be enabled. Revision checks also prevent two open browser tabs from silently overwriting one another.

Definitions are scoped to one project and workspace. The plugin asks the public host background-session service to revalidate both against the authoritative workspace catalog before creating a run session. A stale, removed, or conflicting workspace fails rather than running in an unverified path.

## Triggers

- **Manual:** runs only when you select **Run now / test**.
- **One time:** runs once at a future timestamp and then disables its schedule.
- **Interval:** uses a fixed cadence of at least one minute.
- **Cron:** uses a six-field expression (`second minute hour day month weekday`) and an explicit IANA time zone.

The same automation never overlaps itself. If a scheduled occurrence collides with its active run, the plugin records the occurrence as skipped. The scheduler runs up to two different automations concurrently; additional work remains queued.

## Models, thinking, and usage

Choose the machine default or a fixed model from the selected machine's current model catalog. Fixed models are revalidated when the background session is created and are never silently replaced. Thinking choices are filtered to the selected model's supported levels.

Run history preserves configured and actual model/thinking values, status, source, revision, queue/start/completion times, duration, reason, and usage. Usage is a snapshot of the fresh root Pi session and includes input, output, cache-read, cache-write, and total tokens. Estimated cost appears only when the model runtime provides it. Root-session totals do not claim to include untracked subagents, external services, or other paid tools.

Session ids are diagnostic text only. The plugin deliberately does not construct private PI WEB session routes. Browser requests use only `context.backend.request()` and generic machine federation.

## Timeouts, cancellation, and restart recovery

The default run timeout is 60 minutes and can be set from 1 minute through 24 hours. The execution deadline begins when the fresh session is ready and prompt execution starts, not while queued.

**Cancel** records cancellation intent and requests a cooperative abort. If a run does not settle within the 15-second grace period, the plugin force-stops the leased runtime. A force-stopped run becomes `unknown` when completion cannot be proven. Cancellation cannot undo filesystem changes, network requests, or other effects that already completed.

Closing or reloading the browser and restarting only the web/API process do not stop schedules or active runs. The browser panel reconstructs state from sessiond and polls about every 2 seconds while active and every 15 seconds while idle; Automations adds no private route or feature-specific realtime protocol.

After an unexpected session-daemon restart:

- queued runs stay queued and eligible;
- starting, running, or cancelling runs become `unknown` because completion cannot be proven;
- definitions, run history, and future schedule state remain in SQLite;
- ambiguous work is not blindly repeated.

## Persistence, migration, and backup

The host supplies the plugin state directory. Automations stores its database at:

```text
$PI_WEB_DATA_DIR/plugin-state/automations/automations.sqlite
```

`PI_WEB_DATA_DIR` defaults to `~/.pi-web`. This is the same path used by the extracted Automations implementation, so existing local state continues to work without a database move. When migrating from a PI WEB build that bundled Automations:

1. stop the target session daemon;
2. back up the existing SQLite database and its sidecars with SQLite-aware tooling;
3. update the host to a compatible build where the separately installed package owns plugin id `automations`;
4. install/build this package and ensure there is only one discovered owner for that id;
5. start sessiond, inspect plugin health and history, then reload the browser.

Do not run bundled and standalone copies simultaneously or rename the plugin id: either creates an ownership conflict or a different state directory. The database and SQLite `-wal`/`-shm` sidecars are managed state, not user-editable configuration. Back them up only while sessiond is stopped or with SQLite-aware online-backup tooling. Restore the database only while sessiond is stopped and preserve restrictive file permissions.

Automations does not create a separate daemon ownership marker. It runs inside the session daemon that owns `$PI_WEB_DATA_DIR/sessiond-owner.json`.

## Local and remote machines

Automations follows PI WEB's generic plugin federation and declares `machineSpecific: true`. For a selected remote machine, that machine must have its own compatible package and host APIs. Its session daemon validates workspaces, stores the database, resolves models, schedules work, and runs sessions locally; the gateway supplies the paired panel.

Definitions are not copied between machines and do not fail over. Recreate a definition on a destination machine so that machine validates its current workspace and models. A gateway/browser disconnect does not stop work on a still-running remote session daemon. After an update, restart the affected remote session daemon and reload the gateway browser. A browser/server revision mismatch fails explicitly.

## Security

PI WEB plugins are trusted code. The browser entry runs in the PI WEB page and the server entry runs in-process with sessiond's OS-user permissions. Install only reviewed package sources.

A fresh Pi session isolates conversational context, not the host. Prompts and tools can read, modify, execute, or contact anything allowed by the target machine's Pi configuration and service account. Protect PI WEB with authentication and network controls, use least-privilege credentials, review prompts before enabling schedules, and remember that cancellation cannot reverse completed effects. Treat prompts, run history, and database backups as sensitive data.

The implementation imports only public type declarations from `@jmfederico/pi-web/plugin-api` and `@jmfederico/pi-web/server-plugin-api`. Emitted JavaScript has no PI WEB runtime import and uses no PI WEB source internals, private routes, or private session URLs.

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run validate:dist
npm run pack:validate
npm run pack:dry
```

`npm run pack:validate` creates and inspects a real package tarball, verifies both metadata entry files, rejects files outside `dist`, `README.md`, `LICENSE`, and npm's required `package.json`, then removes the tarball. The npm publish allowlist is `dist`, `README.md`, and `LICENSE`.

The only production dependencies are `better-sqlite3` and `croner`. The temporary Git dependency on PI WEB is dev-only so TypeScript checks the unreleased public contracts. The first publish remains blocked until issue #159 lands in a released host and `package.json` can declare a concrete compatible semver/peer range instead.

## License

MIT. See [LICENSE](LICENSE). The extracted implementation retains the upstream PI WEB copyright notice and adds Marc Kassubeck.
