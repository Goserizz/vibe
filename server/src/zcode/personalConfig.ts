import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { sshExec, loginShellCommand, shQuote } from '../remote/ssh.js';
import type { ZcodeCliConfig } from './models.js';

export interface ZcodePersonalConfigState {
  personalPath: string;
  exists: boolean;
  written: boolean;
  providerCount: number;
  hasDefault: boolean;
}

export interface ZcodePersonalConfigOptions {
  configPath?: string;
  personalPath?: string;
  ssh?: typeof sshExec;
}

/** CLI kinds → ZCode 3.12 personal `api.type` values. */
export function legacyProviderApiType(kind: string | undefined): string {
  switch (kind) {
    case 'anthropic':
      return 'anthropic-messages';
    case 'openai':
      return 'openai-responses';
    default:
      return 'openai-chat-completions';
  }
}

function splitMain(value: string | undefined): { providerId: string; modelId: string } | null {
  const trimmed = (value || '').trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash >= trimmed.length - 1) return null;
  const providerId = trimmed.slice(0, slash).trim();
  const modelId = trimmed.slice(slash + 1).trim();
  if (!providerId || !modelId || providerId === 'builtin:zapi') return null;
  return { providerId, modelId };
}

/**
 * Project the legacy ~/.zcode/cli/config.json provider map into the v2
 * personal `provider_config.json` document that app-server actually loads.
 * app-server does not run the standalone legacy importer.
 */
export function buildPersonalProviderConfig(cli: ZcodeCliConfig): {
  schemaVersion: 1;
  config: {
    providerOrder: string[];
    providerConfigRules: { providerRules: Array<Record<string, unknown>> };
    modelConfigRules: { providerModelRules: unknown[]; manualProviderModelRules: unknown[] };
    defaultModelSelection?: { providerId: string; modelId: string };
  };
} {
  const rules: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  for (const [rawId, provider] of Object.entries(cli.provider ?? {})) {
    const providerId = rawId.trim();
    if (!providerId) continue;
    if (providerId.startsWith('builtin:') || providerId.startsWith('account:')) continue;
    if (provider?.options?.apiKeyRequired === false) continue;
    const apiKey = provider?.options?.apiKey?.trim();
    if (!apiKey) continue;
    const modelIds = Object.entries(provider?.models ?? {})
      .filter(([, def]) => (def as { deleted?: boolean } | undefined)?.deleted !== true)
      .map(([id, def]) => String((def as { id?: string } | undefined)?.id ?? id).trim())
      .filter(Boolean);
    const unique = [...new Set(modelIds)];
    const name = provider?.name?.trim();
    const api: Record<string, unknown> = { type: legacyProviderApiType(provider?.kind) };
    const baseUrl = provider?.options?.baseURL?.trim();
    if (baseUrl) api.baseUrl = baseUrl;
    rules.push({
      providerId,
      ...(name && name !== providerId ? { providerName: name } : {}),
      config: {
        group: 'standard-personal',
        access: { type: 'api-key', apiKey },
        api,
        ...(unique.length ? { personalModelIds: unique, modelOrder: unique } : {}),
      },
    });
    order.push(providerId);
  }
  const defaultModelSelection = splitMain(cli.model?.main) ?? undefined;
  return {
    schemaVersion: 1,
    config: {
      providerOrder: order,
      providerConfigRules: { providerRules: rules },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      ...(defaultModelSelection ? { defaultModelSelection } : {}),
    },
  };
}

/** Merge CLI-derived personal providers into an existing v2 file without
 *  dropping providers the desktop/TUI added. CLI ids win on conflict. */
export function mergePersonalProviderConfig(
  existing: unknown,
  incoming: ReturnType<typeof buildPersonalProviderConfig>,
): ReturnType<typeof buildPersonalProviderConfig> {
  if (!existing || typeof existing !== 'object') return incoming;
  const root = existing as { schemaVersion?: unknown; config?: Record<string, unknown> };
  const cfg = root.config && typeof root.config === 'object' ? root.config : {};
  const currentRules = Array.isArray((cfg.providerConfigRules as { providerRules?: unknown } | undefined)?.providerRules)
    ? ([...(cfg.providerConfigRules as { providerRules: unknown[] }).providerRules] as Array<Record<string, unknown>>)
    : [];
  const incomingIds = new Set(incoming.config.providerConfigRules.providerRules.map((r) => r.providerId));
  const extras = currentRules.filter((r) => typeof r?.providerId === 'string' && !incomingIds.has(r.providerId));
  const extraOrder = extras.map((r) => String(r.providerId));
  const currentDefault = cfg.defaultModelSelection;
  const defaultModelSelection = incoming.config.defaultModelSelection
    ?? (currentDefault && typeof currentDefault === 'object'
      && typeof (currentDefault as { providerId?: unknown }).providerId === 'string'
      && typeof (currentDefault as { modelId?: unknown }).modelId === 'string'
      ? { providerId: (currentDefault as { providerId: string }).providerId, modelId: (currentDefault as { modelId: string }).modelId }
      : undefined);
  return {
    schemaVersion: 1,
    config: {
      providerOrder: [...incoming.config.providerOrder, ...extraOrder.filter((id) => !incoming.config.providerOrder.includes(id))],
      providerConfigRules: { providerRules: [...incoming.config.providerConfigRules.providerRules, ...extras] },
      modelConfigRules: incoming.config.modelConfigRules,
      ...(defaultModelSelection ? { defaultModelSelection } : {}),
    },
  };
}

