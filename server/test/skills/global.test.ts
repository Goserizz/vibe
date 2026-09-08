import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import express from 'express';
import { GlobalSkillStore } from '../../src/skills/globalStore.js';
import { GlobalSkillService, globalSkillTargets, globalSkillStore } from '../../src/skills/global.js';
import { createApiRouter } from '../../src/http/api.js';
import { createGlobalSkillTransport, type GlobalSkillTransport, type SkillTarget } from '../../src/skills/globalTransport.js';
import { createGlobalSkillRouter } from '../../src/skills/globalApi.js';
import { nativeSkillPath } from '../../src/skills/skills.js';
import { buildSkillFile, parseSkill } from '../../src/skills/frontmatter.js';
import { hostRegistry } from '../../src/remote/hosts.js';
import { requireAuth } from '../../src/auth.js';
import { accountManager } from '../../src/accounts.js';
import { config } from '../../src/config.js';
import type { GlobalSkillInput } from '../../../shared/protocol.js';
import { AGENTS } from '../switch/helpers.js';

const LOCAL: SkillTarget = { host: 'local', local: true, key: 'local' };
const REMOTE: SkillTarget = { host: 'synthetic-host', local: false, ssh: 'synthetic-target', key: 'remote-v1' };
const digest = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const input = (over: Partial<GlobalSkillInput> = {}): GlobalSkillInput => ({ name: 'global-test', description: 'Synthetic test skill',
  whenToUse: 'Only in tests.', body: '# Test\nNo external actions.\n', agents: [...AGENTS], ...over });

class MemoryTransport implements GlobalSkillTransport {
  files = new Map<string, string>();
  offline = new Set<string>();
  inspected: string[] = [];
  written: string[] = [];
  key(target: SkillTarget, file: string) { return `${target.key}/${file}`; }
  async inspect(target: SkillTarget, paths: string[]) {
    this.inspected.push(target.key);
    if (this.offline.has(target.key)) throw new Error('Synthetic offline host');
    return paths.map((file) => {
      const content = this.files.get(this.key(target, file)) ?? null;
      return { path: file, content, hash: content === null ? null : digest(content), status: 'ok' as const };
    });
  }
  async write(target: SkillTarget, files: { path: string; content: string; expectedHash: string | null }[]) {
    return files.map((file) => {
      const key = this.key(target, file.path);
      const old = this.files.get(key);
      if (old !== undefined && digest(old) !== file.expectedHash && old !== file.content) {
        return { path: file.path, status: 'conflict' as const };
      }
      this.files.set(key, file.content);
      this.written.push(key);
      return { path: file.path, status: 'synced' as const, hash: digest(file.content) };
    });
  }
}

