import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { applyCodexMcp, type CodexMcpApplyDeps, type RemoteTarget } from '../../src/mcp/apply.js';
import { oauthStore } from '../../src/mcp/oauth.js';
import type { McpServerDef } from '../../../shared/protocol.js';

function monitor(token: string): McpServerDef {
  return {
    name: 'vibe-monitor', transport: 'http', url: 'https://monitor.example.test/mcp',
    headers: { Authorization: `Bearer ${token}`, 'X-Test-Header': 'synthetic value' },
  };
}

/** All file/SSH IO is virtual; even a failing test cannot edit ~/.codex. */
function files(initial = '') {
  let text = initial;
  const writes: { file: string; content: string; remote?: RemoteTarget }[] = [];
  const deps: CodexMcpApplyDeps = {
    readFile: async (file) => {
      assert.equal(file, '~/.codex/config.toml');
      return text;
    },
    writeFile: async (file, content, remote) => {
      writes.push({ file, content, remote });
      text = content;
    },
  };
  return { deps, writes, text: () => text };
}

describe('Codex MCP HTTP 认证配置', () => {
  for (const where of ['local', 'remote']) {
    it(`${where}：写入 Codex 识别的 http_headers，而不是被忽略的 headers`, async () => {
      const io = files();
      const token = `synthetic-${crypto.randomUUID()}`;
      const remote = where === 'remote' ? { sshTarget: `test-${crypto.randomUUID()}` } : undefined;
      await applyCodexMcp([monitor(token)], remote, io.deps);
      assert.equal(io.writes.length, 1);
      assert.equal(io.writes[0]!.file, '~/.codex/config.toml');
      assert.deepEqual(io.writes[0]!.remote, remote);
      assert.ok(io.text().includes(`http_headers."Authorization" = "Bearer ${token}"`));
      assert.ok(io.text().includes('http_headers."X-Test-Header" = "synthetic value"'));
      assert.doesNotMatch(io.text(), /^headers\./m);
    });
  }

  it('替换旧错误 managed block，但保留用户模型、手工 MCP 和其他配置', async () => {
    const before = 'model = "test-model"\n\n[mcp_servers.manual]\ncommand = "manual-test-command"\n';
    const after = '[features]\ntest_feature = true\n';
    const io = files(`${before}\n# >>> vibe mcp >>>\n[mcp_servers."vibe-monitor"]\nurl = "https://old.example.test/mcp"\nheaders."Authorization" = "Bearer old-synthetic"\n# <<< vibe mcp <<<\n\n${after}`);
    await applyCodexMcp([monitor('replacement-synthetic')], { sshTarget: `test-${crypto.randomUUID()}` }, io.deps);
    assert.ok(io.text().includes(before.trimEnd()));
    assert.ok(io.text().includes(after.trimEnd()));
    assert.equal(io.text().split('# >>> vibe mcp >>>').length - 1, 1);
    assert.ok(io.text().includes('http_headers."Authorization" = "Bearer replacement-synthetic"'));
    assert.doesNotMatch(io.text(), /old-synthetic|old\.example\.test|^headers\./m);
  });

  it('凭证轮换会刷新认证头；相同配置不重复写入', async () => {
    const io = files();
    const remote = { sshTarget: `test-${crypto.randomUUID()}` };
    await applyCodexMcp([monitor('synthetic-first')], remote, io.deps);
    await applyCodexMcp([monitor('synthetic-first')], remote, io.deps);
    assert.equal(io.writes.length, 1);
    await applyCodexMcp([monitor('synthetic-next-turn')], remote, io.deps);
    assert.equal(io.writes.length, 2);
    assert.ok(io.text().includes('http_headers."Authorization" = "Bearer synthetic-next-turn"'));
    assert.doesNotMatch(io.text(), /synthetic-first/);
  });

  it('OAuth 也使用 http_headers，且不改变 stdio 或无认证 HTTP 配置', async (t) => {
    t.mock.method(oauthStore, 'ensureFresh', async () => undefined);
    t.mock.method(oauthStore, 'bearerFor', () => 'synthetic-oauth');
    const io = files();
    await applyCodexMcp([
      { name: 'oauth-test', transport: 'http', url: 'https://oauth.example.test/mcp', auth: 'oauth' },
      { name: 'stdio-test', transport: 'stdio', command: 'node', args: ['test.js'], env: { TEST_VALUE: 'test' } },
      { name: 'public-test', transport: 'http', url: 'https://public.example.test/mcp' },
    ], { sshTarget: `test-${crypto.randomUUID()}` }, io.deps);
    assert.ok(io.text().includes('http_headers."Authorization" = "Bearer synthetic-oauth"'));
    assert.match(io.text(), /\[mcp_servers\."stdio-test"\]\ncommand = "node"\nargs = \["test.js"\]\nenv = \{ "TEST_VALUE" = "test" \}/);
    assert.match(io.text(), /\[mcp_servers\."public-test"\]\nurl = "https:\/\/public.example.test\/mcp"\n\n# <<< vibe mcp <<</);
    assert.equal(io.text().match(/http_headers/g)?.length, 1);
  });
});
