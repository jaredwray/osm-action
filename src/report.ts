import type { Report } from './model.ts';
export const commandData = (s: string) => s.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
export const commandProperty = (s: string) => commandData(s).replaceAll(':', '%3A').replaceAll(',', '%2C');
const html = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;').replaceAll('`', '&#96;').replaceAll('|', '&#124;')
  .replace(/[\x00-\x1f\x7f]/g, ' ');
export function summary(report: Report): string {
  const lines = [ `## OSM repository intelligence: ${report.result.toUpperCase()}`, '',
    `Target: <code>${html(report.target)}</code>`, '',
    `Checked repositories: **${report.coverage.checkedRepositories}** · Unresolved checks: **${report.coverage.unresolved}** · Coverage gaps: **${report.coverage.gaps}**`, '',
    'A pass means no blocking repository-intelligence findings within this scan’s scope. It does not certify code, packages, containers, or runtime behavior as safe.', '',
    '| Finding | Location | Detail |', '| --- | --- | --- |' ];
  for (const finding of report.findings.slice(0, 100)) lines.push(
    `| ${html(finding.code)} | <code>${html(finding.source)}:${html(finding.file)}:${finding.line}</code> | ${html(finding.message)} |`);
  if (report.findings.length > 100) lines.push('', 'Additional findings are in the JSON report.');
  lines.push('', '### Excluded from this release', '', ...report.coverage.exclusions.map(x => `- ${html(x)}`), '',
    `Completed: ${report.finishedAt}`, '');
  return lines.join('\n');
}
export function annotations(report: Report): string[] {
  return report.findings.slice(0, 50).map(finding => {
    // Only candidate files can be annotated locally; remote locations remain in the message/report.
    const file = finding.source === report.target ? `file=${commandProperty(finding.file)},line=${finding.line},` : '';
    return `::${finding.level} ${file}title=${commandProperty(finding.code)}::${commandData(`${finding.source}:${finding.file}:${finding.line}: ${finding.message}`)}`;
  });
}
export const exitCode = (report: Report) => report.result === 'pass' ? 0 : report.result === 'fail' ? 1 : 2;
