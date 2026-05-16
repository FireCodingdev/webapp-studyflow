// ===== SOCIAL: FEED.JS =====
// 2025-05-15 — Refatorado: queries duplas por curso/período, campos acadêmicos
// nos posts, seções separadas "Da sua turma" e "Comunidade".

import { db, auth } from '../firebase.js';
import { renderPostCard } from '../components/post-card.js';
import {
  collection, query, orderBy, limit, onSnapshot,
  addDoc, serverTimestamp, where, getDocs, getDoc, doc,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

import { loadFullAcademicProfile, FACAPE_COURSES } from './turmas.js';

let _feedUnsubscribe = null;

export function initFeed(STATE, helpers) {
  window._renderFeed = renderFeed;
}

// ── Carrega perfil acadêmico do usuário atual ─────────────────────────────────
async function _getMyAcademicProfile(uid) {
  try {
    return await loadFullAcademicProfile(uid);
  } catch { return null; }
}

// ── Renderiza o feed (duas seções: turma e comunidade) ────────────────────────
export async function renderFeed() {
  const container = document.getElementById('social-feed-list');
  if (!container) return;
  container.innerHTML = `<div class="feed-loading">⏳ Carregando posts...</div>`;

  if (_feedUnsubscribe) { _feedUnsubscribe(); _feedUnsubscribe = null; }

  const user = auth.currentUser;
  if (!user) {
    container.innerHTML = `<p class="feed-empty">Faça login para ver o feed.</p>`;
    return;
  }

  const profile = await _getMyAcademicProfile(user.uid);

  if (!profile?.courseId) {
    // Sem perfil: mostra feed público geral
    _subscribePublicFeed(container, user.uid);
    return;
  }

  // Com perfil: carrega duas queries e mescla
  _subscribeAcademicFeed(container, user.uid, profile);
}

function _subscribePublicFeed(container, uid) {
  const q = query(
    collection(db, 'posts'),
    where('visibility', '==', 'public'),
    orderBy('createdAt', 'desc'),
    limit(30)
  );
  _feedUnsubscribe = onSnapshot(q, (snap) => {
    if (snap.empty) {
      container.innerHTML = `<div class="feed-empty">Nenhum post ainda. Seja o primeiro! 🚀</div><button class="fab-post" onclick="window.openNewPostModal()">✏️ Novo post</button>`;
      return;
    }
    const posts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    container.innerHTML = `
      <div class="feed-section-label community">🌍 Comunidade</div>
      ${posts.map(p => renderPostCard(p, uid)).join('')}
      <button class="fab-post" onclick="window.openNewPostModal()">✏️ Novo post</button>
    `;
  }, (err) => {
    console.error('[feed] Erro:', err);
    container.innerHTML = `<div class="feed-empty">Erro ao carregar. Verifique sua conexão.</div>`;
  });
}

function _subscribeAcademicFeed(container, uid, profile) {
  let turmaPostsCache = [];
  let communityPostsCache = [];
  let unsubTurma = null;
  let unsubComm  = null;

  function _render() {
    // Mescla e deduplica por id
    const all = [...turmaPostsCache];
    const turmaIds = new Set(turmaPostsCache.map(p => p.id));
    communityPostsCache.forEach(p => { if (!turmaIds.has(p.id)) all.push(p); });

    if (!all.length) {
      container.innerHTML = `<div class="feed-empty">Nenhum post ainda. Seja o primeiro! 🚀</div><button class="fab-post" onclick="window.openNewPostModal()">✏️ Novo post</button>`;
      return;
    }

    const turma     = turmaPostsCache.slice().sort((a, b) => _ts(b) - _ts(a));
    const community = communityPostsCache
      .filter(p => !turmaIds.has(p.id))
      .sort((a, b) => _ts(b) - _ts(a));

    let html = '';
    if (turma.length) {
      html += `<div class="feed-section-label turma">📌 Da sua turma</div>`;
      html += turma.map(p => renderPostCard(p, uid)).join('');
    }
    if (community.length) {
      html += `<div class="feed-section-label community">🌍 Comunidade</div>`;
      html += community.map(p => renderPostCard(p, uid)).join('');
    }
    html += `<button class="fab-post" onclick="window.openNewPostModal()">✏️ Novo post</button>`;

    container.innerHTML = html;
  }

  // Query 1: posts do mesmo curso + período
  const qTurma = query(
    collection(db, 'posts'),
    where('courseId', '==', profile.courseId),
    where('period',   '==', profile.period),
    orderBy('createdAt', 'desc'),
    limit(20)
  );
  unsubTurma = onSnapshot(qTurma, (snap) => {
    turmaPostsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _render();
  }, (err) => {
    console.warn('[feed] Query turma error (índice faltando?):', err.message);
    // Fallback: sem filtro de turma
    turmaPostsCache = [];
    _render();
  });

  // Query 2: posts públicos gerais
  const qComm = query(
    collection(db, 'posts'),
    where('visibility', '==', 'public'),
    orderBy('createdAt', 'desc'),
    limit(30)
  );
  unsubComm = onSnapshot(qComm, (snap) => {
    communityPostsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _render();
  }, (err) => {
    console.error('[feed] Query community error:', err);
  });

  // Agrupa os dois unsubs em um único
  _feedUnsubscribe = () => { unsubTurma?.(); unsubComm?.(); };
}

function _ts(post) {
  if (!post.createdAt) return 0;
  return post.createdAt.toDate ? post.createdAt.toDate().getTime() : new Date(post.createdAt).getTime();
}

// ── Publicar novo post (com campos acadêmicos) ────────────────────────────────
export async function publishPost({ type, content, subjectId, visibility }) {
  const user = auth.currentUser;
  if (!user || !content?.trim()) return null;

  const profile = await _getMyAcademicProfile(user.uid);
  const course  = FACAPE_COURSES.find(c => c.id === profile?.courseId);

  try {
    const ref = await addDoc(collection(db, 'posts'), {
      authorId:    user.uid,
      authorName:  user.displayName || user.email.split('@')[0],
      type:        type || 'doubt',
      content:     content.trim(),
      subjectId:   subjectId || '',
      likes:       0,
      replies:     [],
      visibility:  visibility || 'public',
      createdAt:   serverTimestamp(),
      // Campos acadêmicos do autor
      institution: profile?.institution || '',
      courseId:    profile?.courseId    || '',
      course:      profile?.course      || '',
      courseSigla: course?.sigla        || '',
      semester:    profile?.semester    || 0,
      period:      profile?.period      || '',
    });
    return ref.id;
  } catch (err) {
    console.error('[feed] Erro ao publicar:', err);
    return null;
  }
}

// ── Modal: novo post ──────────────────────────────────────────────────────────
window.openNewPostModal = async function() {
  const overlay = document.getElementById('modal-overlay');
  const body    = document.getElementById('modal-body');
  if (!overlay || !body) return;

  const user = auth.currentUser;
  if (!user) return;

  // Carrega matérias do perfil para o seletor
  const profile = await _getMyAcademicProfile(user.uid);
  const subjects = profile?.subjects || [];

  const subjectOptions = subjects.length
    ? `<option value="">Nenhuma (geral)</option>` +
      subjects.map(s => `<option value="${_esc(s.name)}">${_esc(s.name)}</option>`).join('')
    : `<option value="">Sem matérias configuradas</option>`;

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
        <label class="form-label">Matéria vinculada (opcional)</label>
        <select id="post-subject" class="form-input">
          ${subjectOptions}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Visibilidade</label>
        <select id="post-visibility" class="form-input">
          <option value="public">🌍 Público</option>
          <option value="connections">👥 Conexões</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Conteúdo</label>
        <textarea id="post-content" class="form-input" rows="4"
          placeholder="Compartilhe uma dúvida, material ou conquista..."></textarea>
      </div>
      <button class="btn-primary" onclick="window.submitNewPost()">Publicar</button>
    </div>
  `;
  overlay.classList.add('active');
  document.getElementById('modal-container')?.classList.add('active');
};

window.submitNewPost = async function() {
  const type       = document.getElementById('post-type')?.value;
  const subjectId  = document.getElementById('post-subject')?.value;
  const visibility = document.getElementById('post-visibility')?.value;
  const content    = document.getElementById('post-content')?.value;
  if (!content?.trim()) return;

  const id = await publishPost({ type, content, subjectId, visibility });
  window.closeModal?.();
  if (id) {
    renderFeed();
    const toastEl = document.getElementById('toast');
    if (toastEl) {
      toastEl.textContent = '✅ Post publicado!';
      toastEl.classList.add('show');
      setTimeout(() => toastEl.classList.remove('show'), 2500);
    }
  }
};

function _esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── CSS das seções do feed ────────────────────────────────────────────────────
(function _injectFeedStyles() {
  if (document.getElementById('feed-section-styles')) return;
  const style = document.createElement('style');
  style.id = 'feed-section-styles';
  style.textContent = `
    .feed-section-label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .04em;
      padding: 10px 4px 6px;
      color: var(--text-muted, #888);
      text-transform: uppercase;
    }
    .feed-section-label::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--border, #2a2a3e);
    }
    .feed-section-label.turma    { color: var(--accent, #7c5cfc); }
    .feed-section-label.community { color: #888; }
    .fab-post {
      display: block;
      margin: 12px auto 0;
      padding: 10px 22px;
      background: var(--accent, #7c5cfc);
      color: #fff;
      border: none;
      border-radius: 24px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      position: sticky;
      bottom: 16px;
      box-shadow: 0 4px 16px rgba(124,92,252,.4);
      transition: opacity .15s;
      z-index: 10;
    }
    .fab-post:hover { opacity: .88; }
  `;
  document.head.appendChild(style);
})();