// ===== SOCIAL: MODERATION.JS =====
// Denúncias e filtros de conteúdo — NOVO MÓDULO

import { db, auth } from '../firebase.js';

// CORREÇÃO: import estático no lugar de top-level await
import {
  addDoc, collection, serverTimestamp, updateDoc, doc, increment,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ---- Palavras básicas de filtro local (client-side) ----
const BLOCKED_WORDS = [
  'spam', 'golpe', 'fraude', 'scam', 'cassino', 'apostas',
];

// ---- Verificar conteúdo antes de publicar ----
export function checkContentLocal(text) {
  const lower = text.toLowerCase();
  const found = BLOCKED_WORDS.filter(w => lower.includes(w));
  return { clean: found.length === 0, flaggedWords: found };
}

// ---- Denunciar um post ----
export async function reportPost(postId, reason) {
  const user = auth.currentUser;
  if (!user) return false;

  try {
    await addDoc(collection(db, 'reports'), {
      postId,
      reportedBy: user.uid,
      reason: reason || 'inappropriate',
      createdAt: serverTimestamp(),
      status: 'pending',  // "pending" | "reviewed" | "dismissed"
    });

    // Incrementa contador de denúncias no post
    await updateDoc(doc(db, 'posts', postId), {
      reportCount: increment(1),
    });

    return true;
  } catch (err) {
    console.error('[moderation] Erro ao denunciar:', err);
    return false;
  }
}

// ---- Modal de denúncia ----
window.openReportModal = function(postId) {
  const overlay = document.getElementById('modal-overlay');
  const body = document.getElementById('modal-body');
  if (!overlay || !body) return;

  body.innerHTML = `
    <div class="modal-header"><h3>🚩 Denunciar Post</h3></div>
    <div class="modal-form">
      <div class="form-group">
        <label class="form-label">Motivo</label>
        <select id="report-reason" class="form-input">
          <option value="spam">Spam / Publicidade</option>
          <option value="inappropriate">Conteúdo inapropriado</option>
          <option value="harassment">Assédio</option>
          <option value="misinformation">Informação falsa</option>
          <option value="other">Outro</option>
        </select>
      </div>
      <button class="btn-primary" onclick="window.submitReport('${postId}')">Enviar Denúncia</button>
    </div>
  `;
  overlay.classList.add('active');
  document.getElementById('modal-container')?.classList.add('active');
};

window.submitReport = async function(postId) {
  const reason = document.getElementById('report-reason')?.value;
  const ok = await reportPost(postId, reason);
  window.closeModal?.();
  const toastEl = document.getElementById('toast');
  if (toastEl) {
    toastEl.textContent = ok ? '🚩 Denúncia enviada. Obrigado!' : '❌ Erro ao enviar denúncia.';
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), 2500);
  }
};
