// ===== COMPONENTS: POST-CARD.JS =====
// Card de post do feed — NOVO COMPONENTE UI reutilizável

const TYPE_ICONS = {
  doubt: '❓',
  material: '📚',
  achievement: '🏆',
  flashcard: '🃏',
};

const TYPE_LABELS = {
  doubt: 'Dúvida',
  material: 'Material',
  achievement: 'Conquista',
  flashcard: 'Flashcard',
};

// ---- Renderiza HTML string de um post ----
export function renderPostCard(post, currentUid) {
  const icon = TYPE_ICONS[post.type] || '📝';
  const label = TYPE_LABELS[post.type] || post.type;
  const author = escapeHtml(post.authorName || 'Usuário');
  const content = escapeHtml(post.content || '');
  const createdAt = _formatDate(post.createdAt);
  const isOwn = post.authorId === currentUid;

  return `
    <div class="post-card" data-post-id="${post.id}">
      <div class="post-card-header">
        <div class="post-card-avatar">${author.slice(0, 2).toUpperCase()}</div>
        <div class="post-card-meta">
          <span class="post-card-author">${author}</span>
          <span class="post-card-date">${createdAt}</span>
        </div>
        <span class="post-card-type-badge">${icon} ${label}</span>
      </div>
      <div class="post-card-body">${content}</div>
      <div class="post-card-actions">
        <button class="post-action-btn" onclick="window.likePost('${post.id}', this)">
          ❤️ <span class="post-like-count">${post.likes || 0}</span>
        </button>
        <button class="post-action-btn" onclick="window.openReplyModal('${post.id}')">
          💬 Responder
        </button>
        ${!isOwn ? `<button class="post-action-btn post-report-btn" onclick="window.openReportModal('${post.id}')">🚩</button>` : ''}
      </div>
    </div>
  `;
}

// ---- Like num post ----
window.likePost = async function(postId, btn) {
  try {
    const { db } = await import('../firebase.js');
    const { doc, updateDoc, increment } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    await updateDoc(doc(db, 'posts', postId), { likes: increment(1) });
    const countEl = btn?.querySelector('.post-like-count');
    if (countEl) countEl.textContent = String(parseInt(countEl.textContent || '0') + 1);
  } catch (err) {
    console.error('[post-card] Erro ao curtir:', err);
  }
};

// ---- Modal de resposta ----
window.openReplyModal = function(postId) {
  const overlay = document.getElementById('modal-overlay');
  const body = document.getElementById('modal-body');
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
    const { doc, updateDoc, arrayUnion, serverTimestamp } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    await updateDoc(doc(db, 'posts', postId), {
      replies: arrayUnion({
        authorId: user.uid,
        authorName: user.displayName || user.email.split('@')[0],
        content,
        createdAt: new Date().toISOString(),
      }),
    });
    window.closeModal?.();

    // Notifica o autor do post
    const { addDoc, collection } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const postSnap = await (await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js')).getDoc(
      doc(db, 'posts', postId)
    );
    if (postSnap.exists() && postSnap.data().authorId !== user.uid) {
      await addDoc(collection(db, 'notifications', postSnap.data().authorId, 'items'), {
        type: 'reply', fromUser: user.uid, postId, read: false,
        createdAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error('[post-card] Erro ao responder:', err);
  }
};

function _formatDate(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
