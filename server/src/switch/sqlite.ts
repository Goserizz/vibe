import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { log } from '../log.js';
import { shQuote } from '../remote/ssh.js';
import { localFs, type SwitchFs } from './fs.js';

/**
 * SQLite 访问层。
 *
 * ZCode 与 Cursor 都把会话存在 SQLite 里。Vibe 跑在 Node 20 —— 没有内置的
 * `node:sqlite`（Node 22+ 才有），所以引入 `better-sqlite3`（有 Node 20 的
 * 预编译包）。
 *
 * **关键设计：加载失败必须优雅降级，不能让整个 Vibe 起不来。**
 * 原生模块在某些平台/环境下可能装不上（缺预编译包、glibc 太老等）。这时
  * zcode / cursor / devin / opencode 切换会自动退回 partial（历史作为首轮上下文注入），
 * 其余 6 个方向完全不受影响。能力探测结果缓存在模块级，只探测一次。
 */

export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  pragma(source: string): unknown;
  close(): void;
}

type DatabaseCtor = new (file: string, opts?: Record<string, unknown>) => SqliteDb;

let cached: { ctor: DatabaseCtor } | { ctor: null; reason: string } | undefined;
const requireFromHere = createRequire(import.meta.url);

/**
 * 尝试加载 better-sqlite3。
 *
 * 用 `createRequire` 而不是静态 import：原生模块加载失败会抛异常，静态 import
 * 会让它在模块加载阶段就炸掉整个服务。这里把它变成一次可捕获的运行时探测。
 */
export function sqliteAvailable(): boolean {
  return loadBetterSqlite3().ctor !== null;
}

/** 加载失败的原因（用于日志与 API 的降级说明）。 */
export function sqliteUnavailableReason(): string | undefined {
  const r = loadBetterSqlite3();
  return r.ctor === null ? r.reason : undefined;
}

function loadBetterSqlite3(): { ctor: DatabaseCtor } | { ctor: null; reason: string } {
  if (process.env.VIBE_SWITCH_DISABLE_SQLITE === '1') {
    return { ctor: null, reason: 'disabled by VIBE_SWITCH_DISABLE_SQLITE' };
  }
  if (cached) return cached;
  try {
    // 运行时 require，失败只影响本模块。不能用 `eval('require')`：本项目是 ESM，
    // ESM 作用域里并不存在全局 require。
    const mod = requireFromHere('better-sqlite3') as unknown;
    const ctor = (typeof mod === 'function' ? mod : (mod as { default?: unknown }).default) as
      | DatabaseCtor
      | undefined;
    if (typeof ctor !== 'function') throw new Error('better-sqlite3 did not export a constructor');
    cached = { ctor };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(`better-sqlite3 unavailable — zcode/cursor/devin/opencode switches will fall back to partial: ${reason}`);
    cached = { ctor: null, reason };
  }
  return cached;
}

/** 打开（必要时创建）一个 SQLite 库。better-sqlite3 不可用时返回 null。 */
export function openSqlite(file: string): SqliteDb | null {
  const { ctor } = loadBetterSqlite3();
  if (!ctor) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new ctor(file, { timeout: 15_000 });
  // 目标 agent 的 CLI 可能正开着同一个库，等锁而不是立刻报错。
  db.pragma('busy_timeout = 15000');
  return db;
}

/** Open an existing database without creating directories/files. This is used
 * by native transcript readers, which must remain best-effort when the addon
 * is unavailable. */
export function openSqliteReadonly(file: string): SqliteDb | null {
  const { ctor } = loadBetterSqlite3();
  if (!ctor || !fs.existsSync(file)) return null;
  const db = new ctor(file, { readonly: true, fileMustExist: true, timeout: 15_000 });
  db.pragma('busy_timeout = 15000');
  return db;
}

