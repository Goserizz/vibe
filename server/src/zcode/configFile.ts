import { execFile } from 'node:child_process';
import { config } from '../config.js';
import { sshExec, loginShellCommand, shQuote } from '../remote/ssh.js';

export interface ZcodeConfigState {
  configPath: string;
  exists: boolean;
  hasModel: boolean;
  /** Project/env overrides are left to ZCode's own full configuration resolver. */
  hasOverrides: boolean;
  changed: boolean;
}

export interface ZcodeConfigOptions {
  cwd?: string;
  configPath?: string;
  managedPath?: string;
  ssh?: typeof sshExec;
}

/** Model config and credentials must never make a network round-trip just to
 * update MCP. Merge on the host while holding a lock, preserve all other keys,
 * reject failed reads/invalid JSON, and CAS-check before the atomic rename. */
const SCRIPT = String.raw`
import os,sys,json,tempfile,hashlib,fcntl,stat
request=json.load(sys.stdin)
cfg=request.get("configPath") or os.path.expanduser("~/.zcode/cli/config.json")
side=request.get("managedPath") or os.path.expanduser("~/.vibe/zcode-managed-mcp.json")
def read_optional(p):
    try:
        if os.path.islink(p): raise ValueError("refusing a symlink config")
        if os.path.exists(p) and not stat.S_ISREG(os.stat(p).st_mode): raise ValueError("config is not a regular file")
        if os.path.exists(p) and os.path.getsize(p)>16*1024*1024: raise ValueError("config exceeds safe size limit")
        with open(p,"rb") as f: return f.read()
    except FileNotFoundError: return None
def object_config(raw):
    try: value=json.loads(raw)
    except (ValueError,UnicodeError): raise ValueError("ZCode config contains invalid JSON; left unchanged")
    if not isinstance(value,dict): raise ValueError("ZCode config must be an object; left unchanged")
    return value
def has_overrides():
    if any(os.environ.get(k) for k in ["ZCODE_MODEL","ZCODE_MODEL_ID","ZCODE_MODEL_MAIN","ZCODE_MAIN_MODEL","ZCODE_MODEL_PROVIDER","ZCODE_API_KEY","ZCODE_BASE_URL"]):return True
    cwd=request.get("cwd")
    if not cwd: return False
    cwd=os.path.abspath(cwd)
    dirs=[];cursor=cwd;found_git=False
    while True:
        dirs.append(cursor)
        if os.path.exists(os.path.join(cursor,".git")):found_git=True;break
        parent=os.path.dirname(cursor)
        if parent==cursor:break
        cursor=parent
    if not found_git:dirs=[cwd]
    if any(os.path.isfile(os.path.join(d,f)) for d in dirs for f in ["zcode.json",".zcode/config.json"]):return True
    # Native dotenv/environment config may supply overrides. Do not parse or
    # disclose secrets here; defer these cases to the native validator.
    cursor=cwd
    while True:
        if os.path.isfile(os.path.join(cursor,".env")):return True
        parent=os.path.dirname(cursor)
        if parent==cursor:break
        cursor=parent
    return False
def atomic_write(p,data,expected):
    parent=os.path.dirname(p)
    os.makedirs(parent,mode=0o700,exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix=".vibe-zcode-",dir=parent)
    try:
        with os.fdopen(fd,"wb") as f:f.write(data);f.flush();os.fsync(f.fileno())
        if read_optional(p)!=expected:raise ValueError("ZCode config changed concurrently; left unchanged")
        os.replace(tmp,p)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)
def run():
    raw=read_optional(cfg)
    state={"configPath":cfg,"exists":raw is not None,"hasModel":False,"hasOverrides":has_overrides(),"changed":False}
    if raw is None:
        # A missing model config is NOT permission to create an MCP-only stub.
        return state
    lockfd=os.open(cfg+".vibe-config.lock",os.O_CREAT|os.O_RDWR|getattr(os,"O_NOFOLLOW",0),0o600)
    try:
        fcntl.flock(lockfd,fcntl.LOCK_EX)
        raw=read_optional(cfg)
        if raw is None:raise ValueError("ZCode config disappeared during update; left unchanged")
        root=object_config(raw)
        model=root.get("model")
        state["hasModel"]=bool(model.get("main")) if isinstance(model,dict) else bool(model)
        mcp=root.get("mcp",{})
        if not isinstance(mcp,dict):raise ValueError("ZCode mcp config must be an object; left unchanged")
        servers=mcp.get("servers",{})
        if not isinstance(servers,dict):raise ValueError("ZCode mcp.servers must be an object; left unchanged")
        old_side=read_optional(side)
        try:
            previous=json.loads(old_side) if old_side is not None else []
            if not isinstance(previous,list) or not all(isinstance(x,str) for x in previous):previous=[]
        except (ValueError,UnicodeError):previous=[]
        desired=request["servers"]
        next_servers={k:v for k,v in servers.items() if k not in previous}
        next_servers.update(desired)
        next_root={**root,"mcp":{**mcp,"servers":next_servers}}
        if next_root!=root:
            # One recoverable snapshot per non-MCP configuration, not one copy
            # per expiring Monitor bearer token. No credential values in names.
            non_mcp={k:v for k,v in root.items() if k!="mcp"}
            key=hashlib.sha256(json.dumps(non_mcp,sort_keys=True).encode()).hexdigest()[:20]
            backup=cfg+".vibe-backup-"+key
            try:
                fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
                with os.fdopen(fd,"wb") as f:f.write(raw);f.flush();os.fsync(f.fileno())
            except FileExistsError:pass
            out=(json.dumps(next_root,ensure_ascii=False,indent=2)+"\n").encode()
            atomic_write(cfg,out,raw)
            state["changed"]=True
        side_out=(json.dumps(list(desired),ensure_ascii=False,indent=2)+"\n").encode()
        if old_side!=side_out:atomic_write(side,side_out,old_side)
        return state
    finally:os.close(lockfd)
try:
    print(json.dumps(run()))
except Exception as exc:
    # JSON parser exceptions can include input data. Return only bounded,
    # deliberately authored messages; never echo file bytes or request bodies.
    message=str(exc) if isinstance(exc,ValueError) else type(exc).__name__
    print(json.dumps({"error":message[:180]}))
    sys.exit(2)
`;

