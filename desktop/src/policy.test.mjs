/**
 * Mac app: navigation, popup and permission rules (desktop/src/policy.cjs).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import policy from './policy.cjs';

const { appUrlFrom, decideNavigation, decideWindowOpen, permissionAllowed, badgeValue, DEFAULT_APP_URL } = policy;
const APP = 'https://codec.704.chat/';
const SSO = 'https://matrix.704.chat/_matrix/client/v3/login/sso/redirect/oidc-keycloak?redirectUrl=https%3A%2F%2Fcodec.704.chat%2F';

describe('appUrlFrom', () => {
  test('live site by default; CODEC_URL for local testing; junk falls back', () => {
    assert.equal(appUrlFrom({}), DEFAULT_APP_URL);
    assert.equal(appUrlFrom({ CODEC_URL: 'http://localhost:5173' }), 'http://localhost:5173/');
    assert.equal(appUrlFrom({ CODEC_URL: 'file:///etc/passwd' }), DEFAULT_APP_URL);
    assert.equal(appUrlFrom({ CODEC_URL: 'not a url' }), DEFAULT_APP_URL);
  });
});

describe('decideNavigation', () => {
  test('SSO sign-in stays in the window through Keycloak and back, then links go to the browser again', () => {
    let state = { appUrl: APP, ssoActive: false };
    const step = (url) => {
      const d = decideNavigation(url, state);
      state = { appUrl: APP, ssoActive: d.ssoActive };
      return d.action;
    };
    assert.equal(step(SSO), 'allow');
    assert.equal(step('https://id.humblehome.net/realms/home/login-actions/authenticate?session_code=x'), 'allow');
    assert.equal(step('https://matrix.704.chat/_synapse/client/oidc/callback?code=y'), 'allow');
    assert.equal(step('https://codec.704.chat/?loginToken=abc'), 'allow');
    assert.equal(state.ssoActive, false);
    assert.equal(step('https://id.humblehome.net/realms/home/account'), 'external');
  });

  test('a link in a message never replaces Codec', () => {
    assert.equal(decideNavigation('https://example.com/article', { appUrl: APP, ssoActive: false }).action, 'external');
    assert.equal(decideNavigation('mailto:jc@704.chat', { appUrl: APP, ssoActive: false }).action, 'external');
    assert.equal(decideNavigation('https://codec.704.chat/#room', { appUrl: APP, ssoActive: false }).action, 'allow');
  });

  test('odd schemes are blocked', () => {
    for (const url of ['file:///Users/jc', 'javascript:alert(1)', 'smb://share', '::bad']) {
      assert.equal(decideNavigation(url, { appUrl: APP, ssoActive: true }).action, 'block', url);
    }
  });
});

describe('decideWindowOpen', () => {
  test('image tab and the sign-in check popup open in the app; links go to the browser', () => {
    assert.equal(decideWindowOpen('about:blank', APP), 'in-app');
    assert.equal(decideWindowOpen('', APP), 'in-app');
    assert.equal(decideWindowOpen('blob:https://codec.704.chat/0b6a-11', APP), 'in-app');
    assert.equal(decideWindowOpen('https://matrix.704.chat/_matrix/client/v3/auth/m.login.sso/fallback/web?session=s', APP), 'in-app');
    assert.equal(decideWindowOpen('https://static.klipy.com/x.gif', APP), 'external');
    assert.equal(decideWindowOpen('blob:https://evil.example/1', APP), 'deny');
    assert.equal(decideWindowOpen('file:///etc/hosts', APP), 'deny');
  });
});

describe('permissionAllowed', () => {
  test('mic/camera and notifications for Codec only', () => {
    assert.equal(permissionAllowed('media', 'https://codec.704.chat/', APP), true);
    assert.equal(permissionAllowed('notifications', 'https://codec.704.chat', APP), true);
    assert.equal(permissionAllowed('media', 'https://id.humblehome.net/', APP), false);
    assert.equal(permissionAllowed('geolocation', 'https://codec.704.chat/', APP), false);
    assert.equal(permissionAllowed('openExternal', 'https://codec.704.chat/', APP), false);
  });
});

describe('badgeValue', () => {
  test('whole numbers only', () => {
    assert.equal(badgeValue(4), 4);
    assert.equal(badgeValue(0), 0);
    assert.equal(badgeValue(-3), 0);
    assert.equal(badgeValue(2.5), 0);
    assert.equal(badgeValue('7'), 0);
    assert.equal(badgeValue(1e9), 99_999);
  });
});
