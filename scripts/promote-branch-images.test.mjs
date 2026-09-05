import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./promote-branch-images.sh', import.meta.url));
const digest = (character) => `sha256:${character.repeat(64)}`;
const api = 'ghcr.io/example/api';
const web = 'ghcr.io/example/web';
const previousApi = digest('a');
const previousWeb = digest('b');
const nextApi = digest('c');
const nextWeb = digest('d');

// A local registry simulator exercises command ordering and partial failures;
// no Docker daemon, registry credentials, or network writes are involved.
const fakeDocker = `#!/usr/bin/env node
const fs = require('node:fs');
const path = process.env.FAKE_REGISTRY;
const state = JSON.parse(fs.readFileSync(path, 'utf8'));
const args = process.argv.slice(2);
state.events.push(args);
function finish(code, text = '') {
  fs.writeFileSync(path, JSON.stringify(state));
  (code ? process.stderr : process.stdout).write(text);
  process.exit(code);
}
if (args[0] !== 'buildx' || args[1] !== 'imagetools') finish(1, 'Unexpected command');
if (args[2] === 'inspect') {
  const ref = args[3];
  if (state.mode === 'snapshot-network-error' && ref.endsWith(':dev')) finish(1, 'registry timeout');
  const digest = state.refs[ref];
  if (!digest) finish(1, 'ERROR: ' + ref + ': not found\\n');
  const arm = state.mode === 'missing-architecture' && ref.includes('/web:dev-sha') ? '' : '  Platform: linux/arm64\\n';
  finish(0, 'Name: ' + ref + '\\nDigest: ' + digest + '\\nManifests:\\n  Platform: linux/amd64\\n' + arm);
}
if (args[2] === 'create') {
  const target = args[4];
  const sourceDigest = args[5].split('@')[1];
  if (state.mode === 'web-promotion-failure' && target.includes('/web:') && sourceDigest === '${nextWeb}') finish(1, 'registry write failed');
  if (state.mode === 'rollback-failure' && target.includes('/api:') && sourceDigest === '${previousApi}') finish(1, 'registry unavailable');
  state.refs[target] = sourceDigest;
  if ((state.mode === 'web-write-then-failure' || state.mode === 'rollback-failure') && target.includes('/web:') && sourceDigest === '${nextWeb}') finish(1, 'write response lost');
  if (state.mode === 'other-publisher' && target.includes('/web:') && sourceDigest === '${nextWeb}') state.refs[target] = '${digest('e')}';
  finish(0);
}
finish(1, 'Unexpected command');
`;

function run(mode = '', initialAliases = true) {
  const directory = mkdtempSync(join(tmpdir(), 'aperture-image-promotion-'));
  try {
    const stateFile = join(directory, 'registry.json');
    writeFileSync(join(directory, 'docker'), fakeDocker, { mode: 0o755 });
    writeFileSync(stateFile, JSON.stringify({ mode, events: [], refs: {
      [`${api}:dev-sha`]: mode === 'sha-digest-mismatch' ? digest('f') : nextApi,
      [`${web}:dev-sha`]: nextWeb,
      ...(initialAliases ? { [`${api}:dev`]: previousApi, [`${web}:dev`]: previousWeb } : {}),
    } }));
    const result = spawnSync('bash', [script], { encoding: 'utf8', env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      FAKE_REGISTRY: stateFile,
      API_IMAGE: api,
      WEB_IMAGE: web,
      IMMUTABLE_TAG: 'dev-sha',
      BRANCH_TAG: 'dev',
      API_EXPECTED_DIGEST: nextApi,
      WEB_EXPECTED_DIGEST: nextWeb,
      GITHUB_STEP_SUMMARY: join(directory, 'summary.md'),
    } });
    return { ...result, state: JSON.parse(readFileSync(stateFile, 'utf8')) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('both SHA images are inspected before aliases move, then both aliases are verified', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state.refs[`${api}:dev`], nextApi);
  assert.equal(result.state.refs[`${web}:dev`], nextWeb);
  assert.deepEqual(result.state.events.slice(0, 2).map((args) => args[3]), [`${api}:dev-sha`, `${web}:dev-sha`]);
  assert.deepEqual(result.state.events.slice(-2).map((args) => args[3]), [`${api}:dev`, `${web}:dev`]);
  assert.ok(result.state.events.filter((args) => args[2] === 'create').every((args) => args[5].includes('@sha256:')));
});

for (const mode of ['missing-architecture', 'sha-digest-mismatch', 'snapshot-network-error']) {
  test(`${mode} leaves both existing aliases untouched`, () => {
    const result = run(mode);
    assert.notEqual(result.status, 0);
    assert.equal(result.state.refs[`${api}:dev`], previousApi);
    assert.equal(result.state.refs[`${web}:dev`], previousWeb);
    assert.equal(result.state.events.filter((args) => args[2] === 'create').length, 0);
  });
}

for (const mode of ['web-promotion-failure', 'web-write-then-failure']) {
  test(`${mode} restores the previous pair and still fails the job`, () => {
    const result = run(mode);
    assert.notEqual(result.status, 0);
    assert.equal(result.state.refs[`${api}:dev`], previousApi);
    assert.equal(result.state.refs[`${web}:dev`], previousWeb);
    assert.match(result.stdout, /Branch promotion failed/);
  });
}

test('a first publication creates both aliases after inspection', () => {
  const result = run('', false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state.refs[`${api}:dev`], nextApi);
  assert.equal(result.state.refs[`${web}:dev`], nextWeb);
});

test('failed first publication preserves shared manifests and reports manual inspection', () => {
  const result = run('web-write-then-failure', false);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /inspect it manually before deploying/);
  assert.ok(result.state.events.every((args) => ['inspect', 'create'].includes(args[2])));
});

test('recovery does not overwrite a digest changed by another publisher', () => {
  const result = run('other-publisher');
  assert.notEqual(result.status, 0);
  assert.equal(result.state.refs[`${api}:dev`], previousApi);
  assert.equal(result.state.refs[`${web}:dev`], digest('e'));
  assert.match(result.stdout, /inspect it manually before deploying/);
});

test('one failed rollback is reported and does not prevent recovery of the other alias', () => {
  const result = run('rollback-failure');
  assert.notEqual(result.status, 0);
  assert.equal(result.state.refs[`${api}:dev`], nextApi);
  assert.equal(result.state.refs[`${web}:dev`], previousWeb);
  assert.match(result.stdout, /Recovery failed/);
});
