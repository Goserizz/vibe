import path from 'node:path';
import { config } from '../config.js';
import type { AgentKind } from '../../../shared/protocol.js';

/**
 * 切换所需的全部磁盘路径。
 *
 * 之所以不直接 import `config`：config 是模块级单例，启动时就把 `VIBE_HOME`
 * 之类的环境变量固化了，测试无法重定向。这里把路径显式参数化，生产用
 * `defaultSwitchPaths()`（读 config），测试用 `tempSwitchPaths(root)`。
 */
export interface SwitchPaths {
  /** Vibe 数据根目录（~/.vibe）。 */
  vibeHome: string;
  /** sessions.json 的路径。 */
  sessionsFile: string;
  /** Claude 原生会话目录（~/.claude/projects）。 */
  claudeProjectsDir: string;
  /** CodeBuddy 原生会话目录（~/.codebuddy/projects）。 */
  codebuddyProjectsDir: string;
  /** Codex 原生 rollout 目录（~/.codex/sessions）。 */
  codexSessionsDir: string;
  /** Kiro 原生会话目录（~/.kiro/sessions/cli）。 */
  kiroSessionsDir: string;
  /** Grok 原生会话根目录（~/.grok/sessions）。 */
  grokSessionsDir: string;
  /** Kimi Code 数据根目录（~/.kimi-code）。 */
  kimiHome: string;
  /** ZCode 数据根目录（~/.zcode）。 */
  zcodeHome: string;
  /** Cursor 原生会话根目录（~/.cursor/chats）。 */
  cursorChatsDir: string;
  /** Cursor ACP resume 会话根目录（~/.cursor/acp-sessions）。 */
  cursorAcpSessionsDir: string;
  /** Devin 数据根目录（~/.local/share/devin —— XDG data dir，不是 dotfolder）。 */
  devinHome: string;
  /** opencode 数据根目录（~/.local/share/opencode —— XDG data dir）。 */
  opencodeHome: string;
}

/** Optional native-home overrides understood by the corresponding remote CLIs. */
export interface SwitchHomeOverrides {
  kimiHome?: string;
  grokHome?: string;
  zcodeHome?: string;
}

/** 某个 agent 的 Vibe 归一化 transcript 目录（~/.vibe/<agent>-transcripts）。 */
export function transcriptsDirFor(paths: SwitchPaths, agent: AgentKind): string {
  return `${paths.vibeHome.replace(/\/+$/, '')}/${agent}-transcripts`;
}

/** 某个 agent 会话的归一化 transcript 文件。sessionId 会做 URI 编码（远端 id 含 `::`）。 */
export function transcriptFileFor(paths: SwitchPaths, agent: AgentKind, sessionId: string): string {
  return `${transcriptsDirFor(paths, agent)}/${encodeURIComponent(sessionId)}.jsonl`;
}

/**
 * 生产环境路径：全部来自 config。
 *
 * 设置了 `VIBE_SWITCH_ROOT` 时改为返回一份完全独立的临时布局 —— 这是给测试和
 * 演练用的注入点，保证集成测试能在一次性目录里跑完整个切换流程，绝不碰真实的
 * ~/.claude、~/.codex、~/.vibe 等生产数据。（与 config.ts 里 VIBE_HOME /
 * KIMI_CODE_HOME 那套 env 覆盖是同一个思路。）
 */
export function defaultSwitchPaths(): SwitchPaths {
  const root = process.env.VIBE_SWITCH_ROOT;
  if (root && root.trim()) return tempSwitchPaths(path.resolve(root.trim()));
  return {
    vibeHome: config.home,
    sessionsFile: config.sessionsFile,
    claudeProjectsDir: config.claudeProjectsDir,
    codebuddyProjectsDir: config.codebuddyProjectsDir,
    codexSessionsDir: config.codexSessionsDir,
    kiroSessionsDir: config.kiroSessionsDir,
    grokSessionsDir: config.grokSessionsDir,
    kimiHome: config.kimiHome,
    zcodeHome: config.zcodeHome,
    cursorChatsDir: config.cursorChatsDir,
    cursorAcpSessionsDir: config.cursorAcpSessionsDir,
    devinHome: config.devinHome,
    opencodeHome: config.opencodeHome,
  };
}

