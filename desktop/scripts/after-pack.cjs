/**
 * Without an Apple Developer ID, electron-builder leaves the app unsigned, and Apple Silicon Macs refuse to run an
 * unsigned app at all ("damaged"). Give it an ad-hoc signature instead; testers then allow it once in
 * System Settings > Privacy & Security. With a Developer ID (CSC_LINK / CSC_NAME), electron-builder signs over this.
 */
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin' || process.platform !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
