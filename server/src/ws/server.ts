import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { log } from '../log.js';
import { config } from '../config.js';
import { resolveAccountByToken } from '../auth.js';
import { sessionVisible } from '../sessions/visibility.js';
import { WsConn, hub } from './hub.js';
import { vibotHub } from '../vibot/hub.js';
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
  z.object({ t: z.literal('task_stop'), sessionId: z.string(), taskId: z.string() }),
  z.object({ t: z.literal('permission'), sessionId: z.string(), requestId: z.string(), decision: decisionSchema }),
  z.object({ t: z.literal('vibot_subscribe'), convId: z.string(), lastSeq: z.number() }),
  z.object({ t: z.literal('vibot_unsubscribe'), convId: z.string() }),
  z.object({
    t: z.literal('vibot_send'),
    convId: z.string(),
    clientMsgId: z.string(),
    text: z.string(),
    images: z.array(z.string()).max(4).optional(),
  }),
  z.object({ t: z.literal('vibot_abort'), convId: z.string() }),
  z.object({
    t: z.literal('vibot_answer'),
    convId: z.string(),
    callId: z.string(),
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  }),
  z.object({ t: z.literal('ping') }),
]);

export function attachWsServer(server: Server): void {
  // Both channels use `noServer` and share one upgrade router; attaching two
  // path-scoped WebSocketServers to the same http server corrupts handshakes.
  const wss = new WebSocketServer({ noServer: true });
  const termWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const account = resolveAccountByToken(url.searchParams.get('token'));
    if (!account) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    // ws's `connection` event is typed (ws, req); carry the resolved account on
    // the socket instead of threading it through the event emitter.
    if (url.pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        (ws as unknown as WsWithAccount).vibeAccount = account;
        wss.emit('connection', ws, req);
      });
    } else if (url.pathname === '/terminal') {
      termWss.handleUpgrade(req, socket, head, (ws) => {
        (ws as unknown as WsWithAccount).vibeAccount = account;
        termWss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  attachTerminalWs(termWss);

  wss.on('connection', (ws) => {
    const account = (ws as unknown as WsWithAccount).vibeAccount ?? { name: 'admin', isAdmin: true };
    const conn = new WsConn(ws, account.name);
    hub.addConn(conn);
    vibotHub.addConn(conn);
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
          if (!hub.abort(msg.sessionId, conn.account)) {
            conn.send({ t: 'error', message: 'session not found', sessionId: msg.sessionId });
          }
          break;
        case 'task_stop':
          hub.stopTask(conn, msg.sessionId, msg.taskId);
          break;
        case 'permission':
          if (!hub.resolvePermission(msg.sessionId, msg.requestId, msg.decision, conn.account)) {
            conn.send({ t: 'error', message: 'session not found', sessionId: msg.sessionId });
          }
          break;
        case 'vibot_subscribe':
          if (!conn.isAdmin()) conn.send({ t: 'error', message: 'vibot is admin-only' });
          else vibotHub.subscribe(conn, msg.convId, msg.lastSeq);
          break;
        case 'vibot_unsubscribe':
          if (!conn.isAdmin()) conn.send({ t: 'error', message: 'vibot is admin-only' });
          else vibotHub.unsubscribe(conn, msg.convId);
          break;
        case 'vibot_send':
          if (!conn.isAdmin()) conn.send({ t: 'error', message: 'vibot is admin-only' });
          else vibotHub.send(conn, msg.convId, msg.clientMsgId, msg.text, msg.images);
          break;
        case 'vibot_abort':
          if (!conn.isAdmin()) conn.send({ t: 'error', message: 'vibot is admin-only' });
          else vibotHub.abort(msg.convId);
          break;
        case 'vibot_answer':
          if (!conn.isAdmin()) conn.send({ t: 'error', message: 'vibot is admin-only' });
          else vibotHub.answer(msg.convId, msg.callId, msg.answers);
          break;
        case 'ping':
          conn.send({ t: 'pong' });
          break;
      }
    });

    ws.on('close', () => {
      hub.removeConn(conn);
      vibotHub.removeConn(conn);
    });
    ws.on('error', () => {
      hub.removeConn(conn);
      vibotHub.removeConn(conn);
    });
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
    const account = (ws as unknown as WsWithAccount).vibeAccount ?? { name: 'admin', isAdmin: true };
    const sessionId = url.searchParams.get('sessionId') ?? '';
    if (!sessionVisible(account.name, sessionId)) {
      ws.send(JSON.stringify({ t: 'error', message: 'session not found' }));
      ws.close();
      return;
    }
    const loc = hub.locate(sessionId);
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

/** Account resolved at upgrade time, attached to the raw WebSocket. */
interface WsWithAccount {
  vibeAccount?: { name: string; isAdmin: boolean };
}
