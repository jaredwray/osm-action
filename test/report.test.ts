import test from 'node:test';
import assert from 'node:assert/strict';
import { annotations, commandData, commandProperty, summary } from '../src/report.ts';
import type { Report } from '../src/model.ts';
test('workflow command payloads cannot create new commands or properties', () => {
  assert.equal(commandData('a\n::error::bad%\r'), 'a%0A::error::bad%25%0D');
  assert.equal(commandProperty('a,b:c\n'), 'a%2Cb%3Ac%0A');
});
test('summary escapes HTML and annotations do not attribute upstream files to the candidate', () => {
  const report: Report = { schemaVersion: 1, scannerVersion: '0.1.0', startedAt: '', finishedAt: '', target: '<script>bad</script>',
    scope: 'github-repository-intelligence', result: 'fail', complete: true, assets: [], verdicts: [], files: [],
    coverage: { checkedRepositories: 1, unresolved: 0, gaps: 0, exclusions: [] },
    findings: [{ source: 'upstream', file: 'action.yml\n::error::bad', line: 1, chain: [], code: 'flagged-repository',
      level: 'error', message: '<img src=x>\n::notice::injected' }] };
  assert.doesNotMatch(summary(report), /<script>|<img /);
  assert.ok(!annotations(report)[0]!.includes('file='));
  assert.equal(annotations(report)[0]!.split('\n').length, 1);
});

test('blocking findings come first so truncation never hides them', () => {
  const gap = (line: number) => ({ source: 'root', file: '.github/workflows/a.yml', line, chain: [], code: 'coverage-gap',
    level: 'warning' as const, message: 'Shell execution is not inspected' });
  const report: Report = { schemaVersion: 1, scannerVersion: '0.1.0', startedAt: '', finishedAt: '', target: 'root',
    scope: 'github-repository-intelligence', result: 'fail', complete: true, assets: [], files: [],
    verdicts: [{ repository: 'bad/action', state: 'flagged-repository', checkedAt: '',
      reportUrl: 'https://opensourcemalware.com/repository/x"><script>' }],
    coverage: { checkedRepositories: 1, unresolved: 0, gaps: 200, exclusions: [] },
    findings: [...Array.from({ length: 200 }, (_, i) => gap(i + 1)), { source: 'root', file: '.github/workflows/a.yml',
      line: 999, chain: [], code: 'flagged-repository', level: 'error', message: 'OSM flags this repository.' }] };
  const text = summary(report);
  assert.match(text, /### Flagged repositories/); assert.match(text, /<code>bad\/action<\/code>/);
  assert.doesNotMatch(text, /<script>/);
  assert.ok(text.indexOf('| flagged-repository |') < text.indexOf('| coverage-gap |'));
  assert.match(text, /Showing the 100 most severe of 201 findings/);
  assert.match(annotations(report)[0]!, /^::error file=.*title=flagged-repository::/);
  assert.equal(report.findings.at(-1)!.code, 'flagged-repository');
});