/** Default v2 personal file: $ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, else
 *  $ZCODE_DATA_BASE_DIR/.zcode/v2/provider_config.json, else ~/.zcode/v2/…. */
export function defaultPersonalProviderPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim();
  if (explicit) return path.resolve(explicit);
  const base = env.ZCODE_DATA_BASE_DIR?.trim() || os.homedir();
  return path.join(base, '.zcode', 'v2', 'provider_config.json');
}

/** On-host writer: never prints keys. Same lock/CAS pattern as MCP reconcile. */
const SCRIPT = String.raw`
import os,sys,json,tempfile,fcntl,stat
request=json.load(sys.stdin)
cfg=request.get("configPath") or os.path.expanduser("~/.zcode/cli/config.json")
personal=request.get("personalPath") or os.path.join(os.path.expanduser("~"),".zcode","v2","provider_config.json")
def read_optional(p):
    try:
        if os.path.islink(p): raise ValueError("refusing a symlink config")
        if os.path.exists(p) and not stat.S_ISREG(os.stat(p).st_mode): raise ValueError("config is not a regular file")
        if os.path.exists(p) and os.path.getsize(p)>16*1024*1024: raise ValueError("config exceeds safe size limit")
        with open(p,"rb") as f: return f.read()
    except FileNotFoundError: return None
def object_config(raw, label):
    try: value=json.loads(raw)
    except (ValueError,UnicodeError): raise ValueError(label+" contains invalid JSON; left unchanged")
    if not isinstance(value,dict): raise ValueError(label+" must be an object; left unchanged")
    return value
def split_main(value):
    if not isinstance(value,str): return None
    t=value.strip(); i=t.find("/")
    if i<=0 or i>=len(t)-1: return None
    p,m=t[:i].strip(),t[i+1:].strip()
    if not p or not m or p=="builtin:zapi": return None
    return {"providerId":p,"modelId":m}
def api_type(kind):
    if kind=="anthropic": return "anthropic-messages"
    if kind=="openai": return "openai-responses"
    return "openai-chat-completions"
def build(cli):
    rules=[]; order=[]
    providers=cli.get("provider") if isinstance(cli.get("provider"),dict) else {}
    for raw_id,provider in providers.items():
        pid=str(raw_id).strip()
        if not pid or not isinstance(provider,dict): continue
        if pid.startswith("builtin:") or pid.startswith("account:"): continue
        options=provider.get("options") if isinstance(provider.get("options"),dict) else {}
        if options.get("apiKeyRequired") is False: continue
        key=options.get("apiKey")
        key=key.strip() if isinstance(key,str) else ""
        if not key: continue
        models=provider.get("models") if isinstance(provider.get("models"),dict) else {}
        ids=[]
        for mid,defn in models.items():
            if isinstance(defn,dict) and defn.get("deleted") is True: continue
            ident=(defn.get("id") if isinstance(defn,dict) else None) or mid
            ident=str(ident).strip()
            if ident and ident not in ids: ids.append(ident)
        name=provider.get("name")
        name=name.strip() if isinstance(name,str) else ""
        api={"type":api_type(provider.get("kind"))}
        base=options.get("baseURL")
        if isinstance(base,str) and base.strip(): api["baseUrl"]=base.strip()
        rule={"providerId":pid,"config":{"group":"standard-personal","access":{"type":"api-key","apiKey":key},"api":api}}
        if name and name!=pid: rule["providerName"]=name
        if ids:
            rule["config"]["personalModelIds"]=ids
            rule["config"]["modelOrder"]=ids
        rules.append(rule); order.append(pid)
    model=cli.get("model") if isinstance(cli.get("model"),dict) else {}
    default=split_main(model.get("main"))
    out={"schemaVersion":1,"config":{"providerOrder":order,"providerConfigRules":{"providerRules":rules},"modelConfigRules":{"providerModelRules":[],"manualProviderModelRules":[]}}}
    if default: out["config"]["defaultModelSelection"]=default
    return out
def merge(existing, incoming):
    if not isinstance(existing,dict): return incoming
    cfg=existing.get("config") if isinstance(existing.get("config"),dict) else {}
    rules_obj=cfg.get("providerConfigRules") if isinstance(cfg.get("providerConfigRules"),dict) else {}
    current=rules_obj.get("providerRules") if isinstance(rules_obj.get("providerRules"),list) else []
    incoming_ids={r.get("providerId") for r in incoming["config"]["providerConfigRules"]["providerRules"]}
    extras=[r for r in current if isinstance(r,dict) and isinstance(r.get("providerId"),str) and r.get("providerId") not in incoming_ids]
    extra_order=[r["providerId"] for r in extras]
    current_default=cfg.get("defaultModelSelection")
    default=incoming["config"].get("defaultModelSelection")
    if default is None and isinstance(current_default,dict) and isinstance(current_default.get("providerId"),str) and isinstance(current_default.get("modelId"),str):
        default={"providerId":current_default["providerId"],"modelId":current_default["modelId"]}
    merged={"schemaVersion":1,"config":{"providerOrder":incoming["config"]["providerOrder"]+[i for i in extra_order if i not in incoming["config"]["providerOrder"]],"providerConfigRules":{"providerRules":incoming["config"]["providerConfigRules"]["providerRules"]+extras},"modelConfigRules":incoming["config"]["modelConfigRules"]}}
    if default: merged["config"]["defaultModelSelection"]=default
    return merged
def atomic_write(p,data,expected):
    parent=os.path.dirname(p)
    os.makedirs(parent,mode=0o700,exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix=".vibe-zcode-personal-",dir=parent)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,"wb") as f:f.write(data);f.flush();os.fsync(f.fileno())
        if read_optional(p)!=expected:raise ValueError("ZCode personal config changed concurrently; left unchanged")
        os.replace(tmp,p)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)
def run():
    raw=read_optional(cfg)
    state={"personalPath":personal,"exists":False,"written":False,"providerCount":0,"hasDefault":False}
    if raw is None: return state
    cli=object_config(raw,"ZCode config")
    incoming=build(cli)
    if not incoming["config"]["providerConfigRules"]["providerRules"]:
        state["exists"]=read_optional(personal) is not None
        return state
    parent=os.path.dirname(personal)
    os.makedirs(parent,mode=0o700,exist_ok=True)
    lockfd=os.open(personal+".vibe-config.lock",os.O_CREAT|os.O_RDWR|getattr(os,"O_NOFOLLOW",0),0o600)
    try:
        fcntl.flock(lockfd,fcntl.LOCK_EX)
        old=read_optional(personal)
        existing=object_config(old,"ZCode personal config") if old is not None else None
        next_doc=merge(existing,incoming)
        state["exists"]=old is not None
        state["providerCount"]=len(next_doc["config"]["providerConfigRules"]["providerRules"])
        state["hasDefault"]=isinstance(next_doc["config"].get("defaultModelSelection"),dict)
        out=(json.dumps(next_doc,ensure_ascii=False,indent=2)+"\n").encode()
        if old!=out:
            atomic_write(personal,out,old)
            state["written"]=True
        return state
    finally:os.close(lockfd)
try:
    print(json.dumps(run()))
except Exception as exc:
    message=str(exc) if isinstance(exc,ValueError) else type(exc).__name__
    print(json.dumps({"error":message[:180]}))
    sys.exit(2)
`;

