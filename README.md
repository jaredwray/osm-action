# osm-action

A reusable GitHub Action and CLI that check **GitHub Actions dependency repositories** against [OpenSourceMalware](https://docs.opensourcemalware.com/api/overview). It recursively inspects action metadata and reusable workflows without executing their code.

**Status: initial implementation, not a stable release.** Automated tests use synthetic API responses. Authenticated OSM contract validation and GitHub-hosted smoke tests remain release requirements. This client is not affiliated with OpenSourceMalware.

The scanner reads all workflow files at the specified commit and checks the public repositories behind their declared action dependencies against OSM. If your workflow uses Action A and its composite metadata calls Action B, both repositories are checked. The candidate workflows and actions are read as data, without running their code.

## Features

- Resolves remote `uses:` references to commits and inspects metadata at those commits.
- Traverses composites, reusable workflows, and supported local-action paths, preserving dependency chains and source lines.
- Blocks mutable refs by default and blocks OSM-flagged repositories pending review.
- Fails incomplete scans: missing credentials, API outages, invalid YAML, inaccessible dependencies, and exceeded limits never become a pass.
- Deduplicates repository lookups per run and paces OSM requests at approximately 28/minute.
- Emits a JSON inventory, job summary, annotations, content hashes, and explicit coverage gaps.
- Keeps private dependency identities out of OSM requests; their reputation checks remain incomplete.

This is repository intelligence, not code or package malware analysis. A flagged repository does not prove the selected commit is malicious; a no-match does not establish safety. Keep [zizmor](https://docs.zizmor.sh/), dependency vulnerability checks, and runtime protection alongside it.

## GitHub Action

1. Obtain an [OpenSourceMalware API token](https://docs.opensourcemalware.com/api/overview).
2. In your repository, open **Settings → Secrets and variables → Actions**, then create a secret named `OSM_API_TOKEN`. An organization secret with access granted to the repository also works.
3. Create `.github/workflows/osm.yml` using the example below. Change `main` if your protected branch has a different name.
4. Replace `PINNED_OSM_ACTION_COMMIT` with a reviewed 40-character commit SHA that includes `dist/action.cjs`. This placeholder is not a usable ref; there is no stable release yet.

```yaml
name: OSM malware check

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  malware:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: jaredwray/osm-action@PINNED_OSM_ACTION_COMMIT
        with:
          osm-token: ${{ secrets.OSM_API_TOKEN }}
          repository: ${{ github.repository }}
          sha: ${{ github.sha }}
  build:
    needs: malware
    runs-on: ubuntu-latest
    steps:
      - run: echo 'Place checkout, installs, and build steps in this gated job'
```

Use that pattern in protected/trusted workflows. The scanner job needs no checkout or npm installation and must not execute candidate code. The runner must support Node 24 actions.

Full commit pinning is enabled by default: existing references such as `actions/checkout@v6` will fail the check. Pin every remote action and reusable workflow, including nested dependencies, to a full commit SHA.

To gate an existing build or release, add the `malware` job to that same workflow and set `needs: malware` on the build/release job (preserving any existing dependencies). The scan above does not stop jobs in other workflows. For pull requests from forks, use the [fork inspection template](examples/fork-pr.yml) and the setup described below.

The job summary and annotations explain the result; the JSON report records dependency paths and coverage gaps.

| Result | Meaning | Job outcome |
| --- | --- | --- |
| `pass` | All required repository checks completed with no blocking findings under the configured policy; this does not establish that the code is malware-free | Success |
| `fail` | A repository was flagged or a policy requirement was violated | Failure |
| `incomplete` | Required checks could not finish, for example because of an API outage or inaccessible dependency | Failure |

Keep [zizmor](https://docs.zizmor.sh/) enabled for workflow security checks alongside OSM repository threat intelligence.

| Input | Default | Meaning |
| --- | --- | --- |
| `osm-token` | required | User-supplied OSM token; never publish a shared token |
| `github-token` | `${{ github.token }}` | GitHub read token; private cross-repository access may need additional authorization |
| `repository` | required | Explicit candidate `owner/repository` |
| `sha` | required | Explicit full candidate commit SHA |
| `require-sha` | `true` | Block mutable refs; false still reports warnings |
| `fail-on-gaps` | `false` | Block encountered unsupported execution surfaces, including JavaScript action code and scripts |

There is no PR-controlled policy file, arbitrary API URL, persistent verdict cache, or blanket suppression. `fail-on-gaps: true` blocks typical workflows using JavaScript actions; it is a coverage requirement, not a deeper scanning mode.

| Output | Meaning |
| --- | --- |
| `result` | `pass`, `fail`, or `incomplete` |
| `complete` | Required repository checks completed; not all-code coverage |
| `report-path` | JSON report under `RUNNER_TEMP` |
| `checked-repositories` | Successfully checked unique public repositories |

Startup errors have no outputs and exit nonzero; the error names the cause (for example a missing token, rejected credentials, or an inaccessible commit) without echoing upstream responses, paths, or credentials. Findings are written before scan failure. Upload steps should use `if: always()` and check `report-path` is nonempty. Reports contain dependency identities; do not upload private inventories publicly.

## Fork PRs and execution gates

Ordinary fork `pull_request` runs do not receive repository secrets. The [fork inspection template](examples/fork-pr.yml) uses a pinned scanner under `pull_request_target`, reads PR-head files as data, and publishes a status against that exact head SHA from a separate reporting job. Never add PR checkout, scripts, installs, local PR actions, or PR-defined policy to this privileged workflow.

After installation, require `OSM / repository-intelligence` through branch protection/rulesets and require workflow-policy review. The status is attached to the candidate head, not the default-branch SHA of `pull_request_target`. Other workflows with status-write permission can spoof this context; use an independently trusted App for stronger enforcement. Merge-queue support requires an additional trusted check on the exact merge-group commit and is not included in this template.

**Merge protection does not stop a concurrent build.** Use `needs: malware` for protected build/release jobs; `needs` does not span separate workflows. Keep fork builds isolated and unprivileged. Job containers/services start before steps, so scanning as the first step of the same job is insufficient.

Other templates: [protected build](examples/trusted-build.yml), [scheduled rechecks](examples/scheduled.yml). Rechecks find newly reported threats without source changes. Check again before release. Example schedules are not enabled by this repository.

## CLI

Requires Node.js 24+. Supply `OSM_API_TOKEN` and optionally `GITHUB_TOKEN` via your environment/secret manager. Tokens are not accepted as command-line arguments.

```sh
node dist/cli.cjs --help
node dist/cli.cjs --path /path/to/repository --output osm-report.json
node dist/cli.cjs --repository owner/repo --sha FULL_COMMIT_SHA --format summary
```

Output files must not already exist. Exit **0**: no blocking repository findings; **1**: policy blocked; **2**: incomplete/error. `--allow-mutable-refs` relaxes pinning; `--fail-on-gaps` blocks unsupported surfaces. Local mode expects a stable working tree and records content hashes but cannot establish an immutable Git snapshot. Remote mode uses the same API implementation as the Action.

## Coverage

| Surface | v0.1 behavior |
| --- | --- |
| Remote actions/subdirectories | Resolve SHA, check public repository reputation, parse `action.yml`/`action.yaml` |
| Composites/reusable workflows | Recursive traversal with bounded cycles/depth and dependency chains |
| Local reusable workflows | Resolve in their owning repository and commit |
| Step-level local actions (including `./`) | Resolve against caller workspace after unconditional default `actions/checkout` with default or literal-true cleanup (`ref: ${{ github.sha }}`, `ref: ${{ github.event.pull_request.head.sha }}`, and `repository: ${{ github.repository }}` count as default); disabled/dynamic cleanup, other checkout sources/refs/paths, or intervening code make the workspace unknown |
| JavaScript actions | Repository/metadata checked; code, bundles, and hooks are uninspected |
| Containers/services/Dockerfiles | Coverage warnings; Dockerfile-only actions use the runner's `Dockerfile`/`dockerfile` fallback after metadata files; image checks not implemented |
| Shell and runtime downloads | Coverage warnings; never executed/interpreted |
| Package lockfiles/transitive packages | Out of scope; no package/version verdicts |
| Private/inaccessible dependencies | Incomplete; private identities are not queried with OSM |
| Root-project malware, impostor commits, runner compromise | Out of scope |

References are inspected even when workflow conditions might skip them. No expression evaluation, matrix expansion, arbitrary checkout modeling, GitHub Enterprise Server, or custom API endpoints. The root project itself is not queried with OSM; declared remote dependencies are.

Limits: 100 workflow files, 100 distinct action/workflow references, 300 distinct documents (each document is traversed once per workspace state; every caller remains recorded in the asset locations), 3,000 job/step nodes, depth 10, 512 KB/source file, 50,000 tree entries, 8 MB/GitHub response, 2 MB/OSM response, 20 seconds/request, three attempts (transient network errors, 5xx responses, and GitHub/OSM rate limits are retried), and retry waits no longer than 60 seconds. YAML anchors and aliases are supported with bounded expansion. Truncated Git trees, merge keys (unsupported by GitHub), custom YAML tags, duplicate keys, unsafe paths, and symlink metadata are rejected. Set an overall job timeout.

OSM's [token quotas](https://docs.opensourcemalware.com/api/rate-limits) and [IP/daily limits](https://docs.opensourcemalware.com/api/api-errors) apply across jobs. Per-run throttling cannot coordinate other runners behind a shared IP. No persistent verdict cache is used, avoiding stale negatives and cross-PR cache poisoning.

## Development and release

```sh
npm ci --ignore-scripts
npm run check
npm run check:dist
```

Synthetic tests cover nested findings, private repositories, parser attacks, paths, bounded HTTP behavior, error redaction, report escaping, and bundled entry points without executing malware. Commit `dist/`; CI checks that rebuilding produces no diff. MIT covers this client; see `THIRD_PARTY_NOTICES.txt` for the bundled YAML library license.

Before a stable release: validate live OSM identity normalization, positive details, multiple reports, and corrections; run GitHub-hosted fork and failure-path smoke tests; review [OSM terms](https://opensourcemalware.com/terms-of-use). User-supplied keys do not automatically settle licensing for commercial services or redistribution.

See [SECURITY.md](SECURITY.md) for the trust model. Planned extensions: version-aware package/container checks, SARIF, scoped expiring exceptions, and an optional GitHub App. These are not implied by the current pass result.
