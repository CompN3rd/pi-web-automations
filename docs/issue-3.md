# Issue #3: exact-scope schedule discovery

## Supported operation

`{"action":"list","projectId":"<exact-project-id>","workspaceId":"<exact-workspace-id>"}` lists only the requested workspace on the hosted session's machine. Both IDs are required together. Obtain them from a trusted workspace selection (including the workspace panel URL) or a prior list result, not a guessed path. This is also the supported way to list the current workspace without scanning unrelated providers when its IDs are known.

The backend skips catalog discovery entirely for this form and freshly calls `workspaces.resolve` for only the requested pair before reading definitions. It does not resolve the cwd hint or prepend the browser's current workspace. Paths remain host-returned metadata, never authorization. No authority cache, database fallback, or transport change is introduced.

The response retains the existing machine attribution, generation time, `workspaces` array and `unavailableWorkspaces` count. A successful exact-scope response has one workspace group and zero unavailable workspaces; an authorized empty workspace has `definitions: []`. The backend does not infer `currentWorkspace` from the session cwd for this form. Requested-scope authority denial, mismatched IDs, provider rejection or timeout fails the request explicitly rather than masquerading as an empty or partial success. The existing eight-second management read budget and cancellation fences still apply.

## Compatibility and limits

`{"action":"list"}` retains machine-wide discovery and current-workspace-first ordering. It still omits inaccessible authorities with a count and fails on stalled catalog/authority reads; this change does not add partial timeout results. Existing create defaults, exact-ID inspect, and mutation authority/revision protections are unchanged.

No new cwd-only list mode is provided: the machine-scoped companion transport supplies a cwd hint, not authoritative current project/workspace IDs. Determining uniqueness from that hint requires broad catalog discovery, contrary to the isolation guarantee. If exact IDs are unavailable, machine-wide discovery remains available but is not protected from unrelated provider stalls.

The underlying cause of the reported live provider stall is not established or fixed here. No production state, services, schedules or host databases were accessed. Public Pi extension/tool and PI WEB companion-backend documentation informed the schema and transport handling.

## Regression evidence

- `src/chat-tool.test.ts`: flat codemode-visible schema describes list/create targets; actual Pi argument validation accepts and forwards paired list IDs; partial/empty IDs and caller paths fail before backend discovery.
- `src/automation-chat.test.ts`: exact lists of current, other and empty targets succeed with catalog calls and unrelated authority calls configured never to settle, with assertions that none are invoked. Ambiguous cwd cannot broaden exact selection. Repeated calls freshly resolve authority; revocation, inaccessible/mismatched pairs and stalled requested authority fail explicitly without catalog or current-workspace fallback. Backend validation independently rejects malformed scoped lists before reads.
- Existing machine-wide traversal, timeout, revocation-counting and mutation safety regressions remain in place.

Tests use the public companion helper with a simulated hosted facade, actual server activation and isolated temporary test stores. They do not establish live Aura/provider health or exercise a real hosted codemode session. Scoped discovery still depends on the requested provider being healthy; underlying `workspaces.resolve` work cannot be cancelled through that capability's public API, although late results are fenced out.
