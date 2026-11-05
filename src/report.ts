import type { Finding, Report } from './model.ts';
export const commandData = (s: string) => s.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
export const commandProperty = (s: string) => commandData(s).replaceAll(':', '%3A').replaceAll(',', '%2C');
const html = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;').replaceAll('`', '&#96;').replaceAll('|', '&#124;')
  .replace(/[\x00-\x1f\x7f]/g, ' ');
const SUMMARY_FINDINGS = 100;
const ANNOTATIONS = 50;
const rank: Record<string, number> = { 'flagged-repository': 0, incomplete: 1, 'mutable-reference': 2, 'coverage-gap': 3 };
/** Most severe first, so truncated summaries and annotations never hide a blocking finding. */
export function prioritized(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => Number(a.level !== 'error') - Number(b.level !== 'error') ||
    (rank[a.code] ?? 9) - (rank[b.code] ?? 9));
}
export function summary(report: Report): string {
  const findings = prioritized(report.findings);
  const flagged = report.verdicts.filter(x => x.state === 'flagged-repository');
  const lines = [ `## OSM repository intelligence: ${report.result.toUpperCase()}`, '',
    `Target: <code>${html(report.target)}</code>`, '',
    `Checked repositories: **${report.coverage.checkedRepositories}** · Unresolved checks: **${report.coverage.unresolved}** · Coverage gaps: **${report.coverage.gaps}**`, '',
    'A pass means no blocking repository-intelligence findings within this scan’s scope. It does not certify code, packages, containers, or runtime behavior as safe.', '' ];
  if (flagged.length) {
    lines.push('### Flagged repositories', '', '| Repository | OSM report |', '| --- | --- |');
    for (const verdict of flagged) lines.push(`| <code>${html(verdict.repository)}</code> | ${verdict.reportUrl
      ? `<a href="${html(verdict.reportUrl)}">View report</a>` : 'Not provided'} |`);
    lines.push('');
  }
  lines.push('| Finding | Location | Detail |', '| --- | --- | --- |');
  for (const finding of findings.slice(0, SUMMARY_FINDINGS)) lines.push(
    `| ${html(finding.code)} | <code>${html(finding.source)}:${html(finding.file)}:${finding.line}</code> | ${html(finding.message)} |`);
  if (findings.length > SUMMARY_FINDINGS) lines.push('',
    `Showing the ${SUMMARY_FINDINGS} most severe of ${findings.length} findings. The rest are in the JSON report.`);
  lines.push('', '### Excluded from this release', '', ...report.coverage.exclusions.map(x => `- ${html(x)}`), '',
    `Completed: ${report.finishedAt}`, '');
  return lines.join('\n');
}
export function annotations(report: Report): string[] {
  return prioritized(report.findings).slice(0, ANNOTATIONS).map(finding => {
    // Only candidate files can be annotated locally; remote locations remain in the message/report.
    const file = finding.source === report.target ? `file=${commandProperty(finding.file)},line=${finding.line},` : '';
    return `::${finding.level} ${file}title=${commandProperty(finding.code)}::${commandData(`${finding.source}:${finding.file}:${finding.line}: ${finding.message}`)}`;
  });
}
export const exitCode = (report: Report) => report.result === 'pass' ? 0 : report.result === 'fail' ? 1 : 2;