function sameBytes(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

export interface RemoteSqliteMergeOptions {
  /** 按外键依赖顺序列出要从入站库合并的表。 */
  tables: readonly string[];
  /** 入站库必须恰好含有这一行，防止上传/构建错了会话。 */
  identity: { table: string; column: string; value: string };
  /**
   * 用 `INSERT OR IGNORE` 而不是 `INSERT` 合并的表（`tables` 的子集）。
   * 给共享库里的幂等引用行用 —— 例如 opencode 的 `project.global`，
   * 远端已存在时跳过而不是让整个事务因主键冲突回滚。
   */
  ignoreTables?: readonly string[];
  /**
   * 会话 id：合并后，若该会话的 `model` 列仍为 NULL，就用主库里最近使用过
   * 的非空 model 回填（opencode 的 loader 不接受空 model，裸 CLI resume 会
   * 直接崩溃；Vibe 自己的 turn explicit 传参不受影响）。
   * 只有 opencode adapter 使用；主库里找不到可用 model 时保持 NULL。
   */
  backfillNullModelSessionId?: string;
}

export interface MutateSqliteOptions {
  /**
   * 共享 SQLite 库（ZCode / Devin / opencode）在远端必须通过 SQLite 事务合并，绝不整库下载后覆盖。
   * 本地目标仍直接打开原库。
   */
  remoteMerge?: RemoteSqliteMergeOptions;
}

function sqliteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`invalid SQLite identifier: ${value}`);
  }
  return value;
}

/**
 * 在本地新建一个只含入站数据的库，上传为远端 sidecar，再由远端
 * Python sqlite3 在 BEGIN IMMEDIATE 内 ATTACH + INSERT。这样：
 *  - ZCode 正在运行时使用的是 SQLite 自己的锁；
 *  - 不会替换打开中的 inode，不会丢掉并发写；
 *  - SSH 中断最多留下 sidecar，事务未提交就会回滚，绝不会留下半个主库。
 */
