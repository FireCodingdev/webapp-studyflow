// ===== FIREBASE CONFIG & INIT =====
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updateProfile,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
  initializeAppCheck,
  ReCaptchaV3Provider,
  getToken as getAppCheckToken_,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-check.js';

const firebaseConfig = {
  apiKey: "AIzaSyC8IqRSiaaS6Vk6IHm-JQeK4MdMqPZVkP0",
  authDomain: "aplicativo-studyflow-4f501.firebaseapp.com",
  projectId: "aplicativo-studyflow-4f501",
  storageBucket: "aplicativo-studyflow-4f501.firebasestorage.app",
  messagingSenderId: "92968084905",
  appId: "1:92968084905:web:f5a96cb595f1bd2f9750b8"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Observação: alguns ambientes/CDNs podem não expor APIs avançadas de cache
// em todas as versões. Para máxima compatibilidade em hospedagem estática,
// usamos o Firestore padrão.
const db = getFirestore(app);

// ── App Check (reCAPTCHA v3) ─────────────────────────────────────────────────
// Obtenha a site key em: Firebase Console → App Check → Apps → Registrar app →
// selecione reCAPTCHA v3 → copie a "Site key" gerada no Google reCAPTCHA Admin.
const appCheck = initializeAppCheck(app, {
  provider: new ReCaptchaV3Provider('6LfaU-wsAAAAAFK9CM50OV0r04yMZBLmtpPwJHKn'),
  isTokenAutoRefreshEnabled: true,
});

// Retorna o token atual do App Check (string vazia em caso de falha).
export async function getAppCheckToken() {
  try {
    const result = await getAppCheckToken_(appCheck, false);
    return result.token;
  } catch {
    return '';
  }
}

export { auth, db, appCheck };

// ===== SYNC FUNCTIONS =====

export async function syncToFirestore(userId, data) {
  try {
    await setDoc(doc(db, 'users', userId), {
      subjects: data.subjects || [],
      classes: data.classes || [],
      tasks: data.tasks || [],
      flashcards: data.flashcards || [],
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    return true;
  } catch (err) {
    // Loga o código de erro para diagnóstico (ex: permission-denied, unavailable)
    console.error('Erro ao sincronizar:', err.code, err.message);
    return false;
  }
}

export async function loadFromFirestore(userId) {
  const snap = await getDoc(doc(db, 'users', userId));
  if (snap.exists()) return snap.data();
  return null;
}

// ===== AUTH FUNCTIONS =====
export async function loginUser(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function registerUser(email, password, name) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(cred.user, { displayName: name });
  return cred.user;
}

export async function logoutUser() {
  await signOut(auth);
}

export { onAuthStateChanged };