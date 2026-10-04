#!/usr/bin/env node
/**
 * Advisor probe: does MediaRecorder work under headless Chromium with Playwright's fake media?
 *
 *   node docs/advisor/fake-mic-probe.mjs
 *
 * Launch args:  --use-fake-device-for-media-stream --use-fake-ui-for-media-stream
 * Context:      permissions: ['microphone']
 * Page:         getUserMedia({ audio: true }) -> MediaRecorder('audio/webm;codecs=opus') for 1 s
 *               -> blob size -> AudioContext.decodeAudioData -> 100-bucket peak waveform (0-1024 ints)
 * The page is served from a throwaway http server on 127.0.0.1 (secure context, no Vite needed).
 * Runs twice: Playwright's default headless shell and full Chromium new-headless (channel 'chromium').
 * QA / Dev B: reuse the in-page function as the reference recording + waveform pipeline.
 */
import http from 'node:http';
import { chromium } from '@playwright/test';

const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
const WAVEFORM_BUCKETS = 100;

async function inPage(buckets) {
  const out = { mimeSupported: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') };
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  out.track = stream.getAudioTracks()[0]?.label ?? '(no track)';
  const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));
  const t0 = performance.now();
  rec.start();
  await new Promise((r) => setTimeout(r, 1000));
  rec.stop();
  await stopped;
  out.measuredDurationMs = Math.round(performance.now() - t0);
  stream.getTracks().forEach((t) => t.stop());
  const blob = new Blob(chunks, { type: rec.mimeType });
  out.recorderMimeType = rec.mimeType;
  out.blobSize = blob.size;
  const ctx = new AudioContext();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    out.decoded = { durationMs: Math.round(buf.duration * 1000), sampleRate: buf.sampleRate, channels: buf.numberOfChannels };
    const data = buf.getChannelData(0);
    const per = Math.max(1, Math.floor(data.length / buckets));
    const wf = [];
    for (let b = 0; b < buckets; b++) {
      let peak = 0;
      for (let i = b * per; i < (b + 1) * per && i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
      wf.push(Math.round(Math.min(1, peak) * 1024));
    }
    out.waveform = wf;
    out.waveformMin = Math.min(...wf);
    out.waveformMax = Math.max(...wf);
    out.waveformDistinct = new Set(wf).size;
    out.nonFlat = out.waveformMax > 0 && out.waveformDistinct > 1;
  } catch (e) {
    out.decodeError = String(e);
  }
  await ctx.close();
  return out;
}

async function run(label, launchOpts, url) {
  const browser = await chromium.launch({ headless: true, args: ARGS, ...launchOpts });
  try {
    const ctx = await browser.newContext({ permissions: ['microphone'] });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url);
    const res = await page.evaluate(inPage, WAVEFORM_BUCKETS);
    console.log(`\n== ${label} (${browser.version()}) ==`);
    const { waveform, ...rest } = res;
    console.log(JSON.stringify(rest, null, 2));
    if (waveform) console.log('waveform[0..19] =', waveform.slice(0, 20).join(' '));
    if (errors.length) console.log('page errors:', errors);
    return res;
  } finally {
    await browser.close();
  }
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>fake-mic-probe</title><body>probe</body>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://localhost:${server.address().port}/`;
try {
  const a = await run('headless shell (Playwright default)', {}, url);
  const b = await run("full Chromium new-headless (channel: 'chromium')", { channel: 'chromium' }, url);
  const ok = (r) => r.blobSize > 0 && !r.decodeError && r.nonFlat;
  console.log(`\nRESULT: headless-shell=${ok(a) ? 'PASS' : 'FAIL'} chromium-new-headless=${ok(b) ? 'PASS' : 'FAIL'}`);
  process.exitCode = ok(a) && ok(b) ? 0 : 1;
} finally {
  server.close();
}
