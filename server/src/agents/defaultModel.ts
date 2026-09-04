import type { AgentKind } from '../../../shared/protocol.js';
import { config } from '../config.js';

/** The model to use when a caller lets the target agent choose for itself. */
export function defaultModelForAgent(agent: AgentKind): string {
  switch (agent) {
    case 'cursor':
      return config.defaultCursorModel;
    case 'codex':
      return config.defaultCodexModel;
    case 'kimi':
      return config.defaultKimiModel;
    case 'kiro':
      return config.defaultKiroModel;
    case 'grok':
      return config.defaultGrokModel;
    case 'zcode':
      return config.defaultZcodeModel;
    case 'codebuddy':
      return config.defaultCodebuddyModel;
    case 'opencode':
      return config.defaultOpencodeModel;
    case 'devin':
      return config.defaultDevinModel;
    case 'claude':
      return config.defaultModel;
  }
}
