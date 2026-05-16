// ===== COMPONENTS: POST-CARD.JS =====
// 2025-05-15 — Adicionado badge de curso/período do autor abaixo do nome.

const TYPE_ICONS = {
  doubt:       '❓',
  material:    '📚',
  achievement: '🏆',
  flashcard:   '🃏',
};

const TYPE_LABELS = {
  doubt:       'Dúvida',
  material:    'Material',
  achievement: 'Conquista',
  flashcard:   'Flashcard',
};

const PERIOD_LABELS = {
  matutino:   'Mat.',
  vespertino: 'Vesp.',
  noturno:    'Not.',
  integral:   'Int.',
  ead:        'EaD',
};

export function renderPostCard(post, currentUid) {
  const icon    = TYPE_ICONS[post.type]  || '📝';
  const label   = TYPE_LABELS[post.type] || post.type;
  const author  = escapeHtml(post.authorName || 'Usuário');
  const content = escapeHtml(post.content || '');
  const createdAt = _formatDate(post.createdAt);
  const isOwn   = post.authorId === currentUid;

  // Badge acadêmico do autor
  let academicBadge = '';
  if (post.courseId && post.period) {
    const sigla = post.courseSigla || post.courseId;
    const per   = PERIOD_LABELS[post.period] || post.period;
    const sem   = post.semester ? `${post.semester}º · ` : '';
    academicBadge = `<span class="post-academic-badge">${escapeHtml(sigla)} · ${sem}${escapeHtml(per)}</span>`;
  }

  // Likes: usa array de UIDs
  const likesUids  = post.likes_uids || [];
  const likeCount  = likesUids.length;
  const alreadyLiked = currentUid ? likesUids.includes(currentUid) : false;
  const likeDisabled = alreadyLiked ? 'disabled style="opacity:.5;cursor:default"' : '';

  return `
    <div class="post-card" data-post-id="${post.id}">
      <div class="post-card-header">
        <div class="post-card-avatar">${author.slice(0, 2).toUpperCase()}</div>
        <div class="post-card-meta">
          <span class="post-card-author">${author}</span>
          ${academicBadge}
          <span class="post-card-date">${createdAt}</span>
        </div>
        <span class="post-card-type-badge">${icon} ${label}</span>
      </div>
      <div class="post-card-body">${content}</div>
      <div class="post-card-actions">
        <button class="post-action-btn" onclick="window.likePost('${post.id}', this)" ${likeDisabled}>
          ❤️ <span class="post-like-count">${likeCount}</span>
        </button>
        <button class="post-action-btn" onclick="window.openReplyModal('${post.id}')">
          💬 Responder
        </button>
        ${!isOwn ? `<button class="post-action-btn post-report-btn" onclick="window.openReportModal('${post.id}')">🚩</button>` : ''}
      </div>
    </div>
  `;
}

// ── Like num post ──────────────────────────────────────────────────────────────
window.likePost = async function(postId, btn) {
  if (btn?.disabled) return;
  try {
    const { db, auth } = await import('../firebase.js');
    const user = auth.currentUser;
    if (!user) return;

    const { doc, updateDoc, arrayUnion, addDoc, collection, getDoc } =
      await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

    await updateDoc(doc(db, 'posts', postId), {
      likes_uids: arrayUnion(user.uid),
    });

    // Atualiza UI imediatamente
    const countEl = btn?.querySelector('.post-like-count');
    if (countEl) countEl.textContent = String(parseInt(countEl.textContent || '0') + 1);
    if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.style.cursor = 'default'; }

    // Notifica autor (sem notificar a si mesmo)
    const postSnap = await getDoc(doc(db, 'posts', postId));
    if (postSnap.exists() && postSnap.data().authorId !== user.uid) {
      await addDoc(collection(db, 'notifications', postSnap.data().authorId, 'items'), {
        type: 'like',
        fromUser: user.uid,
        fromUserName: user.displayName || user.email?.split('@')[0] || '',
        postId,
        read: false,
        createdAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error('[post-card] Erro ao curtir:', err);
  }
};

// ── Modal de resposta ──────────────────────────────────────────────────────────
window.openReplyModal = function(postId) {
  const overlay = document.getElementById('modal-overlay');
  const body    = document.getElementById('modal-body');
  if (!overlay || !body) return;

  body.innerHTML = `
    <div class="modal-header"><h3>💬 Responder ao Post</h3></div>
    <div class="modal-form">
      <div class="form-group">
        <textarea id="reply-content" class="form-input" rows="3" placeholder="Sua resposta..."></textarea>
      </div>
      <button class="btn-primary" onclick="window.submitReply('${postId}')">Enviar</button>
    </div>
  `;
  overlay.classList.add('active');
  document.getElementById('modal-container')?.classList.add('active');
};

window.submitReply = async function(postId) {
  const content = document.getElementById('reply-content')?.value?.trim();
  if (!content) return;

  try {
    const { auth, db } = await import('../firebase.js');
    const user = auth.currentUser;
    const { doc, updateDoc, arrayUnion, addDoc, collection, getDoc } =
      await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

    await updateDoc(doc(db, 'posts', postId), {
      replies: arrayUnion({
        authorId:   user.uid,
        authorName: user.displayName || user.email.split('@')[0],
        content,
        createdAt:  new Date().toISOString(),
      }),
    });
    window.closeModal?.();

    const postSnap = await getDoc(doc(db, 'posts', postId));
    if (postSnap.exists() && postSnap.data().authorId !== user.uid) {
      await addDoc(collection(db, 'notifications', postSnap.data().authorId, 'items'), {
        type: 'reply', fromUser: user.uid,
        fromUserName: user.displayName || user.email?.split('@')[0] || '',
        postId, read: false,
        createdAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error('[post-card] Erro ao responder:', err);
  }
};

// ── CSS do badge acadêmico ─────────────────────────────────────────────────────
(function _injectBadgeStyle() {
  if (document.getElementById('post-academic-badge-style')) return;
  const style = document.createElement('style');
  style.id = 'post-academic-badge-style';
  style.textContent = `
    .post-academic-badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      color: var(--accent, #7c5cfc);
      background: rgba(124,92,252,.12);
      border-radius: 10px;
      padding: 1px 7px;
      margin-top: 1px;
    }
    .post-card-meta {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
  `;
  document.head.appendChild(style);
})();

function _formatDate(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
