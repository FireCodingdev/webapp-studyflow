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

export { auth, db };

// ===== SYNC FUNCTIONS =====

export async function syncToFirestore(userId, data) {
  try {
    // Incluindo flashcards na sincronização para evitar perda de dados
    await setDoc(doc(db, 'users', userId), {
      subjects: data.subjects || [],
      classes: data.classes || [],
      tasks: data.tasks || [],
      flashcards: data.flashcards || [],
      updatedAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    console.error('Erro ao sincronizar:', err);
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