/**
 * 重新生成 `server/src/switch/adapters/zcodeSchema.ts`。
 *
 * zcode 把会话存在 SQLite（`~/.zcode/cli/db/db.sqlite`）里，而我们要能在任意
 * 目录（临时目录、远端主机）从零建出一个 zcode 认得的库，所以把真实库的完整
 * DDL 与迁移账本原样导出内嵌。
 *
 * 用法（需要本机装过 zcode 且产生过库）：
 *   npx tsx scripts/gen-zcode-schema.ts [path/to/db.sqlite]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const dbPath = process.argv[2] || path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');

/** 用 sqlite3 CLI 或 node:sqlite 都不可靠（Node 20 无内置），所以走 python3。 */
function dump(): { tables: [string, string][]; indexes: [string, string][]; triggers: [string, string][]; migrations: string[][] } {
  const py = `
import sqlite3, json, sys
from pathlib import Path
c = sqlite3.connect(Path(sys.argv[1]).resolve().as_uri() + '?mode=ro', uri=True)
rows = c.execute("select type,name,sql from sqlite_master").fetchall()
out = {
  "tables":   [[n, s] for t, n, s in rows if t == 'table' and not n.startswith('sqlite_')],
  "indexes":  [[n, s] for t, n, s in rows if t == 'index' and not n.startswith('sqlite_autoindex')],
  "triggers": [[n, s] for t, n, s in rows if t == 'trigger'],
  "migrations": [[i, ck, av, ta] for i, ck, av, ta in
      c.execute("select id,checksum,app_version,time_applied from schema_migration order by time_applied,id")],
}
print(json.dumps(out))
`;
  const raw = execFileSync('python3', ['-c', py, dbPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(raw);
}

const { tables, indexes, triggers, migrations } = dump();
const q = (v: string): string => JSON.stringify(v);

const parts: string[] = [];
parts.push(`// 本文件由 scripts/gen-zcode-schema.ts 从真实 ~/.zcode/cli/db/db.sqlite 导出，请勿手改。
// 用途：zcode adapter 需要在临时目录或远端主机上**从零建库**再 INSERT，
// 因此把 zcode 自己建库时的完整 DDL（${tables.length} 张表 + ${indexes.length} 个索引
// + ${triggers.length} 个触发器）与 schema_migration 账本原样内嵌 ——
// 缺一张表会让 zcode 查询时报 "no such table"，缺迁移记录会让它以为需要重新迁移。
export const ZCODE_SCHEMA_SQL: string[] = [
`);
for (const [name, sql] of tables) parts.push(`  // ---- table ${name}\n  ${q(sql)},\n`);
for (const [name, sql] of indexes) parts.push(`  // ---- index ${name}\n  ${q(sql)},\n`);
for (const [name, sql] of triggers) parts.push(`  // ---- trigger ${name}\n  ${q(sql)},\n`);
parts.push(`];

/** zcode 的迁移账本：建库后原样写入，让 zcode 认为所有迁移都已应用。 */
export interface ZcodeMigrationRow {
  id: string;
  checksum: string;
  app_version: string;
  time_applied: number;
}

export const ZCODE_MIGRATIONS: ZcodeMigrationRow[] = [
`);
for (const [id, checksum, appVersion, timeApplied] of migrations) {
  parts.push(`  { id: ${q(id)}, checksum: ${q(checksum)}, app_version: ${q(appVersion)}, time_applied: ${timeApplied} },\n`);
}
parts.push('];\n');

const outFile = path.resolve(import.meta.dirname, '../server/src/switch/adapters/zcodeSchema.ts');
fs.writeFileSync(outFile, parts.join(''));
console.log(`wrote ${outFile} (${tables.length} tables, ${indexes.length} indexes, ${triggers.length} triggers, ${migrations.length} migrations)`);
