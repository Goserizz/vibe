import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { log } from './log.js';
import { createApiRouter } from './http/api.js';
import { attachWsServer } from './ws/server.js';

function localIPs(): string[] {
  const out: string[] = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function banner(): void {
  const line = '─'.repeat(54);
  const urls = ['localhost', ...localIPs()];
  log.ok('\n┌' + line + '┐');
  log.ok('  Vibe — remote vibe coding for Claude Code');
  log.ok('├' + line + '┤');
  for (const host of urls) {
    log.info(`  http://${host}:${config.port}/?token=${config.token}`);
  }
  log.ok('└' + line + '┘');
  log.info('claude:', config.claudeExecutable ?? '(SDK bundled binary)');
  log.info('Open a link above. The token is also stored at', path.join(config.home, 'token'), '\n');
}

function main(): void {
  const app = express();
  app.use(express.json({ limit: '8mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', createApiRouter());

  // Serve the built web client in production. In dev, Vite serves it and
  // proxies /api + /ws here.
  if (config.isProd) {
    if (fs.existsSync(config.webDist)) {
      app.use(express.static(config.webDist));
      app.get('*', (_req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
    } else {
      log.warn('production build not found at', config.webDist, '— run `npm run build` first');
    }
  }

  const server = http.createServer(app);
  attachWsServer(server);

  server.listen(config.port, config.host, () => {
    banner();
  });

  server.on('error', (err) => {
    log.error('server error:', err);
    process.exit(1);
  });
}

main();
