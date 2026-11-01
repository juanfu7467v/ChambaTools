import test from 'node:test';
import assert from 'node:assert/strict';
import { enviarCorreoAccionFirebase } from '../authEmail.js';

function createResendStub() {
  const messages = [];
  return {
    messages,
    client: {
      emails: {
        send: async (message) => {
          messages.push(message);
          return { data: { id: 'res_test_123' }, error: null };
        }
      }
    }
  };
}

test('sends the verification action link through the branded template with escaped dynamic values', async () => {
  const resend = createResendStub();
  const actionUrl = 'https://auth.facilitotools.com/action?oobCode=one-time&continueUrl=https://facilitotools.com/verificacion';

  const result = await enviarCorreoAccionFirebase({
    tipo: 'verificacion',
    email: 'alice@example.test',
    nombre: 'Alice <Admin>',
    actionUrl
  }, resend.client);

  assert.deepEqual(result, { success: true, messageId: 'res_test_123' });
  assert.equal(resend.messages.length, 1);
  assert.equal(resend.messages[0].to, 'alice@example.test');
  assert.equal(resend.messages[0].subject, 'Confirma tu correo electrónico en FacilitoTools');
  assert.match(resend.messages[0].html, /Alice &lt;Admin&gt;/);
  assert.match(resend.messages[0].html, /href="https:\/\/auth\.facilitotools\.com\/action\?oobCode=one-time&amp;continueUrl=https:\/\/facilitotools\.com\/verificacion"/);
  assert.doesNotMatch(resend.messages[0].html, /Alice <Admin>/);
});

test('uses the dedicated password-reset template and rejects unknown action types without sending', async () => {
  const resend = createResendStub();
  const actionUrl = 'https://auth.facilitotools.com/action?oobCode=reset-code';
  const result = await enviarCorreoAccionFirebase({
    tipo: 'restablecimiento',
    email: 'bob@example.test',
    nombre: null,
    actionUrl
  }, resend.client);

  assert.equal(result.success, true);
  assert.equal(resend.messages[0].subject, 'Restablece tu contraseña de FacilitoTools');
  assert.match(resend.messages[0].html, /Crear nueva contraseña/);
  assert.match(resend.messages[0].html, /bob/);

  const invalid = await enviarCorreoAccionFirebase({
    tipo: 'otro', email: 'bob@example.test', nombre: 'Bob', actionUrl
  }, resend.client);
  assert.equal(invalid.success, false);
  assert.equal(resend.messages.length, 1);
});
