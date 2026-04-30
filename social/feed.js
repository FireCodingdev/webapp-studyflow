// ===== SOCIAL: FEED.JS =====
// Timeline / Feed Central — NOVO MÓDULO
// Renderiza posts do Firestore na página #page-feed

import { db } from '../firebase.js';
import { renderPostCard } from '../components/post-card.js';

const {
  collection, query, orderBy, limit, onSnapshot,
  addDoc, serverTimestamp, where, getDocs,
} = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

let _feedUnsubscribe = null;
let _feedState = null;

// ---- Inicializa o módulo de Feed ----
export function initFeed(STATE, helpers) {
  _feedState = { STATE, helpers };
  window._initFeed = initFeed;
  window._renderFeed = renderFeed;
}

// ---- Renderiza o feed (chamada pelo navigateTo) ----
export async function renderFeed() {
  const container = document.getElementById('feed-list');
  if (!container) return;
  container.innerHTML = `<div class="feed-loading">⏳ Carregando posts...</div>`;

  // Cancela listener anterior
  if (_feedUnsubscribe) { _feedUnsubscribe(); _feedUnsubscribe = null; }

  const { auth } = await import('../firebase.js');
  const user = auth.currentUser;
  if (!user) { container.innerHTML = `<p class="feed-empty">Faça login para ver o feed.</p>`; return; }

  const postsQuery = query(
    collection(db, 'posts'),
    orderBy('createdAt', 'desc'),
    limit(30)
  );

  _feedUnsubscribe = onSnapshot(postsQuery, (snap) => {
    if (snap.empty) {
      container.innerHTML = `<div class="feed-empty">Nenhum post ainda. Seja o primeiro a compartilhar! 🚀</div>`;
      return;
    }
    const posts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    container.innerHTML = posts.map(p => renderPostCard(p, user.uid)).join('');
  }, (err) => {
    console.error('[feed] Erro ao ouvir posts:', err);
    container.innerHTML = `<div class="feed-empty">Erro ao carregar feed. Verifique sua conexão.</div>`;
  });
}

// ---- Publicar novo post ----
export async function publishPost({ type, content, subjectId, visibility }) {
  const { auth } = await import('../firebase.js');
  const user = auth.currentUser;
  if (!user || !content?.trim()) return null;

  try {
    const ref = await addDoc(collection(db, 'posts'), {
      authorId: user.uid,
      authorName: user.displayName || user.email.split('@')[0],
      type: type || 'doubt',          // "doubt"|"material"|"achievement"|"flashcard"
      content: content.trim(),
      subjectId: subjectId || '',
      likes: 0,
      replies: [],
      visibility: visibility || 'public',
      createdAt: serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    console.error('[feed] Erro ao publicar post:', err);
    return null;
  }
}

// ---- Abrir modal de criação de post ----
window.openNewPostModal = function() {
  const overlay = document.getElementById('modal-overlay');
  const body = document.getElementById('modal-body');
  if (!overlay || !body) return;

  body.innerHTML = `
    <div class="modal-header"><h3>📝 Novo Post</h3></div>
    <div class="modal-form">
      <div class="form-group">
        <label class="form-label">Tipo</label>
        <select id="post-type" class="form-input">
          <option value="doubt">❓ Dúvida</option>
          <option value="material">📚 Material</option>
          <option value="achievement">🏆 Conquista</option>
          <option value="flashcard">🃏 Flashcard</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Visibilidade</label>
        <select id="post-visibility" class="form-input">
          <option value="public">🌍 Público</option>
          <option value="connections">👥 Conexões</option>
          <option value="group">🏫 Grupo</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Conteúdo</label>
        <textarea id="post-content" class="form-input" rows="4" placeholder="Compartilhe uma dúvida, material ou conquista..."></textarea>
      </div>
      <button class="btn-primary" onclick="window.submitNewPost()">Publicar</button>
    </div>
  `;
  overlay.classList.add('active');
  document.getElementById('modal-container')?.classList.add('active');
};

window.submitNewPost = async function() {
  const type = document.getElementById('post-type')?.value;
  const visibility = document.getElementById('post-visibility')?.value;
  const content = document.getElementById('post-content')?.value;
  if (!content?.trim()) return;

  const id = await publishPost({ type, content, visibility });
  window.closeModal?.();
  if (id) {
    renderFeed();
    const toastEl = document.getElementById('toast');
    if (toastEl) { toastEl.textContent = '✅ Post publicado!'; toastEl.classList.add('show'); setTimeout(() => toastEl.classList.remove('show'), 2500); }
  }
};
