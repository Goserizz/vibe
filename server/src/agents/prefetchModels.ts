import { log } from '../log.js';
import { hostRegistry } from '../remote/hosts.js';
import { prefetchCodexModels } from '../codex/models.js';
import { prefetchCursorModels } from '../cursor/models.js';
import { prefetchKimiCapabilities } from '../kimi/capabilities.js';
import { prefetchKiroModels } from '../kiro/models.js';
import { prefetchGrokModels } from '../grok/models.js';
import { prefetchZcodeModels } from '../zcode/models.js';
import { prefetchCodebuddyModels } from '../codebuddy/models.js';
import { prefetchOpencodeModels } from '../opencode/models.js';
import { prefetchDevinModels } from '../devin/models.js';

/** Warm every agent model/capabilities cache in the background so HTTP handlers
 *  never wait on CLI spawns or SSH. Safe to call repeatedly (SWR dedupes). */
export function prefetchAgentModels(hostNames?: string[]): void {
  const hosts = hostNames ?? hostRegistry.list().map((h) => h.name);
  try {
    prefetchCursorModels(hosts);
    prefetchCodexModels(hosts);
    prefetchKimiCapabilities(hosts);
    prefetchKiroModels(hosts);
    prefetchGrokModels(hosts);
    prefetchZcodeModels(hosts);
    prefetchCodebuddyModels(hosts);
    prefetchOpencodeModels(hosts);
    prefetchDevinModels(hosts);
  } catch (err) {
    log.debug('agent model prefetch failed', err);
  }
}
