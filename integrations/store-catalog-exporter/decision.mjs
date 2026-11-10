import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

// Use the job prepared for this export and the result returned by comparison().
export function shopifyDecision(job, result) {
  const { report, receipt } = result ?? {};
  if (!job || !report || !receipt || result.paid !== true || result.test_funds !== true ||
      receipt.network !== 'eip155:84532' || receipt.settlement?.success !== true ||
      receipt.input_hash !== hash(job) || receipt.report_hash !== hash(report) ||
      report.issues_truncated !== false || !Array.isArray(report.issues) ||
      report.issue_count !== report.issues.length) return 'needs_review';
  if (report.status === 'issues_found' && report.issue_count > 0) return 'hold';
  const sourceCount = job.source?.data?.length;
  const summary = report.summary;
  if (report.status === 'passed' && report.issue_count === 0 && summary &&
      Number.isSafeInteger(sourceCount) && sourceCount > 0 &&
      job.target?.data?.length === sourceCount && summary.source_rows === sourceCount &&
      summary.target_rows === sourceCount && summary.matched_rows === sourceCount &&
      summary.checked_values === sourceCount * 2 && job.key?.source === 'id' && job.key.target === 'id' &&
      ['sku:exact','price:decimal'].every(mapping => job.fields?.some(field =>
        field.source === field.target && field.source + ':' + field.type === mapping))) return 'pass';
  return 'needs_review';
}
