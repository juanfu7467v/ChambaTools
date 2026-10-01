// Compatibilidad explícita con Firebase Admin SDK modular (v14+).
// El proyecto histórico usa la API namespaced `admin.*`; esta fachada evita
// que una actualización del SDK rompa el arranque o la verificación de tokens.
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const auth = () => getAuth();
const firestore = Object.assign(() => getFirestore(), { FieldValue });

const admin = {
  cert,
  getApps,
  initializeApp,
  auth,
  firestore,
  credential: { cert }
};

export default admin;
