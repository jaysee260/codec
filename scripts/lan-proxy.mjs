#!/usr/bin/env node
/**
 * LAN proxy for the homeserver (Phase 2, PRIN-2): phones on the same Wi-Fi reach the loopback-only Synapse.
 *
 * Synapse is bound to 127.0.0.1:8008 and is never touched. This plain HTTP pass-through listens on
 * 0.0.0.0:8009 (configurable) and forwards every request untouched: method, path, headers, streamed bodies
 * (multi-MB media uploads), status and streamed responses (30 s long-poll /sync). Synapse already answers
 * CORS (`Access-Control-Allow-Origin: *`), so nothing is rewritten. Based on the advisor's proven
 * docs/advisor/lan-proxy.mjs.
 *
 *   npm run hs:lan                      # 0.0.0.0:8009 -> 127.0.0.1:8008, prints the URLs for the phone
 *   LAN_PROXY_PORT=8019 npm run hs:lan  # another port
 *
 * Environment: LAN_PROXY_PORT (8009), LAN_PROXY_HOST (0.0.0.0), HS_TARGET (127.0.0.1:8008), APP_PORT (5173).
 *
 * Windows: the first bind to 0.0.0.0 raises a Windows Defender Firewall prompt for node.exe; accept it for
 * Private networks (or add inbound rules for TCP 8009 and 5173). docs/MOBILE.md has the netsh commands.
 */
import http from 'node:http';
import { LAN_PROXY_PORT, lanIPv4Addresses } from './lib/lan.mjs';

const LISTEN_PORT = LAN_PROXY_PORT;
const LISTEN_HOST = process.env.LAN_PROXY_HOST ?? '0.0.0.0';
const [TARGET_HOST, TARGET_PORT_RAW] = (process.env.HS_TARGET ?? '127.0.0.1:8008').split(':');
const TARGET_PORT = Number(TARGET_PORT_RAW ?? 8008);
const APP_PORT = Number(process.env.APP_PORT ?? 5173);

let served = 0;

const server = http.createServer((req, res) => {
  served += 1;
  const upstream = http.request(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` },
    },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  upstream.on('error', (e) => {
    const hint =
      e.code === 'ECONNREFUSED'
        ? `Synapse is not answering on ${TARGET_HOST}:${TARGET_PORT} (start it with: npm run hs:up)`
        : e.message;
    console.error(`[lan-proxy] ${req.method} ${req.url} -> ${hint}`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errcode: 'M_UNKNOWN', error: `lan-proxy: ${hint}` }));
  });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
});

// /sync long-polls are 30 s; never cut a keep-alive connection under them, and never time out a request body.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0;
server.timeout = 0;

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[lan-proxy] port ${LISTEN_PORT} is already in use (another proxy?). Set LAN_PROXY_PORT to use another port.`);
  } else if (e.code === 'EACCES') {
    console.error(`[lan-proxy] not allowed to bind ${LISTEN_HOST}:${LISTEN_PORT} (firewall policy or reserved port range).`);
  } else {
    console.error(`[lan-proxy] ${e.message}`);
  }
  process.exit(1);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  const addrs = lanIPv4Addresses();
  console.log(`[lan-proxy] http://${LISTEN_HOST}:${LISTEN_PORT} -> http://${TARGET_HOST}:${TARGET_PORT} (Synapse, untouched)`);
  console.log('');
  if (addrs.length === 0) {
    console.log('  No LAN IPv4 address found. Is Wi-Fi / Ethernet connected?');
  } else {
    console.log('  Phone on the same Wi-Fi (first block is the best guess; virtual adapters are usually unreachable):');
    for (const a of addrs) {
      console.log('');
      console.log(`  ${a.name}${a.virtual ? '  (virtual adapter)' : ''}`);
      console.log(`    homeserver URL  http://${a.address}:${LISTEN_PORT}   -> login screen > Advanced > Homeserver URL`);
      console.log(`    app URL         http://${a.address}:${APP_PORT}   -> phone browser, after: npm run dev:lan`);
    }
    console.log('');
    console.log(`  APK: npm run cap:build:android:lan bakes VITE_HS_URL=http://${addrs[0].address}:${LISTEN_PORT} as the default.`);
  }
  console.log('');
  console.log('  Windows: accept the Defender Firewall prompt for node.exe (Private networks) the first time.');
  console.log('  Ctrl+C to stop.');
});

function shutdown() {
  console.log(`\n[lan-proxy] stopping (${served} requests proxied)`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
