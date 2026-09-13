import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import {
  buildPersonalProviderConfig,
  defaultPersonalProviderPath,
  ensureZcodePersonalProviders,
  legacyProviderApiType,
  mergePersonalProviderConfig,
} from '../../src/zcode/personalConfig.js';
import type { ZcodeCliConfig } from '../../src/zcode/models.js';

const cli: ZcodeCliConfig = {
  provider: {
    'builtin:zai': { kind: 'anthropic', options: { apiKey: 'synthetic-builtin' }, models: { skip: {} } },
    'account:bigmodel': { kind: 'anthropic', options: { apiKey: 'synthetic-account' }, models: { skip: {} } },
    relay: {
      kind: 'anthropic',
      name: 'Relay',
      options: { apiKey: 'synthetic-relay-key', baseURL: 'https://relay.example.test', apiKeyRequired: true },
      models: { 'glm-main': { name: 'Main' }, gone: { name: 'Gone', deleted: true } as { name: string } },
    },
    bare: { kind: 'openai-compatible', options: { apiKey: '   ' }, models: { x: {} } },
    open: { kind: 'openai', options: { apiKey: 'synthetic-open', apiKeyRequired: false }, models: { x: {} } },
  },
  model: { main: 'relay/glm-main', lite: 'relay/glm-main' },
};

describe('ZCode personal provider projection', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('maps custom CLI providers and skips builtin/account/unauthenticated', () => {
    const doc = buildPersonalProviderConfig(cli);
    assert.deepEqual(doc.config.providerOrder, ['relay']);
    assert.equal(doc.config.providerConfigRules.providerRules.length, 1);
    const rule = doc.config.providerConfigRules.providerRules[0]!;
    assert.equal(rule.providerId, 'relay');
    assert.equal(rule.providerName, 'Relay');
    const config = rule.config as { group: string; access: { type: string; apiKey: string }; api: { type: string; baseUrl: string }; personalModelIds: string[] };
    assert.equal(config.group, 'standard-personal');
    assert.equal(config.access.type, 'api-key');
    assert.equal(config.access.apiKey, 'synthetic-relay-key');
    assert.equal(config.api.type, 'anthropic-messages');
    assert.equal(config.api.baseUrl, 'https://relay.example.test');
    assert.deepEqual(config.personalModelIds, ['glm-main']);
    assert.deepEqual(doc.config.defaultModelSelection, { providerId: 'relay', modelId: 'glm-main' });
    assert.equal(legacyProviderApiType('openai'), 'openai-responses');
    assert.equal(legacyProviderApiType('openai-compatible'), 'openai-chat-completions');
  });

  it('keeps TUI-only providers when merging', () => {
    const incoming = buildPersonalProviderConfig(cli);
    const existing = {
      schemaVersion: 1,
      config: {
        providerOrder: ['desktop-only'],
        providerConfigRules: { providerRules: [{ providerId: 'desktop-only', config: { group: 'standard-personal' } }] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        defaultModelSelection: { providerId: 'desktop-only', modelId: 'keep' },
      },
    };
    const merged = mergePersonalProviderConfig(existing, incoming);
    assert.deepEqual(merged.config.providerOrder, ['relay', 'desktop-only']);
    assert.equal(merged.config.providerConfigRules.providerRules.map((r) => r.providerId).join(','), 'relay,desktop-only');
    assert.deepEqual(merged.config.defaultModelSelection, { providerId: 'relay', modelId: 'glm-main' });
  });

  it('writes the v2 personal file from a CLI config and reports no secrets', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-zcode-personal-'));
    dirs.push(root);
    const configPath = path.join(root, 'cli', 'config.json');
    const personalPath = path.join(root, 'v2', 'provider_config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(cli));
    const state = await ensureZcodePersonalProviders(undefined, { configPath, personalPath });
    assert.equal(state?.written, true);
    assert.equal(state?.providerCount, 1);
    assert.equal(state?.hasDefault, true);
    assert.equal(JSON.stringify(state).includes('synthetic-relay-key'), false);
    const written = JSON.parse(fs.readFileSync(personalPath, 'utf8'));
    assert.equal(written.schemaVersion, 1);
    assert.equal(written.config.providerConfigRules.providerRules[0].providerId, 'relay');
    assert.equal(fs.statSync(personalPath).mode & 0o777, 0o600);
    const again = await ensureZcodePersonalProviders(undefined, { configPath, personalPath });
    assert.equal(again?.written, false);
    assert.equal(defaultPersonalProviderPath({ ZCODE_DATA_BASE_DIR: '/tmp/zcode-data' }),
      path.join('/tmp/zcode-data', '.zcode', 'v2', 'provider_config.json'));
  });

  it('SSH failure does not leak stderr or send keys in the command', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-zcode-personal-'));
    dirs.push(root);
    await assert.rejects(() => ensureZcodePersonalProviders({ sshTarget: 'synthetic-host' }, {
      configPath: path.join(root, 'missing.json'),
      personalPath: path.join(root, 'personal.json'),
      ssh: async (_host, command, opts) => {
        assert.equal(command.includes('synthetic-relay-key'), false);
        assert.equal(String(opts?.input).includes('synthetic-relay-key'), false);
        return { code: 255, timedOut: false, stdout: '', stderr: 'SYNTHETIC_PRIVATE_STDERR' };
      },
    }), /personal provider config could not be updated/);
  });

  it('remote transaction reads the host file, not a downloaded secret payload', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-zcode-personal-'));
    dirs.push(root);
    const configPath = path.join(root, 'config.json');
    const personalPath = path.join(root, 'provider_config.json');
    fs.writeFileSync(configPath, JSON.stringify(cli));
    const state = await ensureZcodePersonalProviders({ sshTarget: 'synthetic-host' }, {
      configPath,
      personalPath,
      ssh: async (_host, command, opts) => new Promise((resolve, reject) => {
        const child = execFile('/bin/bash', ['-c', command], { timeout: 5000 }, (error, stdout, stderr) => {
          if (error) reject(error); else resolve({ code: 0, stdout, stderr, timedOut: false });
        });
        child.stdin?.end(opts?.input);
      }),
    });
    assert.equal(state?.written, true);
    assert.equal(state?.providerCount, 1);
    assert.equal(JSON.stringify(state).includes('synthetic-relay-key'), false);
    assert.equal(JSON.parse(fs.readFileSync(personalPath, 'utf8')).config.providerConfigRules.providerRules[0].config.access.apiKey, 'synthetic-relay-key');
  });
});