async function mergeRemoteSqliteFile(
  targetFs: SwitchFs,
  file: string,
  mutate: (db: SqliteDb) => void,
  options: RemoteSqliteMergeOptions,
  ctor: DatabaseCtor,
): Promise<boolean> {
  if (!targetFs.runCommand) {
    throw new Error(`remote SQLite transactional merge is unavailable: ${file}`);
  }

  const tables = options.tables.map(sqliteIdentifier);
  const ignoreTables = new Set((options.ignoreTables ?? []).map(sqliteIdentifier));
  const identityTable = sqliteIdentifier(options.identity.table);
  const identityColumn = sqliteIdentifier(options.identity.column);
  if (!tables.includes(identityTable)) {
    throw new Error(`remote SQLite identity table is not in merge set: ${identityTable}`);
  }
  for (const ignored of ignoreTables) {
    if (!tables.includes(ignored)) {
      throw new Error(`remote SQLite ignore table is not in merge set: ${ignored}`);
    }
  }

  const nonce = crypto.randomBytes(8).toString('hex');
  const localIncoming = path.join(os.tmpdir(), `vibe-switch-${nonce}.incoming.sqlite`);
  const remoteIncoming = `${file}.vibe-switch.${nonce}.incoming.sqlite`;
  let commandTimedOut = false;

  try {
    const db = new ctor(localIncoming, { timeout: 15_000 });
    try {
      db.pragma('busy_timeout = 15000');
      mutate(db);
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }

    await targetFs.writeBuffer(remoteIncoming, fs.readFileSync(localIncoming));

    const script = String.raw`
import json
import os
import sqlite3
import sys

target, incoming, tables_json, identity_table, identity_column, identity_value = sys.argv[1:7]
tables = json.loads(tables_json)
ignore_tables = set(json.loads(sys.argv[7]) if len(sys.argv) > 7 else [])
backfill_session = sys.argv[8] if len(sys.argv) > 8 else ''

def ident(value):
    if not value or not value.replace('_', 'a').isalnum() or value[0].isdigit():
        raise RuntimeError('invalid SQLite identifier: ' + repr(value))
    return '"' + value.replace('"', '""') + '"'

def check_database(conn, label):
    rows = conn.execute('PRAGMA quick_check').fetchall()
    if rows != [('ok',)]:
        raise RuntimeError(label + ' quick_check failed: ' + repr(rows[:10]))

try:
    source = sqlite3.connect('file:' + incoming + '?mode=ro', uri=True, timeout=60)
    try:
        check_database(source, 'incoming database')
        violations = source.execute('PRAGMA foreign_key_check').fetchmany(10)
        if violations:
            raise RuntimeError('incoming foreign_key_check failed: ' + repr(violations))
        count_sql = 'SELECT count(*) FROM ' + ident(identity_table) + ' WHERE ' + ident(identity_column) + '=?'
        if source.execute(count_sql, (identity_value,)).fetchone()[0] != 1:
            raise RuntimeError('incoming database does not contain exactly one expected identity row')
    finally:
        source.close()

    if not os.path.exists(target) or os.path.getsize(target) == 0:
        os.replace(incoming, target)
        print('VIBE_SQLITE_MERGE_OK:new')
        sys.exit(0)

    conn = sqlite3.connect(target, timeout=60)
    try:
        conn.execute('PRAGMA busy_timeout=60000')
        check_database(conn, 'target database before merge')
        conn.execute('PRAGMA foreign_keys=ON')
        conn.execute('ATTACH DATABASE ? AS incoming', (incoming,))

        merge_columns = {}
        for table in tables:
            table_q = ident(table)
            main_info = list(conn.execute('PRAGMA main.table_info(' + table_q + ')'))
            incoming_info = list(conn.execute('PRAGMA incoming.table_info(' + table_q + ')'))
            main_shape = [(row[1], row[2], row[3], row[4], row[5]) for row in main_info]
            incoming_shape = [(row[1], row[2], row[3], row[4], row[5]) for row in incoming_info]
            if not main_shape or main_shape != incoming_shape:
                raise RuntimeError('schema mismatch for table ' + table + ': ' + repr((main_shape, incoming_shape)))

            # INTEGER PRIMARY KEY is the rowid alias. Incoming sidecars start at
            # row_id=1, which would collide with existing shared-DB rows (Devin's
            # message_nodes). Omit that sole column so SQLite allocates a fresh
            # rowid; TEXT/composite primary keys such as ZCode ids stay intact.
            primary = [row for row in main_info if row[5] > 0]
            rowid_alias = primary[0][1] if len(primary) == 1 and primary[0][2].strip().upper() == 'INTEGER' else None
            merge_columns[table] = [row[1] for row in main_info if row[1] != rowid_alias]

        conn.execute('BEGIN IMMEDIATE')
        try:
            for table in tables:
                table_q = ident(table)
                columns = ','.join(ident(column) for column in merge_columns[table])
                verb = 'INSERT OR IGNORE' if table in ignore_tables else 'INSERT'
                conn.execute(
                    verb + ' INTO main.' + table_q + '(' + columns + ') '
                    'SELECT ' + columns + ' FROM incoming.' + table_q
                )
            if backfill_session:
                conn.execute(
                    'UPDATE main."session" SET "model" = ('
                    'SELECT "model" FROM main."session" WHERE "id" != ? '
                    'AND "model" IS NOT NULL AND trim("model") != \'\' '
                    'ORDER BY "time_updated" DESC LIMIT 1) '
                    'WHERE "id" = ? AND "model" IS NULL',
                    (backfill_session, backfill_session),
                )
            violations = conn.execute('PRAGMA foreign_key_check').fetchmany(10)
            if violations:
                raise RuntimeError('target foreign_key_check failed: ' + repr(violations))
            check_database(conn, 'target database after merge')
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            try:
                conn.execute('DETACH DATABASE incoming')
            except Exception:
                pass
        check_database(conn, 'target database after commit')
    finally:
        conn.close()

    print('VIBE_SQLITE_MERGE_OK:merged')
except Exception as exc:
    print('VIBE_SQLITE_MERGE_ERROR:' + str(exc), file=sys.stderr)
    sys.exit(2)
finally:
    if os.path.exists(incoming):
        try:
            os.unlink(incoming)
        except OSError:
            pass
`;

    const command = [
      'python3 -',
      shQuote(file),
      shQuote(remoteIncoming),
      shQuote(JSON.stringify(tables)),
      shQuote(identityTable),
      shQuote(identityColumn),
      shQuote(options.identity.value),
      shQuote(JSON.stringify([...ignoreTables])),
      shQuote(options.backfillNullModelSessionId ?? ''),
    ].join(' ');
    const result = await targetFs.runCommand(command, { timeoutMs: 120_000, input: script });
    commandTimedOut = result.timedOut === true;
    if (result.code !== 0 || !result.stdout.includes('VIBE_SQLITE_MERGE_OK:')) {
      const detail = result.timedOut
        ? 'SSH timed out while the remote SQLite transaction was running'
        : result.stderr.trim() || result.stdout.trim() || `exit ${String(result.code)}`;
      throw new Error(`remote SQLite transactional merge failed (${file}): ${detail}`);
    }
    return true;
  } finally {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(localIncoming + suffix, { force: true });
      } catch {
        /* ignore */
      }
    }
    // 超时时远端 Python 可能仍在收尾，不与它竞争 sidecar。
    // 其它失败（包括命令未启动）则做一次精确的最佳努力清理。
    if (!commandTimedOut) {
      await targetFs.removeFile(remoteIncoming).catch(() => undefined);
    }
  }
}

