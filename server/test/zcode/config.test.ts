import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { applyZcodeMcp } from '../../src/mcp/apply.js';
import { assertZcodeStartupConfig, reconcileZcodeMcp, type ZcodeConfigOptions, type ZcodeConfigState } from '../../src/zcode/configFile.js';
import { startZcodeRun } from '../../src/zcode/runner.js';
import { parseZcodeModels } from '../../src/zcode/models.js';
import { log } from '../../src/log.js';
import type { LiveEvent, McpServerDef } from '../../../shared/protocol.js';
import type { RunCallbacks } from '../../src/claude/types.js';
import { modelsForAgent } from '../../../web/src/lib/format.js';

const provider = { test: { kind: 'anthropic', options: { baseURL: 'https://provider.example.test', apiKey: 'synthetic-provider-key' }, models: { 'test-model': {} } } };
const model = { main: 'test/test-model', lite: 'test/test-model' };
const defs = (token = 'synthetic-monitor'): McpServerDef[] => [{ name: 'vibe-monitor', transport: 'http', url: 'https://monitor.example.test/mcp', headers: { Authorization: `Bearer ${token}` } }];

describe('ZCode 配置/MCP 安全合并', () => {
  let root: string;
  let file: string;
  let side: string;
  let options: ZcodeConfigOptions;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-zcode-config-'));
    file = path.join(root, 'config.json'); side = path.join(root, 'managed.json');
    options = { configPath: file, managedPath: side };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('保留 provider/model/用户 MCP，只替换有记录的 Vibe MCP', async () => {
    const before = { provider, model, plugins: { test: true }, network: { noProxy: 'example.test' },
      mcp: { customSetting: true, servers: { manual: { type: 'stdio', command: 'synthetic' }, oldVibe: { type: 'http', url: 'https://old.example.test' } } } };
    fs.writeFileSync(file, JSON.stringify(before)); fs.writeFileSync(side, JSON.stringify(['oldVibe']));
    const result = await applyZcodeMcp(defs(), undefined, options);
    assert.equal(result?.hasModel, true); assert.equal(result?.changed, true);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(after.provider, before.provider); assert.deepEqual(after.model, before.model);
    assert.deepEqual(after.plugins, before.plugins); assert.deepEqual(after.network, before.network);
    assert.equal(after.mcp.customSetting, true); assert.deepEqual(after.mcp.servers.manual, before.mcp.servers.manual);
    assert.equal(after.mcp.servers.oldVibe, undefined);
    assert.equal(after.mcp.servers['vibe-monitor'].headers.Authorization, 'Bearer synthetic-monitor');
    assert.deepEqual(JSON.parse(fs.readFileSync(side, 'utf8')), ['vibe-monitor']);
  });

  it('不存在的配置不创建 MCP-only 空壳或 sidecar', async () => {
    const state = await applyZcodeMcp(defs(), undefined, options);
    assert.equal(state?.exists, false); assert.equal(state?.hasModel, false);
    assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(side), false);
    assert.throws(() => assertZcodeStartupConfig(state), /模型未配置/);
  });

  it('空文件、损坏 JSON、非对象及非法 MCP 结构均保持原样', async () => {
    for (const raw of ['', '{broken', '[]', 'null', '{"mcp":[]}', '{"mcp":{"servers":[]}}']) {
      fs.writeFileSync(file, raw);
      await assert.rejects(reconcileZcodeMcp({}, undefined, options));
      assert.equal(fs.readFileSync(file, 'utf8'), raw);
      assert.equal(fs.existsSync(side), false);
    }
  });

  it('sidecar 读取失败不能继续覆盖 config；损坏的 tracking 内容不删除用户条目', async () => {
    const raw = JSON.stringify({ provider, model, mcp: { servers: { manual: { type: 'stdio', command: 'synthetic' } } } });
    fs.writeFileSync(file, raw); fs.mkdirSync(side);
    await assert.rejects(reconcileZcodeMcp({}, undefined, options));
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
    fs.rmdirSync(side); fs.writeFileSync(side, 'broken tracking');
    await reconcileZcodeMcp({}, undefined, options);
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).mcp.servers.manual);
  });

  it('SSH 失败不发送第二条覆盖命令，不泄漏 stderr 中的内容', async (t) => {
    const warning = t.mock.method(log, 'warn', () => undefined);
    let calls = 0;
    const result = await applyZcodeMcp(defs(), { sshTarget: 'synthetic-host' }, { ...options, ssh: async () => {
      calls++; return { code: 255, timedOut: false, stdout: '', stderr: 'SYNTHETIC_PRIVATE_STDERR' };
    } });
    assert.equal(result, undefined); assert.equal(calls, 1);
    assert.equal(fs.existsSync(file), false);
    assert.equal(JSON.stringify(warning.mock.calls).includes('SYNTHETIC_PRIVATE_STDERR'), false);
  });

  it('在远端读取最新模型配置，不把 provider 凭据下载或放进命令', async () => {
    fs.writeFileSync(file, JSON.stringify({ provider, model }));
    let calls = 0;
    const state = await applyZcodeMcp(defs('synthetic-remote-monitor'), { sshTarget: 'synthetic-host' }, {
      ...options, ssh: async (_host, command, opts) => {
        calls++;
        assert.equal(command.includes('synthetic-remote-monitor'), false);
        assert.equal(command.includes(root), false);
        assert.equal(String(opts?.input).includes('synthetic-provider-key'), false);
        // Simulates a host-specific provider edit just before the transaction.
        const latest = JSON.parse(fs.readFileSync(file, 'utf8'));
        latest.provider.test.options.apiKey = 'new-synthetic-provider-key';
        fs.writeFileSync(file, JSON.stringify(latest));
        return await new Promise((resolve, reject) => {
          const child = execFile('/bin/bash', ['-c', command], { timeout: 5000 }, (error, stdout, stderr) => {
            if (error) reject(error); else resolve({ code: 0, stdout, stderr, timedOut: false });
          });
          child.stdin?.end(opts?.input);
        });
      },
    });
    assert.equal(calls, 1); assert.equal(state?.hasModel, true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).provider.test.options.apiKey, 'new-synthetic-provider-key');
    assert.equal(JSON.stringify(state).includes('provider-key'), false);
  });

  it('相同 MCP 也重新检查模型，不让签名缓存掩盖配置变化', async () => {
    fs.writeFileSync(file, JSON.stringify({ provider, model }));
    assert.equal((await applyZcodeMcp(defs(), undefined, options))?.hasModel, true);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')); delete raw.model;
    fs.writeFileSync(file, JSON.stringify(raw));
    const state = await applyZcodeMcp(defs(), undefined, options);
    assert.equal(state?.hasModel, false); assert.equal(state?.changed, false);
    assert.throws(() => assertZcodeStartupConfig(state), /缺少 model/);
  });

  it('并发 MCP 更新保留模型，备份按模型配置去重，文件为 0600', async () => {
    const original = JSON.stringify({ provider, model }); fs.writeFileSync(file, original);
    await Promise.all([applyZcodeMcp(defs('first'), undefined, options), applyZcodeMcp(defs('second'), undefined, options)]);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(raw.provider, provider); assert.deepEqual(raw.model, model);
    assert.ok(['Bearer first','Bearer second'].includes(raw.mcp.servers['vibe-monitor'].headers.Authorization));
    const backups = fs.readdirSync(root).filter((name) => name.startsWith('config.json.vibe-backup-'));
    assert.equal(backups.length, 1); assert.equal(fs.readFileSync(path.join(root, backups[0]!), 'utf8'), original);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(side).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(root, backups[0]!)).mode & 0o777, 0o600);
  });

  it('不覆盖符号链接文件，也不修改其真实目标', async () => {
    const target = path.join(root, 'target'); fs.writeFileSync(target, JSON.stringify({ provider, model }));
    fs.symlinkSync(target, file);
    await assert.rejects(reconcileZcodeMcp({}, undefined, options));
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { provider, model });
  });

  it('项目配置的场景交给 ZCode 原生解析器，不能误判为未配置', async () => {
    const cwd = path.join(root, 'project'); fs.mkdirSync(path.join(cwd, '.zcode'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.zcode/config.json'), JSON.stringify({ provider, model }));
    const state = await applyZcodeMcp(defs(), undefined, { ...options, cwd });
    assert.equal(state?.hasOverrides, true);
    assert.doesNotThrow(() => assertZcodeStartupConfig(state));
    assert.equal(fs.existsSync(file), false);
  });

  it('模型列表只取实际 provider 声明，MCP-only 配置仅返回 Auto', () => {
    assert.deepEqual(parseZcodeModels('{"mcp":{"servers":{}}}'), [{ value: 'auto', label: 'Auto' }]);
    assert.deepEqual(parseZcodeModels(JSON.stringify({ provider, model })).map((m) => m.value), ['auto', 'test/test-model']);
  });

  it('前端未加载主机模型时也不凭空提供 GLM 候选', () => {
    assert.deepEqual(modelsForAgent('zcode'), [{ value: 'auto', label: 'Auto' }]);
  });
});

