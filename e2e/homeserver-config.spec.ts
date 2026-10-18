import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * Regression tests for the test homeserver's config, found while setting up CI on Linux:
 *  - homeserver.yaml carried a literal `${MARKER}` line (invalid YAML) instead of the marker comment, so
 *    `synapse generate` crashed and scripts/hs.mjs appended a second, duplicate overrides block;
 *  - Synapse ran as 991:991 and could not read the 0600 files in data/secrets that hs.mjs writes as the host user.
 * No browser needed: these read the files the CI job starts Synapse from.
 */
const HS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'homeserver');
const MARKER = '# --- matrix-poc overrides ---'; // must match MARKER in scripts/hs.mjs

test.describe('test homeserver config', () => {
  test('homeserver.yaml has the overrides marker once and no template placeholders', () => {
    const yaml = readFileSync(path.join(HS_DIR, 'homeserver.yaml'), 'utf8');
    const markerLines = yaml.split(/\r?\n/).filter((line) => line.trim() === MARKER);
    expect(markerLines).toHaveLength(1);
    expect(yaml).not.toContain('${');
  });

  test('scripts/hs.mjs uses the same marker as homeserver.yaml', () => {
    const script = readFileSync(path.join(HS_DIR, '..', 'scripts', 'hs.mjs'), 'utf8');
    expect(script).toContain(`const MARKER = '${MARKER}';`);
  });

  test('docker-compose runs Synapse as the user hs.mjs picks, so it can read data/secrets', () => {
    const compose = readFileSync(path.join(HS_DIR, 'docker-compose.yml'), 'utf8');
    expect(compose).toMatch(/UID: \$\{HS_UID:-991\}/);
    expect(compose).toMatch(/GID: \$\{HS_GID:-991\}/);
  });
});
