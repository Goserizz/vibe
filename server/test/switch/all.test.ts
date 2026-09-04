/**
 * 单进程测试入口。
 *
 * `node --test file-a file-b` 默认把每个文件放进子进程，TAP 汇总只显示 5 个文件，
 * 会隐藏内部两百余条断言的 pass/skip 计数。这里统一 import，让最终报告保留每条
 * 用例，同时避开受限环境中 tsx CLI 为 IPC socket 调用 listen 的问题。
 */
import './adapters.test.js';
import './thinking-repair.test.js';
import './double-roundtrip.test.js';
import './matrix.test.js';
import './structure.test.js';
import './remote.test.js';
import './endpoint.test.js';
import '../claude/usage.test.js';
import '../codebuddy/normalize.test.js';
import '../codebuddy/runner.test.js';
import '../cursor/normalize.test.js';
import '../codex/normalize.test.js';
import '../opencode/models.test.js';
import '../zcode/transcript.test.js';
import '../sessions/list.test.js';
import '../telegram/tools.test.js';
import '../shared/blocks.test.js';
import '../monitoring/monitor.test.js';