describe('全 host 全局 skill 部署', () => {
  let root: string;
  let store: GlobalSkillStore;
  let transport: MemoryTransport;
  let targets: SkillTarget[];
  let now: number;
  let service: GlobalSkillService;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-global-skills-'));
    store = new GlobalSkillStore(path.join(root, 'registry.json'));
    transport = new MemoryTransport();
    targets = [LOCAL, REMOTE];
    now = 1_700_000_000_000;
    service = new GlobalSkillService(store, transport, () => targets, () => now);
  });
  afterEach(() => { service.stop(); fs.rmSync(root, { recursive: true, force: true }); });

  it('新建覆盖本机/远端 × 10 agents，采用各 agent 原生路径', async () => {
    const skill = store.create('admin', input());
    assert.equal(service.list('admin')[0]!.deployments.length, 20);
    await service.sync();
    assert.equal(transport.files.size, 20);
    assert.ok(service.list('admin')[0]!.deployments.every((d) => d.status === 'synced'));
    for (const target of targets) for (const agent of AGENTS) {
      const raw = transport.files.get(transport.key(target, nativeSkillPath(agent, skill.name)));
      assert.ok(raw);
      assert.equal(parseSkill(raw).body.trim(), skill.body.trim());
    }
  });

  it('集中定义/部署结果持久化为 0600；列表不暴露正文或内部哈希', async () => {
    const skill = store.create('admin', input({ body: 'SYNTHETIC_PRIVATE_BODY' }));
    await service.sync();
    const restarted = new GlobalSkillStore(path.join(root, 'registry.json'));
    assert.equal(restarted.get('admin', skill.id)?.body, 'SYNTHETIC_PRIVATE_BODY');
    assert.equal(fs.statSync(path.join(root, 'registry.json')).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(service.list('admin')), /SYNTHETIC_PRIVATE_BODY|managedHash|targetKey|owner/);
    assert.equal(service.detail('other', skill.id), undefined);
  });

  it('损坏的注册表不会被当作空文件覆盖，也不会在模块加载时崩溃', () => {
    const file = path.join(root, 'corrupt.json');
    fs.writeFileSync(file, '{broken');
    const broken = new GlobalSkillStore(file);
    assert.throws(() => broken.list(), /refusing to overwrite/);
    assert.throws(() => broken.create('admin', input()), /refusing to overwrite/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  });

  it('离线失败不阻塞其他 host，重启后自动重试并补齐新 host', async () => {
    store.create('admin', input());
    transport.offline.add(REMOTE.key);
    await service.sync();
    let rows = service.list('admin')[0]!.deployments;
    assert.equal(rows.filter((r) => r.status === 'synced').length, 10);
    assert.equal(rows.filter((r) => r.status === 'failed').length, 10);
    transport.offline.clear();
    now += 61_000;
    targets.push({ host: 'new-host', local: false, ssh: 'new-target', key: 'new' });
    const next = new GlobalSkillService(new GlobalSkillStore(path.join(root, 'registry.json')), transport, () => targets, () => now);
    await next.sync();
    rows = next.list('admin')[0]!.deployments;
    assert.equal(rows.length, 30);
    assert.ok(rows.every((r) => r.status === 'synced'));
    next.stop();
  });

  it('周期只复核到期目标，手动 retry 可立即重新探测', async () => {
    const skill = store.create('admin', input());
    await service.sync();
    const n = transport.inspected.length;
    await service.sync();
    assert.equal(transport.inspected.length, n);
    store.retry('admin', skill.id);
    await service.sync();
    assert.equal(transport.inspected.length, n + 2);
  });

  it('运行中的服务监听 host 新增，无需等下一分钟即可补发', async () => {
    const name = `global-new-${crypto.randomUUID().slice(0, 8)}`;
    targets = [LOCAL];
    store.create('admin', input({ agents: ['devin'] }));
    service.start();
    try {
      await service.sync();
      targets.push({ host: name, local: false, ssh: 'synthetic-added', key: 'added' });
      hostRegistry.add({ name, ssh: 'synthetic-added' }, 'admin');
      await service.sync();
      assert.equal(service.list('admin')[0]!.deployments.find((d) => d.host === name)?.status, 'synced');
    } finally { service.stop(); hostRegistry.remove(name, 'admin'); }
  });

  it('等价的已有 skill 可接管；更新保留未知 frontmatter', async () => {
    const skill = store.create('admin', input({ agents: ['devin'] }));
    const file = nativeSkillPath('devin', skill.name);
    const old = buildSkillFile(skill.name, skill.description, skill.whenToUse, skill.body).replace('---\n', '---\ncustom: preserved\n');
    transport.files.set(transport.key(LOCAL, file), old);
    await service.sync();
    assert.equal(transport.files.get(transport.key(LOCAL, file)), old, '接管相同内容不改写文件');
    store.update('admin', skill.id, input({ agents: ['devin'], body: '# New version\n' }));
    await service.sync();
    assert.match(transport.files.get(transport.key(LOCAL, file))!, /custom: preserved/);
    assert.match(transport.files.get(transport.key(LOCAL, file))!, /# New version/);
  });

  it('同名/手工修改产生冲突；替换授权只用于本版本首次部署', async () => {
    const skill = store.create('admin', input({ agents: ['devin'] }));
    const key = transport.key(LOCAL, nativeSkillPath('devin', skill.name));
    transport.files.set(key, 'User-owned content');
    await service.sync();
    assert.equal(service.list('admin')[0]!.deployments.find((d) => d.local)?.status, 'conflict');
    assert.equal(transport.files.get(key), 'User-owned content');
    store.update('admin', skill.id, input({ agents: ['devin'], replaceConflicts: true }));
    await service.sync();
    assert.notEqual(transport.files.get(key), 'User-owned content');
    transport.files.set(key, 'New manual edit');
    store.retry('admin', skill.id);
    await service.sync();
    assert.equal(transport.files.get(key), 'New manual edit');
    assert.equal(service.list('admin')[0]!.deployments.find((d) => d.local)?.status, 'conflict');
    store.update('admin', skill.id, input({ agents: ['devin'] }));
    assert.equal(store.get('admin', skill.id)?.replaceConflicts, false);
  });

  it('SSH 目标变更不会沿用旧目标的文件所有权', async () => {
    store.create('admin', input({ agents: ['devin'] }));
    await service.sync();
    targets = [{ ...REMOTE, ssh: 'replacement', key: 'remote-v2' }];
    const key = transport.key(targets[0]!, nativeSkillPath('devin', 'global-test'));
    transport.files.set(key, 'Independent remote skill');
    await service.sync();
    assert.equal(service.list('admin')[0]!.deployments[0]!.status, 'conflict');
    assert.equal(transport.files.get(key), 'Independent remote skill');
  });

  it('部署途中编辑版本：旧结果只保留文件哈希，不假报新版本成功', async () => {
    targets = [LOCAL];
    const skill = store.create('admin', input({ agents: ['devin'] }));
    let begin!: () => void;
    const begun = new Promise<void>((resolve) => { begin = resolve; });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const original = transport.write.bind(transport);
    transport.write = async (...args) => { begin(); await gate; return original(...args); };
    const pending = service.sync();
    await begun;
    store.update('admin', skill.id, input({ agents: ['devin'], body: 'Revision two' }));
    finish();
    await pending;
    assert.equal(service.list('admin')[0]!.deployments[0]!.status, 'pending');
    transport.write = original;
    await service.sync();
    assert.equal(service.list('admin')[0]!.deployments[0]!.status, 'synced');
    assert.match([...transport.files.values()][0]!, /Revision two/);
  });

  it('停止同步后保留已部署副本，不再给新增 host 分发', async () => {
    const skill = store.create('admin', input());
    await service.sync();
    const size = transport.files.size;
    store.remove('admin', skill.id);
    targets.push({ host: 'later', local: false, key: 'later' });
    await service.sync();
    assert.equal(transport.files.size, size);
    assert.deepEqual(service.list('admin'), []);
  });
});

