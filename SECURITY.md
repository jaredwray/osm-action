# Security policy

Report vulnerabilities through this repository's private vulnerability reporting feature if available. Avoid public issues containing secrets or exploit details; otherwise contact the maintainer to arrange a private channel.

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
