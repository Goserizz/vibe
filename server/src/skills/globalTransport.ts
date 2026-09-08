import os from 'node:os';
import { execFile } from 'node:child_process';
import { sshExec, loginShellCommand, shQuote } from '../remote/ssh.js';

export interface SkillTarget { host: string; local: boolean; ssh?: string; key: string }
export interface SkillFileSnapshot { path: string; content?: string | null; hash?: string | null; status: 'ok' | 'conflict' | 'failed'; message?: string }
export interface SkillFileWrite { path: string; content: string; expectedHash: string | null }
export interface SkillWriteResult { path: string; hash?: string; status: 'synced' | 'conflict' | 'failed'; message?: string }
export interface GlobalSkillTransport {
  inspect(target: SkillTarget, paths: string[]): Promise<SkillFileSnapshot[]>;
  write(target: SkillTarget, files: SkillFileWrite[]): Promise<SkillWriteResult[]>;
}

/** Same POSIX implementation locally and over SSH. Skill bodies travel on
 * stdin, never in argv/logs. Each write is locked, CAS-checked and atomic;
 * existing bytes are backed up before replacement. Never follows symlinks. */
const SCRIPT = String.raw`
import os,sys,json,stat,hashlib,tempfile,fcntl,uuid
request=json.load(sys.stdin)
home=os.path.abspath(request.get("testHome") or os.path.expanduser("~"))
MAX_BYTES=1024*1024
def resolve(rel):
    if not rel.startswith("~/") or ".." in rel.split("/"):
        raise ValueError("invalid target path")
    p=os.path.abspath(os.path.join(home,rel[2:]))
    if os.path.commonpath([p,home])!=home or p==home:
        raise ValueError("target escapes home")
    cursor=p
    while cursor!=home:
        if os.path.islink(cursor): raise ValueError("symlink target requires manual review")
        cursor=os.path.dirname(cursor)
    return p
def read(p):
    if not os.path.lexists(p): return None,None
    if not stat.S_ISREG(os.lstat(p).st_mode): raise ValueError("target is not a regular file")
    if os.path.getsize(p)>MAX_BYTES: raise ValueError("existing skill exceeds size limit")
    data=open(p,"rb").read(MAX_BYTES+1)
    if len(data)>MAX_BYTES: raise ValueError("existing skill exceeds size limit")
    return data,hashlib.sha256(data).hexdigest()
out=[]
for item in request["files"]:
    rel=item["path"]
    try:
        p=resolve(rel)
        if request["op"]=="inspect":
            data,digest=read(p)
            out.append({"path":rel,"status":"ok","content":None if data is None else data.decode("utf-8"),"hash":digest})
            continue
        content=item["content"].encode("utf-8")
        if len(content)>MAX_BYTES: raise ValueError("skill exceeds size limit")
        parent=os.path.dirname(p)
        os.makedirs(parent,mode=0o700,exist_ok=True)
        resolve(rel)
        lock=os.open(os.path.join(parent,".vibe-global-skill.lock"),os.O_CREAT|os.O_RDWR|getattr(os,"O_NOFOLLOW",0),0o600)
        try:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            old,digest=read(p)
            desired=hashlib.sha256(content).hexdigest()
            if digest==desired:
                out.append({"path":rel,"status":"synced","hash":digest})
                continue
            if digest!=item["expectedHash"]:
                out.append({"path":rel,"status":"conflict","message":"file changed during deployment"})
                continue
            if old is not None:
                backup=os.path.join(parent,".SKILL.md.vibe-backup-"+uuid.uuid4().hex)
                fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
                with os.fdopen(fd,"wb") as f: f.write(old); f.flush(); os.fsync(f.fileno())
            fd,tmp=tempfile.mkstemp(prefix=".SKILL.md.vibe-",dir=parent)
            try:
                with os.fdopen(fd,"wb") as f: f.write(content); f.flush(); os.fsync(f.fileno())
                os.replace(tmp,p)
            finally:
                if os.path.exists(tmp): os.unlink(tmp)
            out.append({"path":rel,"status":"synced","hash":desired})
        finally:
            os.close(lock)
    except (ValueError,UnicodeError) as exc:
        out.append({"path":rel,"status":"conflict","message":str(exc)[:120]})
    except Exception as exc:
        out.append({"path":rel,"status":"failed","message":type(exc).__name__})
print(json.dumps(out))
`;

export function createGlobalSkillTransport(opts: { localHome?: string; ssh?: typeof sshExec } = {}): GlobalSkillTransport {
  const execute = async (target: SkillTarget, op: string, files: unknown[]): Promise<unknown[]> => {
    const input = JSON.stringify({ op, files, ...(target.local ? { testHome: opts.localHome ?? os.homedir() } : {}) });
    let output: string;
    if (target.local) {
      output = await new Promise<string>((resolve, reject) => {
        const child = execFile('python3', ['-c', SCRIPT], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
          if (error) reject(new Error('Local skill deployment requires a working python3'));
          else resolve(stdout);
        });
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(input);
      });
    } else {
      const result = await (opts.ssh ?? sshExec)(target.ssh!, loginShellCommand(`python3 -c ${shQuote(SCRIPT)}`),
        { input, timeoutMs: 30_000, maxOutputBytes: 16 * 1024 * 1024 });
      if (result.code !== 0 || result.timedOut) throw new Error('SSH/python3 unavailable or deployment timed out');
      output = result.stdout;
    }
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed) || parsed.length !== files.length) throw new Error('Invalid deployment response');
    return parsed;
  };
  return {
    inspect: async (target, paths) => await execute(target, 'inspect', paths.map((p) => ({ path: p }))) as SkillFileSnapshot[],
    write: async (target, files) => await execute(target, 'write', files) as SkillWriteResult[],
  };
}