export async function ensureZcodePersonalProviders(
  remote?: { sshTarget: string },
  options: ZcodePersonalConfigOptions = {},
): Promise<ZcodePersonalConfigState | undefined> {
  const input = JSON.stringify({
    configPath: options.configPath ?? (remote ? undefined : config.zcodeConfigFile),
    personalPath: options.personalPath ?? (remote ? undefined : defaultPersonalProviderPath()),
  });
  let stdout: string;
  if (remote) {
    const result = await (options.ssh ?? sshExec)(remote.sshTarget, loginShellCommand(`python3 -c ${shQuote(SCRIPT)}`),
      { input, timeoutMs: 20_000, maxOutputBytes: 64 * 1024 });
    if (result.code !== 0 || result.timedOut) throw new Error('ZCode personal provider config could not be updated; check SSH, python3 and file permissions.');
    stdout = result.stdout;
  } else {
    stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile('python3', ['-c', SCRIPT], { timeout: 20_000, maxBuffer: 64 * 1024 }, (error, out) => {
        if (error) reject(new Error('ZCode personal provider config could not be updated; check python3, JSON and file permissions.'));
        else resolve(out);
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input);
    });
  }
  let value: ZcodePersonalConfigState & { error?: string };
  try { value = JSON.parse(stdout) as ZcodePersonalConfigState & { error?: string }; }
  catch { throw new Error('Invalid ZCode personal provider config response'); }
  if (value.error) throw new Error(value.error);
  if (typeof value.personalPath !== 'string' || typeof value.written !== 'boolean'
    || typeof value.providerCount !== 'number') {
    throw new Error('Invalid ZCode personal provider config response');
  }
  return value;
}
