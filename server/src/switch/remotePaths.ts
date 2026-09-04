import { loginShellCommand, sshExec } from '../remote/ssh.js';
import { switchPathsForHome, type SwitchPaths } from './paths.js';

const PATHS_MARKER = '__VIBE_SWITCH_PATHS_V1__';

export type RemotePathRunner = (
  target: string,
  remoteCmd: string,
  opts: { timeoutMs: number },
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/**
 * Resolve the paths seen by an agent launched through the remote user's login
 * shell. Besides HOME, Kimi/Grok/ZCode support explicit native-home overrides;
 * querying all four values in one SSH round-trip keeps adapter paths aligned
 * with the CLI that will later resume the generated session.
 */
export async function resolveRemoteSwitchPaths(
  sshTarget: string,
  run: RemotePathRunner = sshExec,
): Promise<SwitchPaths> {
  const inner = [
    `printf '${PATHS_MARKER}\\n'`,
    `printf '%s\\n' "$HOME"`,
    `printf '%s\\n' "\${KIMI_CODE_HOME:-}"`,
    `printf '%s\\n' "\${GROK_HOME:-}"`,
    `printf '%s\\n' "\${ZCODE_HOME:-}"`,
  ].join('\n');
  const result = await run(sshTarget, loginShellCommand(inner), { timeoutMs: 15_000 });
  if (result.code !== 0) {
    throw new Error(
      `unable to resolve remote HOME: ${result.stderr.trim() || `ssh exited with code ${String(result.code)}`}`,
    );
  }

  // Login shells may print banners. Parse only the four lines following our
  // marker, preserving empty override lines instead of filtering them out.
  const lines = result.stdout.replace(/\r/g, '').split('\n');
  const markerAt = lines.lastIndexOf(PATHS_MARKER);
  if (markerAt < 0 || markerAt + 4 >= lines.length) {
    throw new Error('unable to resolve remote HOME: malformed probe response');
  }
  const [home = '', kimiHome = '', grokHome = '', zcodeHome = ''] = lines.slice(markerAt + 1, markerAt + 5);
  if (!home.trim()) throw new Error('unable to resolve remote HOME: empty HOME');

  return switchPathsForHome(home, {
    ...(kimiHome.trim() ? { kimiHome } : {}),
    ...(grokHome.trim() ? { grokHome } : {}),
    ...(zcodeHome.trim() ? { zcodeHome } : {}),
  });
}
