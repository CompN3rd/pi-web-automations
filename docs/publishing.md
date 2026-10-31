# Publishing to npm through GitHub Actions

The release workflow is `.github/workflows/publish.yml` in `CompN3rd/pi-web-automations`. It adapts the sibling Code Review and Subagents workflows: pinned actions, stable tag/main ancestry checks, a separate unprivileged verification/build, artifact identity and SHA-256 verification, and an OIDC-only publication job without checkout or lifecycle execution.

This package uses **direct `npm publish`**, not those siblings' `npm stage publish`, because the approved release outcome includes actual publication. Direct publishing requires the corresponding npm trusted-publisher permission. If trust is configured stage-only, stop for maintainer setup/approval; do not substitute credentials, weaken 2FA or claim a staged package is public.

## One-time maintainer setup

1. On GitHub, enable Actions for this public repository. Configure environment **`npm`**, preferably restricting deployment to `v*` tags and adding any desired reviewer protection. Environment approval, if configured, is a human gate.
2. In npm settings for **`@compn3rd/pi-web-automations`**, add a GitHub Actions trusted publisher with exact, case-sensitive fields:
   - Organization/user: **`CompN3rd`**
   - Repository: **`pi-web-automations`**
   - Workflow filename: **`publish.yml`** (not a path)
   - Environment: **`npm`**
   - Allowed actions: **allow `npm publish`** for direct publication.
3. No `NPM_TOKEN`, `NODE_AUTH_TOKEN` or other static publish secret is needed or accepted. Do not bypass account security if npm setup or approval is missing. The workflow requires npm >=11.5.1 on GitHub-hosted Node 24 and grants `id-token: write` only to publication.

npm trust configuration is maintained on npmjs.com, not inferred from `npm whoami` or registry metadata. Newly created trust must be used within npm's activation window. See [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers).

## Release procedure

1. Update `package.json`, lockfile and release documentation coherently. Run `npm ci` and `npm run verify`. Complete the required independent review before tagging/publication.
2. Commit the reviewed result, push main, and confirm CI. Create and push the matching stable tag, e.g. `v0.2.0`. The release tag must match both manifests and be on `origin/main` history. A manually dispatched run must target that tag, not main.
3. Watch **Publish npm release**. It runs the full CI matrix (including minimum peers), builds/verifies the package, uploads one tarball, then verifies its SHA-256/name/version/repository in the isolated `npm` environment job. It publishes that exact artifact with provenance. It does not rebuild under publish permissions or automatically create a GitHub release.
4. If publication fails, inspect the actual job logs and registry before retrying. An accepted publish followed by a lost response is not permission to publish again or change a released version. Missing trust/approval requires the maintainer; no token fallback. Rerun a corrected transient job only after checking whether the version already exists.
5. Confirm `npm view @compn3rd/pi-web-automations@0.2.0 version dist.integrity dist.attestations --json`, check `npm view @compn3rd/pi-web-automations dist-tags --json`, and compare the public tarball to the workflow artifact (SHA-512 npm integrity and/or SHA-256). Check provenance refers to this repository/workflow/tag. Only then create the GitHub release for the existing tag using `docs/releases/0.2.0.md` as notes.

A successful dry run validates package shape, **not** npm authorization. A pushed tag or staged publication is not completion. The release is complete only when public registry publication and the GitHub release have actually been verified. No running PI WEB daemon or production state needs to change to publish this package.