/**
 * 用 SwitchFs 修改 SQLite 文件。
 *
 * 本地直接打开目标库，让 SQLite 自己负责文件锁与 WAL；远端则把主库和 WAL 拉到
 * 本地临时目录，checkpoint 后原子写回。写回前会再读一次远端字节，若期间有 CLI
 * 并发写入就中止，避免用旧快照覆盖新消息。
 */
export async function mutateSqliteFile(
  targetFs: SwitchFs,
  file: string,
  mutate: (db: SqliteDb) => void,
  options: MutateSqliteOptions = {},
): Promise<boolean> {
  const loaded = loadBetterSqlite3();
  if (!loaded.ctor) return false;

  if (targetFs === localFs) {
    const db = openSqlite(file);
    if (!db) return false;
    try {
      mutate(db);
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    return true;
  }

  if (options.remoteMerge) {
    return mergeRemoteSqliteFile(targetFs, file, mutate, options.remoteMerge, loaded.ctor);
  }

  const beforeMain = await targetFs.readBuffer(file);
  const beforeWal = await targetFs.readBuffer(`${file}-wal`);
  const tmp = path.join(os.tmpdir(), `vibe-switch-${crypto.randomBytes(6).toString('hex')}.sqlite`);
  try {
    if (beforeMain?.length) fs.writeFileSync(tmp, beforeMain);
    if (beforeWal?.length) fs.writeFileSync(`${tmp}-wal`, beforeWal);

    const db = new loaded.ctor(tmp, { timeout: 15_000 });
    try {
      db.pragma('busy_timeout = 15000');
      mutate(db);
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }

    // 乐观并发保护：远端 CLI 在下载—写回窗口里动过主库或 WAL 就拒绝覆盖。
    const [currentMain, currentWal] = await Promise.all([
      targetFs.readBuffer(file),
      targetFs.readBuffer(`${file}-wal`),
    ]);
    if (!sameBytes(beforeMain, currentMain) || !sameBytes(beforeWal, currentWal)) {
      throw new Error(`remote SQLite changed while switching: ${file}`);
    }

    await targetFs.writeBuffer(file, fs.readFileSync(tmp));
    // checkpoint 已把 WAL 合并进主库；清掉旧 sidecar，防止远端重新应用旧页。
    await targetFs.removeFile(`${file}-wal`);
    await targetFs.removeFile(`${file}-shm`);
    return true;
  } finally {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(tmp + suffix, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

/** 跑 `pragma foreign_key_check`，返回违规行（空数组 = 干净）。 */
export function foreignKeyViolations(db: SqliteDb): unknown[] {
  const rows = db.pragma('foreign_key_check');
  return Array.isArray(rows) ? rows : [];
}
