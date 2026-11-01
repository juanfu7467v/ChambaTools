import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ACTION_EMAILS = {
  verificacion: {
    file: 'verificacion-correo.html',
    subject: 'Confirma tu correo electrónico en FacilitoTools'
  },
  restablecimiento: {
    file: 'restablecer-contrasena.html',
    subject: 'Restablece tu contraseña de FacilitoTools'
  }
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function renderActionEmail(templateName, replacements) {
  const templatePath = path.join(__dirname, 'emails', templateName);
  let html = fs.readFileSync(templatePath, 'utf8');
  for (const [key, value] of Object.entries(replacements)) {
    html = html.replace(new RegExp(`{{${key}}}`, 'g'), () => String(value));
  }
  return html;
}

/** Sends a Firebase Admin-generated action link through the existing Resend client. */
export async function enviarCorreoAccionFirebase({ tipo, email, nombre, actionUrl }, resend) {
  const template = ACTION_EMAILS[tipo];
  if (!template) return { success: false, error: 'Tipo de correo de acción no válido.' };
  if (!resend) return { success: false, error: 'El servicio de correo no está configurado.' };
  if (!email || !actionUrl) return { success: false, error: 'Faltan datos del correo de acción.' };

  try {
    const html = renderActionEmail(template.file, {
      nombre: escapeHtml(nombre || email.split('@')[0]),
      action_url: escapeHtml(actionUrl)
    });
    const { data, error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'FacilitoTools <noreply@facilitotools.com>',
      to: email,
      subject: template.subject,
      html
    });
    if (error) throw error;
    return { success: true, messageId: data?.id };
  } catch (error) {
    return { success: false, error: String(error?.message || error?.error || 'No se pudo enviar el correo.') };
  }
}
