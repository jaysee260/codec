/**
 * Where the Codec window may go, which popups stay in the app, and which browser permissions the site gets.
 * Pure functions (no Electron) so node:test can check them: desktop/src/policy.test.mjs.
 */
'use strict';

const DEFAULT_APP_URL = 'https://codec.704.chat/';

/** The page the app loads: CODEC_URL when set (local testing), else the live site. */
function appUrlFrom(env) {
  const raw = env && env.CODEC_URL ? String(env.CODEC_URL) : DEFAULT_APP_URL;
  const url = parse(raw);
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return DEFAULT_APP_URL;
  return url.toString();
}

function parse(raw) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function isAppUrl(raw, appUrl) {
  const url = parse(raw);
  return !!url && url.origin === new URL(appUrl).origin;
}

/** Codec's "Sign in" sends the window to the homeserver's SSO redirect; Keycloak and the way back follow it. */
function isSsoStart(raw) {
  const url = parse(raw);
  return !!url && /\/_matrix\/client\/(v3|r0|unstable)\/login\/sso\/redirect(\/|$)/.test(url.pathname);
}

/** The homeserver's UIA SSO fallback page (cross-signing setup asks for it in a popup that reports back). */
function isUiaFallback(raw) {
  const url = parse(raw);
  return !!url && /\/_matrix\/client\/(v3|r0|unstable)\/auth\/[^/]+\/fallback\/web$/.test(url.pathname);
}

function isWeb(url) {
  return url.protocol === 'https:' || url.protocol === 'http:';
}

/**
 * A navigation of the main window (link click, `location.href = ...`, form post). Returns the action and the next
 * `ssoActive`: while signing in, the window follows the SSO pages (Keycloak lives on another host); otherwise
 * anything off the app goes to the default browser so a link in a message never replaces Codec.
 *   allow     let the window navigate
 *   external  cancel it and open the URL in the default browser
 *   block     cancel it
 */
function decideNavigation(raw, state) {
  const url = parse(raw);
  if (!url) return { action: 'block', ssoActive: state.ssoActive };
  if (isAppUrl(raw, state.appUrl)) return { action: 'allow', ssoActive: false };
  if (url.protocol === 'mailto:') return { action: 'external', ssoActive: state.ssoActive };
  if (!isWeb(url)) return { action: 'block', ssoActive: state.ssoActive };
  if (isSsoStart(raw)) return { action: 'allow', ssoActive: true };
  if (state.ssoActive) return { action: 'allow', ssoActive: true };
  return { action: 'external', ssoActive: false };
}

/**
 * `window.open` / `target="_blank"` from the main window.
 *   in-app    a Codec window: the blank tab openMedia fills with a decrypted image, the UIA sign-in popup
 *   external  the default browser (links in messages, link previews, GIF links)
 *   deny      nothing
 */
function decideWindowOpen(raw, appUrl) {
  if (raw === '' || raw === 'about:blank') return 'in-app';
  const url = parse(raw);
  if (!url) return 'deny';
  if (url.protocol === 'blob:') return isAppUrl(url.pathname, appUrl) ? 'in-app' : 'deny';
  if (isAppUrl(raw, appUrl) || isUiaFallback(raw)) return 'in-app';
  if (isWeb(url) || url.protocol === 'mailto:') return 'external';
  return 'deny';
}

/** Browser permissions Codec uses: mic/camera (voice notes, calls), notifications, copy, fullscreen video. */
const APP_PERMISSIONS = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen', 'speaker-selection']);

function permissionAllowed(permission, requestingUrl, appUrl) {
  return APP_PERMISSIONS.has(permission) && isAppUrl(requestingUrl, appUrl);
}

/** Dock badge from the page: a whole number, clamped; anything else clears it. */
function badgeValue(raw) {
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, 99_999) : 0;
}

module.exports = {
  DEFAULT_APP_URL,
  appUrlFrom,
  isAppUrl,
  isSsoStart,
  isUiaFallback,
  decideNavigation,
  decideWindowOpen,
  permissionAllowed,
  badgeValue,
};
