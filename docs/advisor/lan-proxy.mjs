#!/usr/bin/env node
/**
 * Advisor proof-of-concept: expose the loopback-only Synapse (127.0.0.1:8008) on all interfaces
 * without touching the homeserver. Plain HTTP pass-through (headers, body, status, long-poll /sync).
 *   node docs/advisor/lan-proxy.mjs            # listens on 0.0.0.0:8009 -> 127.0.0.1:8008
 *   LISTEN=8009 TARGET=127.0.0.1:8008 node docs/advisor/lan-proxy.mjs
 * Synapse already answers CORS (Access-Control-Allow-Origin: *) so nothing is rewritten.
 */
import http from 'node:http';
const LISTEN = Number(process.env.LISTEN ?? 8009);
const [tHost, tPort] = (process.env.TARGET ?? '127.0.0.1:8008').split(':');
const server = http.createServer((req, res) => {
  const up = http.request(
    { host: tHost, port: Number(tPort), method: req.method, path: req.url, headers: { ...req.headers, host: `${tHost}:${tPort}` } },
    (upRes) => { res.writeHead(upRes.statusCode ?? 502, upRes.headers); upRes.pipe(res); },
  );
  up.on('error', (e) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ errcode: 'PROXY', error: e.message })); });
  req.pipe(up);
});
server.keepAliveTimeout = 65_000; // /sync long-polls are 30 s
server.listen(LISTEN, '0.0.0.0', () => console.log(`proxy 0.0.0.0:${LISTEN} -> ${tHost}:${tPort}`));
