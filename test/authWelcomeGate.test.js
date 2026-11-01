import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const indexSource = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const loginSource = fs.readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');

function extractRoute(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `route not found: ${marker}`);
  const end = source.indexOf('\n});', start);
  assert.notEqual(end, -1, `route terminator not found: ${marker}`);
  return source.slice(start, end);
}

test('registration does not request or send a welcome email before verification', () => {
  assert.doesNotMatch(loginSource, /notifyBackendWelcomeEmail/);
  assert.doesNotMatch(loginSource, /\/api\/notify-verification/);
  assert.match(loginSource, /sendVerificationEmailFromBackend\(userCredential\.user\)/);
});

test('each backend welcome-email path requires a verified Firebase email claim first', () => {
  const loginSuccessRoute = extractRoute(indexSource, 'app.post("/api/login-success"');
  const notifyRoute = extractRoute(indexSource, 'app.post("/api/notify-verification"');

  for (const route of [loginSuccessRoute, notifyRoute]) {
    const verificationGuard = route.indexOf('decodedToken.email_verified !== true');
    const welcomeSend = route.indexOf('enviarBienvenida(');
    assert.ok(verificationGuard >= 0, 'route rejects tokens without email_verified=true');
    assert.ok(welcomeSend > verificationGuard, 'welcome send is after the verification guard');
  }

  assert.equal((indexSource.match(/enviarBienvenida\(/g) || []).length, 2,
    'all welcome-email call sites are the two guarded backend routes');
});
