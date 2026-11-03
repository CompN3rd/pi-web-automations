# Issue #2: agent discovery and management timeout

Investigated against the locked public packages: PI WEB 1.202610.9, Pi coding-agent and codemode 1.4.0. No installed host packages, services, live automation state, or host databases were changed.

## Confirmed defects and changes

- **Schema rendering:** Pi codemode's public `renderToolSignature` renderer handles a root `anyOf` before sibling `properties` and `required`. Automations' branches declared only `action`, so rendering lost the other fields and even made `action` optional. The schema now has a flat root with every field, nested requirements, and descriptions of action-specific requirements. The companion and backend share action validation before backend discovery/catalog work. Missing inspect IDs now report `Automation inspect requires automationId`, not errors from every union branch. Nested draft/patch schema validation and backend domain validation remain in place.
- **Duplicate discovery:** machine-scoped agent `list` previously scanned all registered projects/workspaces to identify the cwd, then scanned them all again to list definitions. It now uses one request-local catalog snapshot for both tasks. Each target still requires a fresh authority resolution before exposing its definitions. No cross-request cache, path-based authority, or local fallback was added.
- **Opaque dependency stalls:** a management request now has an eight-second shared read budget, leaving headroom under the released host's ten-second callback deadline. A stalled call reports `catalog.projects.list`, `catalog.workspaces.list` with project ID, or `workspaces.resolve` with exact target IDs. Catalog rejections also identify the failing operation. Cancellation/lifetime shutdown ends the request promptly even if a host promise does not settle. Late read completion cannot resume mutations. The public `workspaces.resolve` API has no per-call cancellation parameter: underlying host work may continue, but its result is fenced out.
- A revoked current-workspace resolution is omitted and counted like other inaccessible targets, rather than preventing all otherwise accessible results. Timeouts/cancellation are not treated as inaccessible targets or successful partial lists.

## What the reported timeout establishes

The released host's backend registry emits `Server plugin automations operation manage timed out after 10000ms` around the plugin's request callback. Companion discovery, backend revision checks, and dispatch precede that callback. This error is therefore consistent with a stall inside management, not evidence that the discovery helper failed or that the UI database is unavailable.

The UI's workspace-scoped `snapshot` reads the selected workspace without performing the agent's machine-wide catalog traversal. A working UI therefore does not prove that discovery for every other registered project/provider works. Exactly one saved automation also says nothing about the number of registered, empty, slow, or inaccessible workspace targets.

The duplicate scan is reproducible and can exhaust the host budget: a test with four one-second catalog reads plus four 750ms authority reads previously required eleven seconds and now requires seven. Hanging catalog and authority fixtures reproduce the working-UI/failing-agent distinction and verify the new phase-specific errors. These are isolated regressions, **not proof of the precise dependency that stalled on the reported Windows host**.

## Regression coverage and remaining verification

- `src/chat-tool.test.ts`: actual Pi codemode declaration rendering, Pi argument validation plus tool execution, all action input shapes, action-specific missing-field errors, invalid revisions/IDs/target pairs, nested schema constraints, and per-invocation machine-backend discovery.
- `src/automation-chat.test.ts`: companion public helper → simulated hosted facade → actual server activation and temporary SQLite store; one catalog traversal, slow and never-settling dependencies, UI snapshot independence, authority checks, cancellation, and no mutation after late resolution. Existing revision, cross-workspace, cancellation, and unknown-run protections remain covered.

Local validation on Linux / Node 22.22.2 passed: typecheck, lint, 161 tests, build, distribution import checks, package allowlist validation, and a production-only tarball install without host peers. The package/install checks use isolated temporary directories.

No real Windows/hosted session, federation, provider profile, or codemode sandbox was launched. The codemode test uses its actual public schema renderer; the hosted facade is simulated. Exact cwd matching remains conservative: aliases, different spellings, or missing matches require explicit IDs for create, and do not authorize a guessed target.

For an operator-controlled reproduction, first verify the actually loaded Automations version and paired server/companion build. Run only `list`, then `inspect` with a returned ID. If listing fails, retain its full operation/target diagnostic and collect the corresponding target machine's PI WEB logs. A remaining generic host timeout can also indicate blocking synchronous work or a different host deadline; JavaScript timers cannot preempt an event-loop block. Do not retry mutations blindly, inspect internal databases, or restart a daemon hosting active work as a diagnostic fallback.
