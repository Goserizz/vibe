import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { log } from '../log.js';
import { config } from '../config.js';
import { tokenMatches } from '../auth.js';
import { Conn, hub } from './hub.js';
import { spawnTerminal } from '../terminal/pty.js';
import { PROTOCOL_VERSION } from '../../../shared/protocol.js';

const HEARTBEAT_MS = 30_000;

const decisionSchema = z.object({
  allow: z.boolean(),
  remember: z.boolean().optional(),
  updatedInput: z.unknown().optional(),
});

const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('subscribe'), sessionId: z.string(), lastSeq: z.number() }),
  z.object({ t: z.literal('unsubscribe'), sessionId: z.string() }),
  z.object({ t: z.literal('send'), sessionId: z.string(), clientMsgId: z.string(), text: z.string() }),
  z.object({ t: z.literal('abort'), sessionId: z.string() }),
  z.object({ t: z.literal('permission'), sessionId: z.string(), requestId: z.string(), decision: decisionSchema }),
  z.object({ t: z.literal('ping') }),
]);

export function attachWsServer(server: Server): void {
  // Both channels use `noServer` and share one upgrade router; attaching two
  // path-scoped WebSocketServers to the same http server corrupts handshakes.
  const wss = new WebSocketServer({ noServer: true });
  const termWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (!tokenMatches(url.searchParams.get('token'))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (url.pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else if (url.pathname === '/terminal') {
      termWss.handleUpgrade(req, socket, head, (ws) => termWss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  attachTerminalWs(termWss);

  wss.on('connection', (ws) => {
    const conn = new Conn(ws);
    hub.addConn(conn);
    conn.send({ t: 'hello', protocolVersion: PROTOCOL_VERSION, serverVersion: config.serverVersion });

    (ws as WsWithLiveness).isAlive = true;
    ws.on('pong', () => {
      (ws as WsWithLiveness).isAlive = true;
    });

    ws.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const result = clientMessageSchema.safeParse(parsed);
      if (!result.success) {
        conn.send({ t: 'error', message: 'malformed message' });
        return;
      }
      const msg = result.data;
      switch (msg.t) {
        case 'subscribe':
          hub.subscribe(conn, msg.sessionId, msg.lastSeq);
          break;
        case 'unsubscribe':
          hub.unsubscribe(conn, msg.sessionId);
          break;
        case 'send':
          hub.send(conn, msg.sessionId, msg.clientMsgId, msg.text);
          break;
        case 'abort':
          hub.abort(msg.sessionId);
          break;
        case 'permission':
          hub.resolvePermission(msg.sessionId, msg.requestId, msg.decision);
          break;
        case 'ping':
          conn.send({ t: 'pong' });
          break;
      }
    });

    ws.on('close', () => hub.removeConn(conn));
    ws.on('error', () => hub.removeConn(conn));
  });

  // Detect and reap dead connections so the server doesn't leak sockets and
  // reverse proxies don't silently drop us.
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      const live = ws as WsWithLiveness;
      if (live.isAlive === false) {
        ws.terminate();
        continue;
      }
      live.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);

  wss.on('close', () => clearInterval(interval));

  log.debug('websocket server attached at /ws and /terminal');
}

/** Interactive terminal channel: streams a PTY (local shell or `ssh -tt` to the
 *  session's host) over a WebSocket. */
function attachTerminalWs(wss: WebSocketServer): void {
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const loc = hub.locate(url.searchParams.get('sessionId') ?? '');
    if (!loc) {
      ws.send(JSON.stringify({ t: 'error', message: 'session not found' }));
      ws.close();
      return;
    }

    const cols = Number(url.searchParams.get('cols')) || 80;
    const rows = Number(url.searchParams.get('rows')) || 24;
    let term;
    try {
      term = spawnTerminal({ cwd: loc.cwd, sshTarget: loc.sshTarget, cols, rows });
    } catch (err) {
      ws.send(JSON.stringify({ t: 'error', message: err instanceof Error ? err.message : String(err) }));
      ws.close();
      return;
    }

    term.onData((data) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'data', data }));
    });
    term.onExit(() => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ t: 'exit' }));
        ws.close();
      }
    });

    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.t === 'input' && typeof msg.data === 'string') term.write(msg.data);
      else if (msg.t === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
        try {
          term.resize(msg.cols, msg.rows);
        } catch {
          /* ignore transient resize errors */
        }
      }
    });

    const kill = () => {
      try {
        term.kill();
      } catch {
        /* already gone */
      }
    };
    ws.on('close', kill);
    ws.on('error', kill);
  });
}

interface WsWithLiveness {
  isAlive?: boolean;
}