export async function reconcileZcodeMcp(
  servers: Record<string, unknown>,
  remote?: { sshTarget: string },
  options: ZcodeConfigOptions = {},
): Promise<ZcodeConfigState> {
  const input = JSON.stringify({ servers, cwd: options.cwd,
    configPath: options.configPath ?? (remote ? undefined : config.zcodeConfigFile),
    managedPath: options.managedPath ?? (remote ? undefined : `${config.home}/zcode-managed-mcp.json`),
  });
  let stdout: string;
  if (remote) {
    const result = await (options.ssh ?? sshExec)(remote.sshTarget, loginShellCommand(`python3 -c ${shQuote(SCRIPT)}`),
      { input, timeoutMs: 20_000, maxOutputBytes: 64 * 1024 });
    if (result.code !== 0 || result.timedOut) throw new Error('ZCode MCP configuration could not be safely updated; check SSH, python3 and file permissions. No empty fallback was written.');
    stdout = result.stdout;
  } else {
    stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile('python3', ['-c', SCRIPT], { timeout: 20_000, maxBuffer: 64 * 1024 }, (error, out) => {
        if (error) reject(new Error('ZCode MCP configuration could not be safely updated; check python3, JSON and file permissions. No empty fallback was written.'));
        else resolve(out);
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input);
    });
  }
  let value: ZcodeConfigState;
  try { value = JSON.parse(stdout) as ZcodeConfigState; }
  catch { throw new Error('Invalid ZCode configuration inspection response'); }
  if (typeof value.configPath !== 'string' || typeof value.exists !== 'boolean'
    || typeof value.hasModel !== 'boolean' || typeof value.hasOverrides !== 'boolean') {
    throw new Error('Invalid ZCode configuration inspection response');
  }
  return value;
}

export function assertZcodeStartupConfig(state: ZcodeConfigState | undefined, resume?: string): void {
  // Existing sessions may use a saved/runtime model. Project/env config is
  // resolved by ZCode itself. Only fail early for a definitively unconfigured
  // fresh session, not an unavailable best-effort inspection.
  if (!state || resume || state.hasModel || state.hasOverrides) return;
  throw new Error(`ZCode 模型未配置：${state.configPath}${state.exists ? ' 存在，但缺少 model（仅有 MCP 不够）' : ' 不存在'}。请在该主机配置 provider 和 model；仅选择模型或重启不会自动补齐。`);
}
