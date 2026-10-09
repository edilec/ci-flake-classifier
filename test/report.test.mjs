import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyAttempts, LIMITS, parseStrictJson } from '../src/index.mjs';

const attempt = (result = 'pass', testId = 'suite.one', revision = 'abc123', environment = 'linux') => ({ testId, revision, environment, result });
const doc = (attempts = [attempt(), attempt(), attempt()]) => ({ schemaVersion: '1', complete: true, attempts });
const run = (root, input) => spawnSync(process.execPath, ['bin/ci-flake-classifier.mjs', '--root', root, '--input', input], { cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--import=${new URL('../../migration-plan-template/support/deny-network.mjs', import.meta.url).href}` } });

test('three matching successful attempts are clean with ordered history', () => {
  const r = classifyAttempts(doc()); assert.equal(r.status, 'pass'); assert.equal(r.summary.checked, 1); assert.deepEqual(r.classifications[0].outcomes, ['pass', 'pass', 'pass']); assert.deepEqual(r.findings, []);
});
test('same-revision mixed outcomes are intermittent with confidence and retry history', () => {
  const r = classifyAttempts(doc([attempt('fail'), attempt('pass'), attempt('fail')]));
  assert.equal(r.status, 'fail'); assert.equal(r.findings[0].ruleId, 'intermittent-failure'); assert.equal(r.classifications[0].confidence, 'medium'); assert.deepEqual(r.classifications[0].sourceOrdinals, [0, 1, 2]);
  assert.ok(!JSON.stringify(r).includes('suite.one'));
});
test('repeatable failure is not called flaky, and revisions/environments never mix', () => {
  const r = classifyAttempts(doc([attempt('fail'), attempt('fail'), attempt('fail')]));
  assert.equal(r.status, 'fail'); assert.equal(r.findings[0].ruleId, 'repeatable-failure');
  const separated = classifyAttempts(doc([attempt('fail'), attempt('pass', 'suite.one', 'different'), attempt('fail', 'suite.one', 'abc123', 'mac')]));
  assert.equal(separated.status, 'incomplete'); assert.equal(separated.classifications.length, 3);
});
test('two attempts are inconclusive even if one succeeds; five mixed attempts increase confidence', () => {
  assert.equal(classifyAttempts(doc([attempt('fail'), attempt('pass')])).status, 'incomplete');
  const r = classifyAttempts(doc([attempt('fail'), attempt('pass'), attempt('fail'), attempt('pass'), attempt('fail')]));
  assert.equal(r.classifications[0].confidence, 'high'); assert.equal(r.classifications[0].label, 'intermittent');
});
test('incomplete, malformed, duplicate uncertainty and empty exports never pass', () => {
  assert.equal(classifyAttempts({ ...doc(), complete: false }).status, 'incomplete');
  assert.equal(classifyAttempts(doc([])).status, 'incomplete');
  assert.equal(classifyAttempts(doc([attempt(), { ...attempt(), result: 'unknown' }, attempt()])).status, 'incomplete');
});
test('attempt bound exact N passes and N+1 incomplete', () => {
  const x = doc(Array.from({ length: LIMITS.attempts }, () => attempt())); assert.equal(classifyAttempts(x).status, 'pass');
  x.attempts.push(attempt()); assert.equal(classifyAttempts(x).findings[0].ruleId, 'record-limit');
});
test('byte, depth and injected time exact N pass, N+1 incomplete', () => {
  const x = doc(); x.attempts[0].note = ''; const overhead = Buffer.byteLength(JSON.stringify(x)); x.attempts[0].note = 'x'.repeat(LIMITS.bytes - overhead);
  assert.equal(classifyAttempts(x).status, 'pass'); x.attempts[0].note += 'x'; assert.equal(classifyAttempts(x).findings[0].ruleId, 'byte-limit');
  const deep = doc(); assert.equal(classifyAttempts(deep).status, 'pass'); deep.attempts[0].note = { nested: 'x' }; assert.equal(classifyAttempts(deep).findings[0].ruleId, 'depth-limit');
  assert.equal(classifyAttempts(doc(), { now: (() => { let n=0; return () => n++ ? LIMITS.milliseconds : 0; })() }).status, 'pass');
  assert.equal(classifyAttempts(doc(), { now: (() => { let n=0; return () => n++ ? LIMITS.milliseconds + 1 : 0; })() }).findings[0].ruleId, 'time-limit');
});
test('duplicate JSON keys including escaped spelling are refused', () => assert.throws(() => parseStrictJson('{"complete":false,"complet\\u0065":true}'), /duplicate-key/));
test('CLI reads only real-root local strict UTF-8; usage error stdout empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flake-')); await writeFile(join(root, 'good.json'), JSON.stringify(doc())); assert.equal(run(root, 'good.json').status, 0);
  await writeFile(join(root, 'bad.json'), Buffer.from([0xff])); assert.equal(JSON.parse(run(root, 'bad.json').stdout).status, 'incomplete');
  await symlink(tmpdir(), join(root, 'escape')); const escaped = run(root, 'escape/nonexistent.json'); assert.equal(escaped.status, 2); assert.equal(JSON.parse(escaped.stdout).status, 'incomplete');
  const usage = spawnSync(process.execPath, ['bin/ci-flake-classifier.mjs', '--root', root, '--input', 'good.json', '--unknown'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }); assert.equal(usage.status, 2); assert.equal(usage.stdout, '');
});
