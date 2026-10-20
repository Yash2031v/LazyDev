import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server/index.js';
import { loadConfig } from '../src/server/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLIENT_DIR = path.resolve(__dirname, '../src/client');

describe('Server Lifecycle', () => {
  test('starts and binds cleanly to 127.0.0.1, then shuts down cleanly', async () => {
    // Port 0 picks free port
    const testConfig = loadConfig({
      PORT: '0',
      HOST: '127.0.0.1',
      OLLAMA_TIMEOUT_MS: '500'
    });

    const instance = await startServer(testConfig, CLIENT_DIR);
    assert.ok(instance.server.listening);

    const addr = instance.server.address();
    assert.ok(addr && typeof addr === 'object');
    assert.equal(addr.address, '127.0.0.1');

    // Confirm HTTP response
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`, {
      headers: { host: `127.0.0.1:${addr.port}` }
    });
    assert.equal(res.status, 200);

    // Clean shutdown
    await instance.close();
    assert.equal(instance.server.listening, false);
  });
});
