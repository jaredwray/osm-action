import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitHub } from './source.ts';
import { OSM } from './osm.ts';
import { scan, defaultPolicy } from './scan.ts';
import { annotations, commandData, exitCode, summary } from './report.ts';
import { safeErrorMessage, ScanError, SHA } from './model.ts';
function input(name: string) { return process.env[`INPUT_${name.toUpperCase()}`] ?? ''; }
function boolean(name: string, fallback: boolean) {
  const value = input(name);
  if (!value) return fallback;
  if (!['true', 'false'].includes(value)) throw new ScanError(`Input ${name} must be true or false`);
  return value === 'true';
}
async function main() {
  const token = input('osm-token');
  if (token) console.log(`::add-mask::${commandData(token)}`);
  const repo = input('repository');
  const sha = input('sha');
  if (!repo || !SHA.test(sha)) throw new ScanError('Inputs repository and sha (a full 40-character commit SHA) are required');
  const temp = process.env.RUNNER_TEMP;
  const output = process.env.GITHUB_OUTPUT;
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (!temp || !output || !stepSummary) throw new ScanError('Missing Actions runtime paths; run this inside GitHub Actions');
  const github = new GitHub(input('github-token'));
  const osm = new OSM(token);
  const source = (await github.resolve(repo, sha)).source;
  const report = await scan(source, github, osm, { ...defaultPolicy,
    requireSha: boolean('require-sha', true), failOnGaps: boolean('fail-on-gaps', false) });
  const dir = await mkdtemp(join(temp, 'osm-action-'));
  const reportPath = join(dir, 'report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await appendFile(stepSummary, summary(report));
  await appendFile(output, `result=${report.result}\ncomplete=${report.complete}\nreport-path=${reportPath}\nchecked-repositories=${report.coverage.checkedRepositories}\n`);
  for (const annotation of annotations(report)) console.log(annotation);
  process.exitCode = exitCode(report);
}
main().catch(error => {
  // Only fixed project messages are shown; upstream bodies, paths, and credentials are never echoed.
  const reason = safeErrorMessage(error) ?? 'Verify the explicit candidate SHA, credentials, permissions, and API access';
  console.log(`::error::${commandData(`OSM scan could not start or write its report: ${reason}. Scan is incomplete.`)}`);
  process.exitCode = 2;
});
