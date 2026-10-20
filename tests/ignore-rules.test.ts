import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { IgnoreEngine } from '../src/server/project/ignore-rules.js';

describe('Ignore Engine & Secret Rules', () => {
  let tempDir: string;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazydev-ignore-test-'));
    const gitignoreContent = `
# Ignored patterns for test
*.log
temp/
/anchored.txt
!important.log
`;
    await fs.writeFile(path.join(tempDir, '.gitignore'), gitignoreContent);
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test('excludes default folders like node_modules, .git, and dist', () => {
    const engine = new IgnoreEngine();

    assert.equal(engine.shouldIgnore('node_modules', true).ignored, true);
    assert.equal(engine.shouldIgnore('.git', true).ignored, true);
    assert.equal(engine.shouldIgnore('dist', true).ignored, true);
    assert.equal(engine.shouldIgnore('.next', true).ignored, true);
    assert.equal(engine.shouldIgnore('node_modules/foo/package.json', false).ignored, true);
  });

  test('identifies and excludes secret files', () => {
    const engine = new IgnoreEngine();

    const secrets = [
      '.env',
      '.env.local',
      '.env.production',
      'id_rsa',
      'id_ed25519',
      'server.key',
      'cert.pem',
      'credentials.json',
      'token.json',
      'service-account-key.json',
      'secrets.yaml',
      'aws_access_key.txt'
    ];

    for (const secret of secrets) {
      const res = engine.shouldIgnore(secret, false);
      assert.equal(res.ignored, true, `Expected "${secret}" to be ignored as secret`);
      assert.equal(res.reason, 'secret', `Expected reason to be secret for "${secret}"`);
    }
  });

  test('permits regular non-secret source files', () => {
    const engine = new IgnoreEngine();

    const safeFiles = [
      'src/index.ts',
      'package.json',
      'README.md',
      'tsconfig.json',
      'components/Button.tsx',
      'assets/logo.svg'
    ];

    for (const safe of safeFiles) {
      assert.equal(engine.shouldIgnore(safe, false).ignored, false, `Expected "${safe}" to be permitted`);
    }
  });

  test('parses and respects .gitignore rules', async () => {
    const engine = await IgnoreEngine.loadForRoot(tempDir);

    // *.log should be ignored
    assert.equal(engine.shouldIgnore('app.log', false).ignored, true);
    assert.equal(engine.shouldIgnore('debug.log', false).ignored, true);

    // !important.log should be permitted via negation
    assert.equal(engine.shouldIgnore('important.log', false).ignored, false);

    // temp/ folder should be ignored
    assert.equal(engine.shouldIgnore('temp', true).ignored, true);

    // anchored /anchored.txt should be ignored at root
    assert.equal(engine.shouldIgnore('anchored.txt', false).ignored, true);

    // unignored file
    assert.equal(engine.shouldIgnore('main.js', false).ignored, false);
  });
});
