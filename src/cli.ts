import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { GitHub, LocalSource } from './source.ts';
import { OSM } from './osm.ts';
import { scan, defaultPolicy } from './scan.ts';
import { exitCode, summary } from './report.ts';
import { safeErrorMessage, ScanError, SHA } from './model.ts';
async function main() {
  const { values } = parseArgs({ options: {
    repository: { type: 'string' }, sha: { type: 'string' }, path: { type: 'string' },
    output: { type: 'string' }, format: { type: 'string', default: 'json' },
    'allow-mutable-refs': { type: 'boolean', default: false },
    'fail-on-gaps': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' }
  } });
  if (values.help) {
    console.log('Usage: node dist/cli.cjs [--path DIR | --repository OWNER/REPO --sha COMMIT] [--output FILE] [--format json|summary] [--allow-mutable-refs] [--fail-on-gaps]\nCredentials: OSM_API_TOKEN (required), GITHUB_TOKEN (recommended). Exit codes: 0 pass, 1 blocked, 2 incomplete/error.'); return;
  }
  if (!['json', 'summary'].includes(values.format!)) throw new ScanError('--format must be json or summary');
  if (Boolean(values.repository) !== Boolean(values.sha) || (values.repository && values.path) ||
      (values.sha && !SHA.test(values.sha))) throw new ScanError('Use --repository and a full --sha together, or --path');
  const github = new GitHub(process.env.GITHUB_TOKEN ?? '');
  const osm = new OSM(process.env.OSM_API_TOKEN ?? '');
  const source = values.repository ? (await github.resolve(values.repository, values.sha!)).source : new LocalSource(values.path ?? '.');
  const report = await scan(source, github, osm, { ...defaultPolicy,
    requireSha: !values['allow-mutable-refs'], failOnGaps: values['fail-on-gaps'] });
  const content = values.format === 'summary' ? summary(report) : JSON.stringify(report, null, 2) + '\n';
  if (values.output) await writeFile(values.output, content, { flag: 'wx', mode: 0o600 });
  else process.stdout.write(content);
  process.exitCode = exitCode(report);
}
main().catch(error => {
  // Inputs, upstream errors, and paths may contain credentials. Only fixed project messages are shown.
  const reason = safeErrorMessage(error) ?? 'Check arguments, credentials, repository access, and output path';
  console.error(`Scan could not start or write its report: ${reason}. Use --help for usage.`);
  process.exitCode = 2;
});
