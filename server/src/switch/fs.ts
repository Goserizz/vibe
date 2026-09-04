import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { shQuote } from '../remote/ssh.js';

/**
 * 可注入的文件系统抽象。
 *
 * 所有 adapter 只通过这个接口读写磁盘，因此：
 *  - 单测可以塞一个临时目录的 localFs，绝不碰 ~/.claude、~/.vibe 等生产数据；
 *  - 远端会话可以塞一个走 SSH 的实现，把「切换」动作原地下发到会话所在的主机
 *    （与项目既有的 `resolveFileTarget` + `sshExec` 转发模式一致）。
 *
 * 全部方法都是异步的，因为远端实现天然是异步的。
 */
export interface SwitchFs {
  /** 读整个文件；不存在返回 null（不抛异常）。 */
  readFile(filePath: string): Promise<string | null>;
  /** 读取二进制文件；SQLite 等不可经过 UTF-8 字符串往返。 */
  readBuffer(filePath: string): Promise<Buffer | null>;
  /** 写整个文件（自动创建父目录，覆盖式）。 */
  writeFile(filePath: string, content: string): Promise<void>;
  /** 原子写二进制文件（自动创建父目录）。 */
  writeBuffer(filePath: string, content: Buffer): Promise<void>;
  /** 追加内容（自动创建父目录）。 */
  appendFile(filePath: string, content: string): Promise<void>;
  /** 删除一个文件；不存在视为成功。只用于 SQLite 的 WAL/SHM 收尾。 */
  removeFile(filePath: string): Promise<void>;
  /** 递归创建目录。 */
  mkdirp(dir: string): Promise<void>;
  exists(target: string): Promise<boolean>;
  /** 列目录；不存在返回空数组。 */
  readdir(dir: string): Promise<{ name: string; isDirectory: boolean }[]>;
  /** 读文件头部若干字节（用于探测已存在会话的 cwd）。 */
  readHead(filePath: string, bytes: number): Promise<string>;
  /**
   * 只有 SSH 实现提供：在远端运行一次性命令。SQLite 共享库用它在
   * 远端进程内持有原生锁并合并数据，避免把正在使用的整库替换掉。
   */
  runCommand?(
    command: string,
    opts?: { timeoutMs?: number; input?: string | Buffer },
  ): Promise<SshCommandResult>;
}

/** POSIX 路径拼接（远端路径也在本机侧拼接，因此统一用 posix 分隔符）。 */
export function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/');
}

export function dirnameOf(filePath: string): string {
  const i = filePath.lastIndexOf('/');
  return i <= 0 ? '/' : filePath.slice(0, i);
}

// ---------------------------------------------------------------------------
// 本地实现
// ---------------------------------------------------------------------------