describe('全局 skill 安全文件传输', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-global-files-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('真实文件写入采用 0600、原子替换、备份与并发哈希检查', async () => {
    const transport = createGlobalSkillTransport({ localHome: root });
    const file = '~/test skills/demo/SKILL.md';
    const actual = path.join(root, 'test skills/demo/SKILL.md');
    assert.equal((await transport.inspect(LOCAL, [file]))[0]!.content, null);
    assert.equal((await transport.write(LOCAL, [{ path: file, content: 'v1', expectedHash: null }]))[0]!.status, 'synced');
    assert.equal(fs.statSync(actual).mode & 0o777, 0o600);
    assert.equal((await transport.write(LOCAL, [{ path: file, content: 'v2', expectedHash: digest('v1') }]))[0]!.status, 'synced');
    const backups = fs.readdirSync(path.dirname(actual)).filter((p) => p.startsWith('.SKILL.md.vibe-backup-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(actual), backups[0]!), 'utf8'), 'v1');
    fs.writeFileSync(actual, 'concurrent edit');
    assert.equal((await transport.write(LOCAL, [{ path: file, content: 'v3', expectedHash: digest('v2') }]))[0]!.status, 'conflict');
    assert.equal(fs.readFileSync(actual, 'utf8'), 'concurrent edit');
  });

  it('拒绝符号链接和目录穿越，不修改原目标', async () => {
    const transport = createGlobalSkillTransport({ localHome: root });
    fs.mkdirSync(path.join(root, 'victim'));
    fs.writeFileSync(path.join(root, 'victim/SKILL.md'), 'untouched');
    fs.symlinkSync(path.join(root, 'victim'), path.join(root, 'link'));
    const result = await transport.write(LOCAL, [
      { path: '~/link/SKILL.md', content: 'bad', expectedHash: digest('untouched') },
      { path: '~/../escape/SKILL.md', content: 'bad', expectedHash: null },
    ]);
    assert.ok(result.every((r) => r.status === 'conflict'));
    assert.equal(fs.readFileSync(path.join(root, 'victim/SKILL.md'), 'utf8'), 'untouched');
  });

  it('远端生产脚本走 stdin，路径取远端 HOME，不把正文或本机路径放入命令', async () => {
    const sentinel = 'SYNTHETIC_PRIVATE_INSTRUCTIONS';
    const transport = createGlobalSkillTransport({ ssh: async (_host, command, opts) => {
      assert.equal(command.includes(sentinel), false);
      assert.equal(command.includes(root), false);
      const payload = JSON.parse(String(opts?.input));
      payload.testHome = root; // Test-only remote HOME, without changing process HOME.
      return await new Promise((resolve, reject) => {
        const child = execFile('/bin/bash', ['-c', command], { timeout: 5000 }, (error, stdout, stderr) => {
          if (error) reject(error); else resolve({ code: 0, stdout, stderr, timedOut: false });
        });
        child.stdin?.end(JSON.stringify(payload));
      });
    } });
    const file = nativeSkillPath('devin', 'private-test');
    const result = await transport.write(REMOTE, [{ path: file, content: sentinel, expectedHash: null }]);
    assert.equal(result[0]!.status, 'synced');
    assert.equal((await transport.inspect(REMOTE, [file]))[0]!.content, sentinel);
    assert.ok(fs.existsSync(path.join(root, file.slice(2))));
  });
});

describe('全局 skill 账号/API 边界', () => {
  it('删除账号清除全局定义；重建同名账号不能继承，删除 admin 不影响定义', async () => {
    const username = `skill-del-${crypto.randomUUID().slice(0, 8)}`;
    accountManager.create(username, 'synthetic-password');
    const privateSkill = globalSkillStore.create(username, input());
    const adminSkill = globalSkillStore.create('admin', input({ name: `protected-${crypto.randomUUID().slice(0, 8)}` }));
    const app = express(); app.use(express.json()); app.use('/api', createApiRouter());
    const server = http.createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as import('node:net').AddressInfo).port;
    const remove = (name: string) => fetch(`http://127.0.0.1:${port}/api/accounts/${name}`, { method: 'DELETE', headers: { Authorization: `Bearer ${config.token}` } });
    try {
      assert.equal((await remove(username)).status, 200);
      assert.equal(globalSkillStore.get(username, privateSkill.id), undefined);
      accountManager.create(username, 'synthetic-new-password');
      assert.deepEqual(globalSkillStore.list(username), []);
      assert.equal((await remove('admin')).status, 400);
      assert.ok(globalSkillStore.get('admin', adminSkill.id));
    } finally {
      globalSkillStore.remove('admin', adminSkill.id);
      globalSkillStore.removeOwnedBy(username);
      if (accountManager.list().some((a) => a.name === username)) accountManager.remove(username);
      server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('all hosts 仅限所属账号；普通账号不含本机，新增主机发出通知', () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const own = `skill-own-${suffix}`;
    const peer = `skill-peer-${suffix}`;
    let changes = 0;
    const off = hostRegistry.onChange(() => { changes++; });
    try {
      hostRegistry.add({ name: own, ssh: 'synthetic-own' }, 'skill-alice');
      hostRegistry.add({ name: peer, ssh: 'synthetic-peer' }, 'skill-bob');
      assert.equal(changes, 2);
      assert.deepEqual(globalSkillTargets('skill-alice').map((t) => t.host), [own]);
      assert.equal(globalSkillTargets('skill-alice').some((t) => t.local), false);
      assert.equal(globalSkillTargets('admin').some((t) => t.local), true);
      assert.equal(globalSkillTargets('admin').some((t) => t.host === own || t.host === peer), false);
    } finally {
      off(); hostRegistry.remove(own, 'skill-alice'); hostRegistry.remove(peer, 'skill-bob');
    }
  });

  it('API 鉴权、校验、正文隐私和跨账号操作隔离', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-global-api-'));
    const store = new GlobalSkillStore(path.join(root, 'registry.json'));
    const transport = new MemoryTransport();
    const service = new GlobalSkillService(store, transport, () => [REMOTE]);
    const username = `skill-${crypto.randomUUID().slice(0, 8)}`;
    const user = accountManager.create(username, 'synthetic-password');
    const app = express(); app.use(express.json()); app.use(requireAuth); app.use('/skills/global', createGlobalSkillRouter(service));
    const server = http.createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as import('node:net').AddressInfo).port;
    const request = (suffix = '', token = config.token, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${port}/skills/global${suffix}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    try {
      assert.equal((await request('', 'bad-token')).status, 401);
      assert.equal((await request('', config.token, 'POST', { ...input(), name: '../bad' })).status, 400);
      assert.equal((await request('', config.token, 'POST', { ...input(), owner: 'someone-else' })).status, 400);
      assert.equal((await request('', config.token, 'POST', { ...input(), agents: [] })).status, 400);
      const created = await request('', config.token, 'POST', input({ body: 'SYNTHETIC_PRIVATE_BODY' }));
      assert.equal(created.status, 201);
      const { skill } = await created.json() as { skill: { id: string; body?: string } };
      assert.equal(skill.body, undefined);
      await service.sync();
      const list = await (await request()).text();
      assert.equal(list.includes('SYNTHETIC_PRIVATE_BODY'), false);
      assert.equal((await request(`/${skill.id}`, user.token)).status, 404);
      assert.equal((await request(`/${skill.id}`, user.token, 'PUT', input())).status, 404);
      assert.equal((await request(`/${skill.id}/retry`, user.token, 'POST')).status, 404);
      assert.equal((await request(`/${skill.id}`, user.token, 'DELETE')).status, 404);
      assert.equal((await request('', config.token, 'POST', input())).status, 409);
      assert.equal((await request(`/${skill.id}/retry`, config.token, 'POST')).status, 202);
      await service.sync();
      const removed = await (await request(`/${skill.id}`, config.token, 'DELETE')).json() as { nativeCopiesRetained: boolean };
      assert.equal(removed.nativeCopiesRetained, true);
      assert.equal(transport.files.size, 10);
      assert.deepEqual(store.list(), []);
    } finally {
      service.stop(); accountManager.remove(username); server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
