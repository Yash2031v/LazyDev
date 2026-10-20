import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/server/config.js';

describe('Configuration Loader', () => {
  test('loads safe defaults when no environment variables are set', () => {
    const config = loadConfig({});
    assert.equal(config.port, 4173);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.ollamaHost, 'http://127.0.0.1:11434');
    assert.equal(config.ollamaTimeoutMs, 2000);
    assert.ok(config.allowedHosts.includes('127.0.0.1:4173'));
    assert.ok(config.allowedHosts.includes('localhost:4173'));
  });

  test('accepts valid custom port and settings', () => {
    const config = loadConfig({
      PORT: '5000',
      HOST: 'localhost',
      OLLAMA_HOST: 'http://127.0.0.1:11435',
      OLLAMA_TIMEOUT_MS: '3500'
    });
    assert.equal(config.port, 5000);
    assert.equal(config.host, 'localhost');
    assert.equal(config.ollamaHost, 'http://127.0.0.1:11435');
    assert.equal(config.ollamaTimeoutMs, 3500);
    assert.ok(config.allowedHosts.includes('localhost:5000'));
  });

  test('throws ConfigError on non-integer or out-of-range PORT', () => {
    assert.throws(() => loadConfig({ PORT: 'abc' }), ConfigError);
    assert.throws(() => loadConfig({ PORT: '-1' }), ConfigError);
    assert.throws(() => loadConfig({ PORT: '70000' }), ConfigError);
    assert.throws(() => loadConfig({ PORT: '-80' }), ConfigError);
  });

  test('accepts port 0 for system-assigned ephemeral port in tests', () => {
    const config = loadConfig({ PORT: '0' });
    assert.equal(config.port, 0);
    assert.ok(config.allowedHosts.includes('localhost:*'));
    assert.ok(config.allowedHosts.includes('127.0.0.1:*'));
  });

  test('strictly rejects binding to 0.0.0.0 or public interfaces', () => {
    assert.throws(
      () => loadConfig({ HOST: '0.0.0.0' }),
      /For security, LazyDev local server only permits binding to 127.0.0.1 or localhost/
    );
    assert.throws(
      () => loadConfig({ HOST: '192.168.1.100' }),
      ConfigError
    );
  });

  test('throws on malformed OLLAMA_HOST', () => {
    assert.throws(() => loadConfig({ OLLAMA_HOST: 'not-a-valid-url' }), ConfigError);
    assert.throws(() => loadConfig({ OLLAMA_HOST: 'ftp://127.0.0.1:11434' }), ConfigError);
  });

  test('throws on non-positive OLLAMA_TIMEOUT_MS', () => {
    assert.throws(() => loadConfig({ OLLAMA_TIMEOUT_MS: '0' }), ConfigError);
    assert.throws(() => loadConfig({ OLLAMA_TIMEOUT_MS: '-500' }), ConfigError);
    assert.throws(() => loadConfig({ OLLAMA_TIMEOUT_MS: 'invalid' }), ConfigError);
  });
});
