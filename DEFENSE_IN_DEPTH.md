# Defense in Depth

Tracking against https://github.com/jaredwray/agentic/blob/main/skills/security/defense-in-depth-nodejs/SKILL.md.

Profile: website/app · public

`package.json` is `"private": true`. This repository ships a GitHub Action and is not published to npm, so § 5 is omitted. Safe Chain, Codex cloud, and Claude Code environment items are omitted because there is no `pnpm-lock.yaml`. The Dev Container image pin is omitted because there is no `devcontainer.json`.

## 1. Security docs
- [x] `SECURITY.md` present — contact info + "How this repository is secured" summary — PR #8
- [x] `DEFENSE_IN_DEPTH.md` present (this file) — PR #8

## 2. CODEOWNERS and cloud bootstrap
- [x] `.github/CODEOWNERS` covers `/.github/`, `/.vscode/`, `/.cursor/`, `/.devcontainer/`, `/.claude/`, `/.codex/`, `/scripts/` with owners the maintainer names — PR #9

## 3. Dependencies (pnpm)
- [x] `packageManager: pnpm@11.3+` pinned in `package.json` — PR #10
- [x] 7-day cooldown: `minimumReleaseAge: 10080`, `minimumReleaseAgeStrict: true`, `minimumReleaseAgeIgnoreMissingTime: false`; no first-party `minimumReleaseAgeExclude` — PR #11
- [ ] `trustPolicy: no-downgrade`; no first-party `trustPolicyExclude` (PR pending)
- [ ] Lifecycle scripts blocked: `strictDepBuilds: true`, `dangerouslyAllowAllBuilds: false`, `allowBuilds: {}` baseline
- [ ] `blockExoticSubdeps: true`
- [ ] Lockfile committed; CI installs with `pnpm install --frozen-lockfile`
- [ ] No `.github/dependabot.yml`; other dependency-update tools (if any) open PRs only — never auto-merge

## 4. GitHub Actions
- [x] `permissions: contents: read` (or `{}` + per-job grants) on every workflow — verified 2026-11-05
- [x] No `contents: write` except jobs whose purpose is mutating the repo (GitHub Release, Changesets version PR); generated output is a workflow artifact, never committed back from CI — verified 2026-11-05
- [x] Every action pinned to a full commit SHA (`npx actions-up`) — verified 2026-11-05
- [ ] Every job installs Socket Firewall (`SocketDev/action` SHA-pinned, `firewall-version` pinned); `pnpm install` / `npm install` run as `sfw pnpm install` / `sfw npm install`
- [ ] `.github/workflows/check-workflows.yaml` lints workflows with zizmor on every PR
- [ ] Workflow `name:` and job `name:` contain no spaces (kebab-case) so they can be set as required status checks
- [x] `persist-credentials: false` on checkouts that don't push — verified 2026-11-05
- [x] No `pull_request_target` on workflows that run untrusted PR code — verified 2026-11-05
- [x] Artifact-publishing workflows disable `actions/setup-node` default caching (`package-manager-cache: false`) to prevent cache poisoning — verified 2026-11-05 (no artifact-publishing workflow)
- [ ] No npm tokens (or other registry credentials) in Actions secrets

## 6. Security tooling
- [x] Aikido runs on every build — verified 2026-11-05 (Aikido Security check on pull requests)
- [ ] Aikido release gate: the release workflow's stage-publish job `needs:` a passing `scan-release`
- [x] Socket reviews every PR that changes dependencies — verified 2026-11-05 (socket-security app)

## 7. Repository lockdown
- [ ] Phishing-resistant 2FA (passkeys / hardware keys) on the GitHub and npm accounts (manual)
- [ ] Recovery codes stored offline in a password manager (manual)
- [ ] `lockdown-repo.sh` applied by a repo admin (never committed to this repo); `--check` with `--required-checks` and `--allowed-actions` passes (PRs required on the default branch, merges blocked unless required status checks pass, tag ruleset, immutable releases, fork-PR approval (public repos), read-only workflow tokens, Actions allowlist, secret scanning, Dependabot disabled, private vulnerability reporting (public repos))
