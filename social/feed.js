// ===== SOCIAL: FEED.JS =====
// Skeleton loading, pull-to-refresh, image upload, pagination, reputation +1

import { db, auth, storage, ref, uploadBytes, getDownloadURL } from '../firebase.js';
import { renderPostCard } from '../components/post-card.js';
import {
  collection, query, orderBy, limit, startAfter,
  onSnapshot, addDoc, serverTimestamp, where, getDocs, getDoc, doc, increment, updateDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { loadFullAcademicProfile, inferAcademicProfile, FACAPE_COURSES } from './turmas.js';

let _feedUnsubscribe   = null;
let _lastTurmaDoc      = null;
let _lastCommunityDoc  = null;
let _pendingImageFile  = null;

export function initFeed() {
  window._renderFeed = renderFeed;
}

async function _getMyProfile(uid) {
  try {
    const saved = await loadFullAcademicProfile(uid);
    return inferAcademicProfile(saved || {});
  } catch { return null; }
}

// ── Skeleton loading ───────────────────────────────────────────────────────────
function _skeleton() {
  return Array(3).fill(0).map(() => `
    <div class="skeleton-card">
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px">
        <div class="skeleton-circle"></div>
        <div style="flex:1">
          <div class="skeleton-line" style="width:50%;margin-bottom:6px"></div>
          <div class="skeleton-line" style="width:30%"></div>
        </div>
      </div>
      <div class="skeleton-line" style="width:100%;margin-bottom:6px"></div>
      <div class="skeleton-line" style="width:85%;margin-bottom:6px"></div>
      <div class="skeleton-line" style="width:65%"></div>
    </div>
  `).join('');
}

// ── Render principal ───────────────────────────────────────────────────────────
export async function renderFeed() {
  const container = document.getElementById('social-feed-list');
  if (!container) return;

  container.innerHTML = _skeleton();
  _initPullToRefresh(container, renderFeed);

  if (_feedUnsubscribe) { _feedUnsubscribe(); _feedUnsubscribe = null; }

  // Aguarda auth se ainda não inicializou (firebase pode estar restaurando sessão)
  let user = auth.currentUser;
  if (!user) {
    user = await new Promise(resolve => {
      const unsub = auth.onAuthStateChanged(u => { unsub(); resolve(u); });
    });
  }
  if (!user) {
    container.innerHTML = `<p class="feed-empty">Faça login para ver o feed.</p>`;
    return;
  }

  const profile = await _getMyProfile(user.uid);

  if (!profile?.courseId) {
    _subscribePublicFeed(container, user.uid);
  } else {
    _subscribeAcademicFeed(container, user.uid, profile);
  }
}

// ── Feed público (sem perfil acadêmico) ───────────────────────────────────────
function _subscribePublicFeed(container, uid) {
  const q = query(
    collection(db, 'posts'),
    where('visibility', '==', 'public'),
    orderBy('createdAt', 'desc'),
    limit(20)
  );

  _feedUnsubscribe = onSnapshot(q, (snap) => {
    _lastCommunityDoc = snap.docs[snap.docs.length - 1] || null;
    if (snap.empty) {
      container.innerHTML = `
        <div class="feed-empty">Nenhum post ainda. Seja o primeiro! 🚀</div>
        ${_newPostBtn()}`;
      return;
    }
    const posts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    container.innerHTML = `
      <div class="feed-section-label community">🌍 Comunidade</div>
      ${posts.map(p => renderPostCard(p, uid)).join('')}
      ${_loadMoreBtn('community')}
      ${_newPostBtn()}`;
  }, (err) => {
    console.error('[feed]', err);
    container.innerHTML = `<div class="feed-empty">Erro ao carregar. Verifique sua conexão.</div>`;
  });
}

// ── Feed acadêmico (duas seções) ──────────────────────────────────────────────
function _subscribeAcademicFeed(container, uid, profile) {
  let turmaCache     = [];
  let communityCache = [];
  let unsubTurma, unsubComm;

  function _render() {
    const turmaIds = new Set(turmaCache.map(p => p.id));
    const turma    = [...turmaCache].sort((a, b) => _ts(b) - _ts(a));
    const comm     = communityCache
      .filter(p => !turmaIds.has(p.id))
      .sort((a, b) => _ts(b) - _ts(a));

    if (!turma.length && !comm.length) {
      container.innerHTML = `
        <div class="feed-empty">Nenhum post ainda. Seja o primeiro! 🚀</div>
        ${_newPostBtn()}`;
      return;
    }

    let html = '';
    if (turma.length) {
      html += `<div class="feed-section-label turma">📌 Da sua turma</div>`;
      html += turma.map(p => renderPostCard(p, uid)).join('');
      html += _loadMoreBtn('turma');
    }
    if (comm.length) {
      html += `<div class="feed-section-label community">🌍 Comunidade</div>`;
      html += comm.map(p => renderPostCard(p, uid)).join('');
      html += _loadMoreBtn('community');
    }
    html += _newPostBtn();
    container.innerHTML = html;
  }

  const qTurma = query(
    collection(db, 'posts'),
    where('courseId', '==', profile.courseId),
    where('period',   '==', profile.period),
    orderBy('createdAt', 'desc'),
    limit(20)
  );
  unsubTurma = onSnapshot(qTurma, (snap) => {
    _lastTurmaDoc  = snap.docs[snap.docs.length - 1] || null;
    turmaCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _render();
  }, (err) => {
    console.warn('[feed] turma query:', err.message);
    turmaCache = [];
    _render();
  });

  const qComm = query(
    collection(db, 'posts'),
    where('visibility', '==', 'public'),
    orderBy('createdAt', 'desc'),
    limit(30)
  );
  unsubComm = onSnapshot(qComm, (snap) => {
    _lastCommunityDoc = snap.docs[snap.docs.length - 1] || null;
    communityCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _render();
  }, (err) => {
    console.error('[feed] community query:', err);
  });

  _feedUnsubscribe = () => { unsubTurma?.(); unsubComm?.(); };
}

// ── Carregar mais (paginação) ─────────────────────────────────────────────────
window.loadMoreFeedPosts = async function(section) {
  const cursor = section === 'turma' ? _lastTurmaDoc : _lastCommunityDoc;
  if (!cursor) return;

  const uid    = auth.currentUser?.uid;
  const btn    = document.getElementById(`load-more-${section}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Carregando…'; }

  try {
    let q;
    if (section === 'turma') {
      const profile = await _getMyProfile(uid);
      if (!profile?.courseId) return;
      q = query(
        collection(db, 'posts'),
        where('courseId', '==', profile.courseId),
        where('period',   '==', profile.period),
        orderBy('createdAt', 'desc'),
        startAfter(cursor), limit(15)
      );
    } else {
      q = query(
        collection(db, 'posts'),
        where('visibility', '==', 'public'),
        orderBy('createdAt', 'desc'),
        startAfter(cursor), limit(20)
      );
    }

    const snap = await getDocs(q);
    if (snap.empty) {
      if (btn) { btn.textContent = '— Sem mais posts —'; btn.disabled = true; }
      return;
    }

    if (section === 'turma') _lastTurmaDoc = snap.docs[snap.docs.length - 1];
    else _lastCommunityDoc = snap.docs[snap.docs.length - 1];

    const morePosts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const moreHtml  = morePosts.map(p => renderPostCard(p, uid)).join('');
    btn?.insertAdjacentHTML('beforebegin', moreHtml);
    if (btn) { btn.disabled = false; btn.textContent = '⬇ Carregar mais'; }
  } catch (err) {
    console.error('[feed] loadMore:', err);
    if (btn) { btn.disabled = false; btn.textContent = '⬇ Carregar mais'; }
  }
};

// ── Publicar post ─────────────────────────────────────────────────────────────
export async function publishPost({ type, content, subjectId, visibility, imageFile }) {
  const user = auth.currentUser;
  if (!user || !content?.trim()) return null;

  const profile = await _getMyProfile(user.uid);
  const course  = FACAPE_COURSES.find(c => c.id === profile?.courseId);

  let imageUrl = '';
  if (imageFile) {
    try {
      const imgRef = ref(storage, `post_images/${user.uid}_${Date.now()}`);
      await uploadBytes(imgRef, imageFile);
      imageUrl = await getDownloadURL(imgRef);
    } catch (err) {
      console.warn('[feed] upload imagem:', err);
    }
  }

  try {
    const postRef = await addDoc(collection(db, 'posts'), {
      authorId:    user.uid,
      authorName:  user.displayName || user.email.split('@')[0],
      type:        type || 'doubt',
      content:     content.trim(),
      subjectId:   subjectId || '',
      likes_uids:  [],
      replies:     [],
      visibility:  visibility || 'public',
      createdAt:   serverTimestamp(),
      institution: profile?.institution || '',
      courseId:    profile?.courseId    || '',
      course:      profile?.course      || '',
      courseSigla: course?.sigla        || '',
      semester:    profile?.semester    || 0,
      period:      profile?.period      || '',
      ...(imageUrl ? { imageUrl } : {}),
    });

    // +1 reputação para o autor
    updateDoc(doc(db, 'users', user.uid), { 'social.reputation': increment(1) }).catch(() => {});

    return postRef.id;
  } catch (err) {
    console.error('[feed] Erro ao publicar:', err);
    return null;
  }
}

// ── Modal: novo post ──────────────────────────────────────────────────────────
window.openNewPostModal = async function() {
  const user = auth.currentUser;
  if (!user) return;

  _pendingImageFile = null;

  const profile  = await _getMyProfile(user.uid);
  const subjects = profile?.subjects || [];
  const subjectOpts = subjects.length
    ? `<option value="">Nenhuma (geral)</option>` +
      subjects.map(s => `<option value="${_esc(s.name)}">${_esc(s.name)}</option>`).join('')
    : `<option value="">Sem matérias configuradas</option>`;

  const typeColors = { doubt:'#f39c12', material:'#4a9eff', achievement:'#2ed573', flashcard:'#a29bfe' };

  const bodyHtml = `
    <div class="modal-form">
      <div class="form-group">
        <label class="form-label">Tipo</label>
        <div class="post-type-grid" id="post-type-grid">
          ${Object.entries({ doubt:'❓ Dúvida', material:'📚 Material', achievement:'🏆 Conquista', flashcard:'🃏 Flashcard' })
            .map(([v, lbl], i) => `
              <button type="button" class="post-type-btn${i===0?' selected':''}"
                data-type="${v}" style="--tc:${typeColors[v]}"
                onclick="window._selectPostType(this)">
                ${lbl}
              </button>`).join('')}
        </div>
        <input type="hidden" id="post-type" value="doubt">
      </div>

      <div class="form-group">
        <label class="form-label">Matéria vinculada <span style="opacity:.5">(opcional)</span></label>
        <select id="post-subject" class="form-input">${subjectOpts}</select>
      </div>

      <div class="form-group">
        <label class="form-label">Visibilidade</label>
        <select id="post-visibility" class="form-input">
          <option value="public">🌍 Público (todos)</option>
          ${profile?.courseId ? `<option value="turma">📌 Só minha turma</option>` : ''}
          <option value="connections">👥 Conexões</option>
        </select>
      </div>

      <div class="form-group">
        <label class="form-label">Conteúdo</label>
        <textarea id="post-content" class="form-input" rows="4"
          placeholder="Compartilhe uma dúvida, material ou conquista…"></textarea>
      </div>

      <div class="form-group">
        <label class="form-label">Imagem <span style="opacity:.5">(opcional)</span></label>
        <div class="img-upload-area" onclick="document.getElementById('post-img-input').click()">
          <input type="file" id="post-img-input" accept="image/*" style="display:none"
            onchange="window._handlePostImg(this)">
          <div id="post-img-preview" class="img-placeholder">📷 Clique para adicionar imagem</div>
        </div>
      </div>

      <button class="btn-primary" onclick="window.submitNewPost()">🚀 Publicar</button>
    </div>
  `;

  window.openModal('📝 Novo Post', bodyHtml);
};

window._selectPostType = function(btn) {
  document.querySelectorAll('.post-type-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  const input = document.getElementById('post-type');
  if (input) input.value = btn.dataset.type;
};

window._handlePostImg = function(input) {
  const file = input.files?.[0];
  if (!file) return;
  _pendingImageFile = file;
  const reader = new FileReader();
  reader.onload = e => {
    const preview = document.getElementById('post-img-preview');
    if (preview) {
      preview.innerHTML = `<img src="${e.target.result}"
        style="max-height:180px;border-radius:6px;object-fit:cover;width:100%">
        <span style="display:block;text-align:center;font-size:11px;margin-top:4px;opacity:.5">
          Clique para trocar
        </span>`;
    }
  };
  reader.readAsDataURL(file);
};

window.submitNewPost = async function() {
  const type       = document.getElementById('post-type')?.value;
  const subjectId  = document.getElementById('post-subject')?.value;
  const visibility = document.getElementById('post-visibility')?.value;
  const content    = document.getElementById('post-content')?.value;
  if (!content?.trim()) return;

  const btn = document.querySelector('.modal-form .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Publicando…'; }

  const id = await publishPost({ type, content, subjectId, visibility, imageFile: _pendingImageFile });
  _pendingImageFile = null;
  window.closeModal?.();

  if (id) {
    _toast('✅ Post publicado!');
    renderFeed();
  }
};

// ── Pull-to-refresh ────────────────────────────────────────────────────────────
function _initPullToRefresh(el, onRefresh) {
  let startY = 0;
  let indicator = null;

  el.addEventListener('touchstart', e => {
    if (el.scrollTop <= 0) startY = e.touches[0].clientY;
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    if (!startY) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 50 && el.scrollTop <= 0 && !indicator) {
      indicator = document.createElement('div');
      indicator.className = 'ptr-indicator';
      indicator.textContent = '↓ Solte para atualizar';
      el.prepend(indicator);
    }
  }, { passive: true });

  el.addEventListener('touchend', e => {
    if (!startY) return;
    const dy = e.changedTouches[0].clientY - startY;
    indicator?.remove(); indicator = null;
    if (dy > 80) onRefresh();
    startY = 0;
  }, { passive: true });
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function _ts(post) {
  if (!post.createdAt) return 0;
  return post.createdAt.toDate ? post.createdAt.toDate().getTime() : new Date(post.createdAt).getTime();
}

function _newPostBtn() {
  return `<button class="fab-post" onclick="window.openNewPostModal()">✏️ Novo post</button>`;
}

function _loadMoreBtn(section) {
  return `<button id="load-more-${section}" class="load-more-btn"
    onclick="window.loadMoreFeedPosts('${section}')">⬇ Carregar mais</button>`;
}

function _esc(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function _toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

// ── Estilos injetados ──────────────────────────────────────────────────────────
(function _styles() {
  if (document.getElementById('feed-styles-v2')) return;
  const s = document.createElement('style');
  s.id = 'feed-styles-v2';
  s.textContent = `
    /* ── Seções ── */
    .feed-section-label {
      display: flex; align-items:center; gap:8px;
      font-size: 12px; font-weight:700; letter-spacing:.04em;
      padding: 10px 4px 6px; color: var(--text-muted,#888);
      text-transform: uppercase;
    }
    .feed-section-label::after {
      content:''; flex:1; height:1px; background: var(--border,#2a2a3e);
    }
    .feed-section-label.turma    { color: var(--accent,#7c5cfc); }
    .feed-section-label.community { color: #888; }

    /* ── FAB ── */
    .fab-post {
      display:block; margin:12px auto 0;
      padding:10px 22px; background:var(--accent,#7c5cfc);
      color:#fff; border:none; border-radius:24px;
      font-size:14px; font-weight:700; cursor:pointer;
      position:sticky; bottom:16px;
      box-shadow:0 4px 16px rgba(124,92,252,.4);
      z-index:10; transition:opacity .15s;
    }
    .fab-post:hover { opacity:.88; }

    /* ── Load more ── */
    .load-more-btn {
      display:block; width:100%; margin:8px 0;
      padding:10px; background:rgba(255,255,255,.04);
      border:1px solid var(--border,#2a2a3e);
      border-radius:10px; color:rgba(255,255,255,.5);
      font-size:13px; cursor:pointer; transition:background .15s;
    }
    .load-more-btn:hover:not(:disabled) { background:rgba(255,255,255,.08); color:#fff; }
    .load-more-btn:disabled { opacity:.5; cursor:default; }

    /* ── Skeleton ── */
    .skeleton-card {
      background:rgba(255,255,255,.04);
      border-radius:12px; padding:16px; margin-bottom:12px;
    }
    .skeleton-circle {
      width:36px; height:36px; border-radius:50%;
      background:rgba(255,255,255,.08); flex-shrink:0;
      animation: sk-shine 1.5s infinite;
    }
    .skeleton-line {
      height:11px; border-radius:6px; margin-bottom:6px;
      background: linear-gradient(90deg,
        rgba(255,255,255,.05) 25%,
        rgba(255,255,255,.1) 50%,
        rgba(255,255,255,.05) 75%);
      background-size:200% 100%;
      animation: sk-shine 1.5s infinite;
    }
    @keyframes sk-shine {
      0%   { background-position:200% 0; }
      100% { background-position:-200% 0; }
    }

    /* ── Pull-to-refresh indicator ── */
    .ptr-indicator {
      text-align:center; font-size:12px; color:rgba(255,255,255,.4);
      padding:10px; animation:fadeIn .2s;
    }
    @keyframes fadeIn { from{opacity:0} to{opacity:1} }

    /* ── Post type grid ── */
    .post-type-grid {
      display:grid; grid-template-columns:repeat(2,1fr); gap:6px;
    }
    .post-type-btn {
      padding:8px; border-radius:8px; border:1.5px solid rgba(255,255,255,.1);
      background:rgba(255,255,255,.04); color:rgba(255,255,255,.6);
      font-size:13px; cursor:pointer; transition:all .15s; text-align:left;
    }
    .post-type-btn.selected,
    .post-type-btn:hover {
      border-color:var(--tc,#7c5cfc); color:var(--tc,#7c5cfc);
      background: rgba(124,92,252,.08);
    }

    /* ── Image upload area ── */
    .img-upload-area {
      border:1.5px dashed var(--border,#2a2a3e);
      border-radius:10px; cursor:pointer;
      transition:border-color .15s; overflow:hidden;
    }
    .img-upload-area:hover { border-color:var(--accent,#7c5cfc); }
    .img-placeholder {
      padding:20px; text-align:center;
      font-size:13px; color:rgba(255,255,255,.35);
    }
  `;
  document.head.appendChild(s);
})();
