export const TOOL_ID = 'ci-flake-classifier';
export const LIMITS = Object.freeze({ bytes: 1_048_576, attempts: 200, depth: 3, milliseconds: 5000 });
export const RULE_SEVERITY = Object.freeze({
  'input-unreadable': 'error', 'input-invalid': 'error', 'duplicate-key': 'error', 'byte-limit': 'error', 'depth-limit': 'error', 'record-limit': 'error', 'time-limit': 'error', 'export-incomplete': 'error', 'attempt-invalid': 'error', 'no-attempts': 'error', 'insufficient-reruns': 'error', 'intermittent-failure': 'error', 'repeatable-failure': 'error'
});
const UNKNOWN = new Set(['input-unreadable', 'input-invalid', 'duplicate-key', 'byte-limit', 'depth-limit', 'record-limit', 'time-limit', 'export-incomplete', 'attempt-invalid', 'no-attempts', 'insufficient-reruns']);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const identity = v => typeof v === 'string' && v.length > 0 && v.length <= 128 && !/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(v);
function finding(ruleId, pointer = '') {
  if (!Object.hasOwn(RULE_SEVERITY, ruleId)) throw new Error('Unknown rule');
  return { ruleId, severity: RULE_SEVERITY[ruleId], message: {
    'insufficient-reruns': 'Fewer than three matching attempts; intermittent and repeatable failure cannot be distinguished.',
    'intermittent-failure': 'Matching attempts contain both pass and fail outcomes.',
    'repeatable-failure': 'All matching attempts failed; this is not classified as flaky.'
  }[ruleId] ?? 'CI attempt evidence cannot be evaluated safely.', location: { file: '@export', pointer } };
}
function report(findings, classifications = []) {
  findings.sort((a, b) => order(a.location.file, b.location.file) || order(a.location.pointer, b.location.pointer) || order(a.ruleId, b.ruleId));
  const errors = findings.filter(f => f.severity === 'error').length;
  return { schemaVersion: '1', tool: TOOL_ID, status: findings.some(f => UNKNOWN.has(f.ruleId)) ? 'incomplete' : errors ? 'fail' : 'pass', summary: { checked: classifications.length, errors, warnings: 0 }, classifications, findings };
}
export const incomplete = ruleId => report([finding(ruleId)]);
export function parseStrictJson(raw) {
  const value = JSON.parse(raw); let i = 0;
  const space = () => { while (/\s/u.test(raw[i] ?? '')) i++; };
  const token = () => { const start = i++; while (i < raw.length) { if (raw[i] === '\\') { i += 2; continue; } if (raw[i++] === '"') return JSON.parse(raw.slice(start, i)); } throw new Error('input-invalid'); };
  const walk = depth => { if (depth > LIMITS.depth) throw new Error('depth-limit'); space(); if (raw[i] === '{') { i++; space(); const keys = new Set(); while (raw[i] !== '}') { const key = token(); if (keys.has(key)) throw new Error('duplicate-key'); keys.add(key); space(); i++; walk(depth + 1); space(); if (raw[i] !== ',') break; i++; space(); } i++; return; } if (raw[i] === '[') { i++; space(); while (raw[i] !== ']') { walk(depth + 1); space(); if (raw[i] !== ',') break; i++; space(); } i++; return; } if (raw[i] === '"') { token(); return; } while (i < raw.length && !/[\s,}\]]/u.test(raw[i])) i++; };
  walk(0); return value;
}
function tooDeep(v, depth = 0) { return depth > LIMITS.depth || (v !== null && typeof v === 'object' && Object.values(v).some(child => tooDeep(child, depth + 1))); }
export function classifyAttempts(document, { now = Date.now } = {}) {
  const start = now(), expired = () => now() - start > LIMITS.milliseconds;
  if (!object(document)) return incomplete('input-invalid');
  let bytes; try { bytes = Buffer.byteLength(JSON.stringify(document)); } catch { return incomplete('input-invalid'); }
  if (bytes > LIMITS.bytes) return incomplete('byte-limit');
  if (tooDeep(document)) return incomplete('depth-limit');
  if (expired()) return incomplete('time-limit');
  if (document.schemaVersion !== '1' || !Array.isArray(document.attempts) || Object.keys(document).some(k => !['schemaVersion', 'complete', 'attempts'].includes(k))) return incomplete('input-invalid');
  if (document.complete !== true) return incomplete('export-incomplete');
  if (document.attempts.length > LIMITS.attempts) return incomplete('record-limit');
  if (!document.attempts.length) return incomplete('no-attempts');
  const groups = new Map();
  for (const [i, attempt] of document.attempts.entries()) {
    if (expired()) return incomplete('time-limit');
    if (!object(attempt) || !identity(attempt.testId) || !identity(attempt.revision) || !identity(attempt.environment) || !['pass', 'fail'].includes(attempt.result) || (attempt.note !== undefined && typeof attempt.note !== 'string') || Object.keys(attempt).some(k => !['testId', 'revision', 'environment', 'result', 'note'].includes(k))) return report([finding('attempt-invalid', `/attempts/${i}`)]);
    const key = JSON.stringify([attempt.testId, attempt.revision, attempt.environment]);
    if (!groups.has(key)) groups.set(key, { first: i, sourceOrdinals: [], outcomes: [] });
    const group = groups.get(key); group.sourceOrdinals.push(i); group.outcomes.push(attempt.result);
  }
  const findings = [], classifications = [];
  for (const group of groups.values()) {
    if (expired()) return incomplete('time-limit');
    const passes = group.outcomes.filter(x => x === 'pass').length, fails = group.outcomes.length - passes;
    const label = group.outcomes.length < 3 ? 'inconclusive' : fails === 0 ? 'clean' : passes === 0 ? 'repeatable' : 'intermittent';
    const confidence = group.outcomes.length < 3 ? 'insufficient' : group.outcomes.length >= 5 && (label !== 'intermittent' || Math.min(passes, fails) >= 2) ? 'high' : 'medium';
    classifications.push({ firstSourceOrdinal: group.first, label, confidence, sourceOrdinals: group.sourceOrdinals, outcomes: group.outcomes });
    if (label !== 'clean') findings.push(finding({ inconclusive: 'insufficient-reruns', repeatable: 'repeatable-failure', intermittent: 'intermittent-failure' }[label], `/attempts/${group.first}`));
  }
  if (expired()) return incomplete('time-limit');
  return report(findings, classifications);
}