/** 基于 node:fs 的实现。生产环境用它。 */
export const localFs: SwitchFs = {
  async readFile(filePath) {
    try {
      return await fs.promises.readFile(filePath, 'utf8');
    } catch {
      return null;
    }
  },
  async readBuffer(filePath) {
    try {
      return await fs.promises.readFile(filePath);
    } catch {
      return null;
    }
  },
  async writeFile(filePath, content) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    // 原子写：同目录 temp + rename，避免切换过程中读到半截文件。
    const tmp = `${filePath}.vibe-switch.tmp`;
    await fs.promises.writeFile(tmp, content, 'utf8');
    await fs.promises.rename(tmp, filePath);
  },
  async writeBuffer(filePath, content) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.vibe-switch.tmp`;
    await fs.promises.writeFile(tmp, content);
    await fs.promises.rename(tmp, filePath);
  },
  async appendFile(filePath, content) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.appendFile(filePath, content, 'utf8');
  },
  async removeFile(filePath) {
    await fs.promises.rm(filePath, { force: true });
  },
  async mkdirp(dir) {
    await fs.promises.mkdir(dir, { recursive: true });
  },
  async exists(target) {
    try {
      await fs.promises.access(target);
      return true;
    } catch {
      return false;
    }
  },
  async readdir(dir) {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    } catch {
      return [];
    }
  },
  async readHead(filePath, bytes) {
    let fd: fs.promises.FileHandle | undefined;
    try {
      fd = await fs.promises.open(filePath, 'r');
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await fd.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } catch {
      return '';
    } finally {
      await fd?.close().catch(() => undefined);
    }
  },
};

// ---------------------------------------------------------------------------
// 远端（SSH）实现
// ---------------------------------------------------------------------------

/**
 * 远端命令执行器签名 —— 与 `remote/ssh.ts` 的 `sshExec` 兼容（它支持 `input`
 * 走 stdin），也方便单测注入一个假的 runner。
 */
export type SshRunner = (
  target: string,
  remoteCmd: string,
  opts?: { timeoutMs?: number; input?: string | Buffer },
) => Promise<SshCommandResult>;

export interface SshCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** sshExec 会填充；测试 runner 可省略。 */
  timedOut?: boolean;
}

/**
 * 走 SSH 的实现：把每个文件操作翻译成一条 shell 命令，在会话所在主机上执行。
 *
 * 这与项目里既有的远端文件路由是同一套思路（`http/api.ts` 的远端分支用
 * `cat` / `base64 -d >` / `ls -1Ap` 读写远端文件），区别只是这里把它收敛成
 * 一个通用接口，好让 adapter 不用关心自己跑在本地还是远端。
 */
export function createSshFs(sshTarget: string, run: SshRunner): SwitchFs {
  const q = shQuote;
  const missingExit = 44;

  const sh = async (
    cmd: string,
    input?: string | Buffer,
    timeoutMs = 60_000,
  ): Promise<SshCommandResult> =>
    // sshd hands a remote command to the user's login shell.  Do not assume
    // that shell is POSIX: fish treats `(a || b)` as command substitution and
    // used to make verified SQLite uploads fall back to primer mode.  Keep the
    // login shell's job to one portable argv invocation and parse every SwitchFs
    // command with /bin/sh instead.  stdin is inherited, so binary uploads and
    // `python3 -` transactional merge scripts continue to work unchanged.
    run(sshTarget, `sh -c ${q(cmd)}`, {
      timeoutMs,
      ...(input === undefined ? {} : { input }),
    });

  const readFailure = (action: string, filePath: string, res: SshCommandResult): Error => {
    const detail = res.timedOut
      ? 'SSH timed out'
      : res.stderr.trim() || res.stdout.trim() || `exit ${String(res.code)}`;
    return new Error(`remote ${action} failed (${filePath}): ${detail}`);
  };

  /**
   * stdin 上的 SSH 在超时/断线时，远端 cat 会把“提前 EOF”当成正常结束。
   * 如果紧接着 mv，半截文件就会被原子替换成正式文件。因此必须在 mv 前
   * 同时核对字节数和 SHA-256；任一不符都不会触碰目标。
   */
  const verifiedAtomicWrite = async (
    filePath: string,
    content: string | Buffer,
    label: string,
  ): Promise<void> => {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const expectedHash = crypto.createHash('sha256').update(bytes).digest('hex');
    const tmp = `${filePath}.vibe-switch.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const command =
      `mkdir -p ${q(dirnameOf(filePath))}`
      + ` && cat > ${q(tmp)}`
      + ` && test "$(wc -c < ${q(tmp)})" -eq ${bytes.length}`
      + ` && (sha256sum ${q(tmp)} 2>/dev/null || shasum -a 256 ${q(tmp)} 2>/dev/null)`
      + ` | awk '{print $1}' | grep -qx ${expectedHash}`
      + ` && mv ${q(tmp)} ${q(filePath)}`;
    const res = await sh(command, content);
    if (res.code !== 0) {
      const detail = res.timedOut
        ? 'SSH timed out before the verified commit; destination was left unchanged'
        : res.stderr.trim()
          || res.stdout.trim()
          || 'transfer verification failed; destination was left unchanged';
      throw new Error(`remote ${label} failed (${filePath}): ${detail}`);
    }
  };

  return {
    async readFile(filePath) {
      const res = await sh(`if test -e ${q(filePath)}; then cat ${q(filePath)}; else exit ${missingExit}; fi`);
      if (res.code === missingExit) return null;
      if (res.code !== 0) throw readFailure('read', filePath, res);
      return res.stdout;
    },
    async readBuffer(filePath) {
      // stdout 本身是字符串通道，二进制内容先在远端转 base64，避免 NUL/编码损坏。
      const res = await sh(`if test -e ${q(filePath)}; then base64 < ${q(filePath)}; else exit ${missingExit}; fi`);
      if (res.code === missingExit) return null;
      if (res.code !== 0) throw readFailure('binary read', filePath, res);
      return Buffer.from(res.stdout.replace(/\s+/g, ''), 'base64');
    },
    async writeFile(filePath, content) {
      await verifiedAtomicWrite(filePath, content, 'write');
    },
    async writeBuffer(filePath, content) {
      await verifiedAtomicWrite(filePath, content, 'binary write');
    },
    async appendFile(filePath, content) {
      const res = await sh(`mkdir -p ${q(dirnameOf(filePath))} && cat >> ${q(filePath)}`, content);
      if (res.code !== 0) {
        throw new Error(`remote append failed (${filePath}): ${res.stderr.trim() || res.stdout.trim()}`);
      }
    },
    async removeFile(filePath) {
      const res = await sh(`rm -f ${q(filePath)}`);
      if (res.code !== 0) {
        throw new Error(`remote remove failed (${filePath}): ${res.stderr.trim() || res.stdout.trim()}`);
      }
    },
    async mkdirp(dir) {
      const res = await sh(`mkdir -p ${q(dir)}`);
      if (res.code !== 0) {
        throw new Error(`remote mkdir failed (${dir}): ${res.stderr.trim() || res.stdout.trim()}`);
      }
    },
    async exists(target) {
      const res = await sh(`test -e ${q(target)} && echo yes`);
      return res.stdout.includes('yes');
    },
    async readdir(dir) {
      const res = await sh(`ls -1Ap ${q(dir)} 2>/dev/null`);
      if (res.code !== 0) return [];
      return res.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((name) => ({
          name: name.endsWith('/') ? name.slice(0, -1) : name,
          isDirectory: name.endsWith('/'),
        }));
    },
    async readHead(filePath, bytes) {
      const res = await sh(`head -c ${Number(bytes) || 0} ${q(filePath)} 2>/dev/null`);
      return res.stdout;
    },
    async runCommand(command, opts) {
      return sh(command, opts?.input, opts?.timeoutMs ?? 60_000);
    },
  };
}