describe('ZCode 新会话配置预检', () => {
  const missing: ZcodeConfigState = { configPath: '/synthetic-user/.zcode/cli/config.json', exists: true, hasModel: false, hasOverrides: false, changed: false };
  function setup(state: ZcodeConfigState, resume?: string) {
    const events: LiveEvent[] = [];
    let clients = 0;
    const cb: RunCallbacks = { onEvent: (event) => events.push(event), onClaudeSessionId: () => undefined, requestPermission: async () => ({ allow: false }) };
    const handle = startZcodeRun({ prompt: 'Synthetic prompt', cwd: '/synthetic-project', model: 'test/test-model', permissionMode: 'default', resume }, cb, {
      prepareMcp: async () => state,
      createClient: () => { clients++; return { run: async () => ({}), abort: () => undefined, stopTask: async () => undefined, queueMessage: () => false }; },
    });
    return { handle, events, clients: () => clients };
  }
  it('未配置的新会话在启动 CLI 前报清晰错误并正常结束', async () => {
    const t = setup(missing); await t.handle.done;
    assert.equal(t.clients(), 0);
    assert.ok(t.events.some((e) => e.k === 'error' && e.text.includes('模型未配置')));
    assert.ok(t.events.some((e) => e.k === 'block' && e.block.kind === 'result' && e.block.isError));
  });
  it('有效模型、项目覆盖及既有会话的 runtime-model 兼容路径不被阻断', async () => {
    for (const [state, resume] of [[{ ...missing, hasModel: true }, undefined], [{ ...missing, hasOverrides: true }, undefined], [missing, 'sess-existing']] as const) {
      const t = setup(state, resume); await t.handle.done;
      assert.equal(t.clients(), 1); assert.equal(t.events.some((e) => e.k === 'error'), false);
    }
  });

  it('预检过程中停止，不再启动 CLI 或追加错误', async () => {
    const events: LiveEvent[] = [];
    let release!: (state: ZcodeConfigState) => void;
    const cb: RunCallbacks = { onEvent: (event) => events.push(event), onClaudeSessionId: () => undefined, requestPermission: async () => ({ allow: false }) };
    const handle = startZcodeRun({ prompt: 'Synthetic', cwd: '/synthetic', model: 'auto', permissionMode: 'default' }, cb, {
      prepareMcp: () => new Promise((resolve) => { release = resolve; }),
      createClient: () => { throw new Error('CLI must not start after abort'); },
    });
    handle.abort(); release(missing); await handle.done;
    assert.deepEqual(events, []);
  });
});