/**
 * Build the native agent layout for another POSIX user's HOME.
 *
 * Remote switches must not reuse `defaultSwitchPaths()`: those paths belong to
 * the machine running Vibe (often `/root`) and are passed verbatim to the SSH
 * filesystem. Resolve `$HOME` on the remote host and use this helper instead.
 */
export function switchPathsForHome(home: string, overrides: SwitchHomeOverrides = {}): SwitchPaths {
  const absolute = (value: string, label: string): string => {
    const trimmed = value.trim().replace(/\/+$/, '') || '/';
    if (!path.posix.isAbsolute(trimmed)) {
      throw new Error(`remote ${label} must be an absolute path: ${value}`);
    }
    return path.posix.normalize(trimmed);
  };
  const remoteHome = absolute(home, 'HOME');
  const vibeHome = path.posix.join(remoteHome, '.vibe');  const kimiHome = overrides.kimiHome
    ? absolute(overrides.kimiHome, 'KIMI_CODE_HOME')
    : path.posix.join(remoteHome, '.kimi-code');
  const grokHome = overrides.grokHome
    ? absolute(overrides.grokHome, 'GROK_HOME')
    : path.posix.join(remoteHome, '.grok');
  const zcodeHome = overrides.zcodeHome
    ? absolute(overrides.zcodeHome, 'ZCODE_HOME')
    : path.posix.join(remoteHome, '.zcode');

  return {
    vibeHome,
    sessionsFile: path.posix.join(vibeHome, 'sessions.json'),
    claudeProjectsDir: path.posix.join(remoteHome, '.claude', 'projects'),
    codebuddyProjectsDir: path.posix.join(remoteHome, '.codebuddy', 'projects'),
    codexSessionsDir: path.posix.join(remoteHome, '.codex', 'sessions'),
    kiroSessionsDir: path.posix.join(remoteHome, '.kiro', 'sessions', 'cli'),
    grokSessionsDir: path.posix.join(grokHome, 'sessions'),
    kimiHome,
    zcodeHome,
    cursorChatsDir: path.posix.join(remoteHome, '.cursor', 'chats'),
    cursorAcpSessionsDir: path.posix.join(remoteHome, '.cursor', 'acp-sessions'),
    devinHome: path.posix.join(remoteHome, '.local', 'share', 'devin'),
    opencodeHome: path.posix.join(remoteHome, '.local', 'share', 'opencode'),
  };
}

/**
 * 测试用路径：全部关进一个临时目录，绝不接触真实数据。
 * `home` 模拟 $HOME（各 agent 的 ~/.xxx 都挂到它下面）。
 */
export function tempSwitchPaths(root: string): SwitchPaths {
  const home = path.join(root, 'home');
  const vibeHome = path.join(root, 'vibe');
  return {
    vibeHome,
    sessionsFile: path.join(vibeHome, 'sessions.json'),
    claudeProjectsDir: path.join(home, '.claude', 'projects'),
    codebuddyProjectsDir: path.join(home, '.codebuddy', 'projects'),
    codexSessionsDir: path.join(home, '.codex', 'sessions'),
    kiroSessionsDir: path.join(home, '.kiro', 'sessions', 'cli'),
    grokSessionsDir: path.join(home, '.grok', 'sessions'),
    kimiHome: path.join(home, '.kimi-code'),
    zcodeHome: path.join(home, '.zcode'),
    cursorChatsDir: path.join(home, '.cursor', 'chats'),
    cursorAcpSessionsDir: path.join(home, '.cursor', 'acp-sessions'),
    devinHome: path.join(home, '.local', 'share', 'devin'),
    opencodeHome: path.join(home, '.local', 'share', 'opencode'),
  };
}
