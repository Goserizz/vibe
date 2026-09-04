import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 测试环境预置 —— 由 `node --import` 在所有测试模块加载之前执行。
 *
 * 必须早于任何服务端模块的 import：`config.ts` 与 `sessionStore` 都是模块加载
 * 时就读盘的单例，等测试文件体再设 env 就太晚了（会读到真实的 ~/.vibe）。
 *
 * 效果：所有测试都跑在一棵一次性目录里，绝不触碰真实的 ~/.vibe、~/.claude、
 * ~/.codex、~/.kiro、~/.grok、~/.kimi-code。
 */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-switch-tests-'));

export const VIBE_HOME = path.join(ROOT, 'vibe');
export const VIBE_SWITCH_ROOT = path.join(ROOT, 'switch');
export const VIBE_TOKEN = 'vibe-switch-test-token';

process.env.VIBE_HOME = VIBE_HOME;
process.env.VIBE_SWITCH_ROOT = VIBE_SWITCH_ROOT;
process.env.VIBE_TOKEN = VIBE_TOKEN;
process.env.VIBE_LOCAL_NAME = 'vibe-test-host';
process.env.VIBE_DEFAULT_MODEL = 'opus';

fs.mkdirSync(VIBE_HOME, { recursive: true });
fs.mkdirSync(VIBE_SWITCH_ROOT, { recursive: true });

// 进程退出时清理（测试里创建的临时目录本来就在系统 tmp 下，这里再兜一层）。
process.on('exit', () => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // 清理失败无所谓 —— 在 tmp 下的目录会被系统回收。
  }
});
