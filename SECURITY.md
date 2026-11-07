# Security policy

We take security seriously and work to keep this project up to date. If you discover a security vulnerability, report it in public and email the maintainer. Security work on this project stays transparent.

## Reporting a vulnerability

Do both:

1. **Open a public GitHub issue** on this repository. Put `[SECURITY]` in the title and include the details below. The issue is the public record.
2. **Email** the same report to me@jaredwray.com with `[SECURITY]` in the subject line, and include the link to the issue you opened.

When reporting, please include as much of the following as you can:

- A description of the vulnerability and its impact.
- Steps to reproduce, or a proof-of-concept.
- The affected version(s) and platform.
- Any suggested remediation, if you have one.

We will acknowledge receipt on the issue and by email, fix it in public, and credit you on the issue once a fix is published unless you ask to remain anonymous.

## How this repository is secured

This repository follows the [defense-in-depth](https://github.com/jaredwray/agentic/blob/main/skills/security/defense-in-depth-nodejs/SKILL.md) hardening checklist; progress is tracked in [DEFENSE_IN_DEPTH.md](./DEFENSE_IN_DEPTH.md). Measures currently in place:

- The repository blocks a direct push to the default branch.
- The repository requires a pull request.
- A merge requires the `verify` check and the `zizmor` check.
- Only a repository admin can create a tag.
- GitHub keeps a published release immutable.
- An outside collaborator needs approval before a workflow run.
- Only an allowlisted GitHub Action can run.
- CI sets each workflow to `contents: read`.
- A job gets `contents: write` only when that job changes the repository.
- CI keeps output in a workflow artifact.
- CI does not commit that output.
- CI pins each action to a full commit SHA.
- Socket Firewall wraps `pnpm install` and `npm install`.
- zizmor checks each workflow on every pull request.
- Codespaces, Cursor Cloud Agents, and Claude Code on the web install through Aikido Safe Chain; package-manager shims must not be bypassed.
- The Codespaces Dev Container image is pinned by digest (`name:<tag>@sha256:<digest>`), not a floating tag.
- Dependencies install through pnpm with a 7-day cooldown on new versions, lifecycle scripts blocked by default, and `trustPolicy: no-downgrade`. Socket reviews every dependency change; Aikido scans every build.

## Trust model

The pinned Action reads candidate files through GitHub's API at an explicit full commit SHA. It never checks out, imports, builds, installs, or executes the candidate. Active policy comes only from trusted workflow inputs; candidate configuration and suppression files are never loaded.

API destinations are fixed, redirects are refused, credentials are header-only, and upstream bodies/errors are not echoed; user-facing error messages are fixed project text. OSM report links are kept only when they point to `https://opensourcemalware.com/`. Private dependency repository identities are not sent to OSM; their reputation checks are incomplete. Reports still contain private names available through GitHub, so keep them inside your organization.

The scanner bounds source/response sizes, dependency counts, recursion, retries, and request durations. It rejects custom YAML tags, duplicates, merge keys, exponential alias expansion, unsafe paths, and symlink metadata, and checks downloaded Git blob hashes. Set an overall job timeout too.

Local CLI mode expects a trusted, stable filesystem snapshot. It does not provide filesystem isolation against a concurrent process replacing parent directories. Use API mode for untrusted PR inspection.

## Issue reporting

With `create-issues`, the Action writes issues to the workflow's own repository only for `push`, `schedule`, and `workflow_dispatch` runs on its default branch, when that repository is the scan target. Pull request events never write issues. Issue state, including issues closed as not planned, never changes the scan result. Scanned names, refs, and paths are rendered only inside Markdown code spans, and links are built from validated GitHub and OpenSourceMalware URLs, so dependency metadata cannot inject links, mentions, or HTML. Issue creation is never retried after a network or server error, to avoid duplicates. Dashboard issues list private dependency names, so enable this only where issue visibility matches repository visibility.

## Coverage limits

A pass means no blocking findings within GitHub repository-intelligence scope. It does not certify commits or artifacts as malware-free. Root-project code, package malware, container reputation/contents, JavaScript and pre/post hooks, shell scripts, runtime downloads, and runner integrity are outside v0.1's analysis. `complete` refers to required repository checks. `fail-on-gaps` blocks encountered unsupported surfaces; it does not analyze them.

GitHub fork-network commits can be accessible through another repository's namespace. Resolving a SHA and verifying blob bytes does not authenticate that commit to the claimed maintainer. Retain zizmor's impostor-commit checks. SHA pins do not freeze external downloads or prove benign code.

Protect scanner/policy workflows through reviews and rulesets. The sample fork status is not tamper-proof against other workflows/actors with `statuses: write`; restrict token permissions and use an independently trusted App/check producer for stronger enforcement. A merge check cannot prevent concurrent PR workflows from executing. Keep untrusted builds isolated and without production credentials.

## Release requirements

This initial implementation uses synthetic API fixtures. Before a stable release, validate the authenticated OSM contract for no-match, flagged, multiple-report, normalization, and correction cases. Run GitHub-hosted fork and failure-path smoke tests. Review OSM licensing for public reports and commercial/hosted uses. Never publish a shared OSM key or redistribute a cached threat database.
