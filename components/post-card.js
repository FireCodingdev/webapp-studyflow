// ===== COMPONENTS: POST-CARD.JS =====
// Inline replies, reply likes, accept reply, share, delete, @mention, image

import {
  db, auth, storage, ref, uploadBytes, getDownloadURL,
} from '../firebase.js';
import {
  doc, updateDoc, arrayUnion, addDoc, collection, getDoc, increment, deleteDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const TYPE_ICONS = { doubt:'❓', material:'📚', achievement:'🏆', flashcard:'🃏' };
const TYPE_LABELS = { doubt:'Dúvida', material:'Material', achievement:'Conquista', flashcard:'Flashcard' };
const TYPE_COLORS = { doubt:'#f39c12', material:'#4a9eff', achievement:'#2ed573', flashcard:'#a29bfe' };
const PERIOD_LABELS = { matutino:'Mat.', vespertino:'Vesp.', noturno:'Not.', integral:'Int.', ead:'EaD' };

export function renderPostCard(post, currentUid) {
  const icon    = TYPE_ICONS[post.type]  || '📝';
  const label   = TYPE_LABELS[post.type] || post.type;
  const color   = TYPE_COLORS[post.type] || 'var(--accent,#7c5cfc)';
  const author  = _esc(post.authorName || 'Usuário');
  const content = _renderContent(post.content || '');
  const date    = _fmtDate(post.createdAt);
  const isOwn   = post.authorId === currentUid;

  // Academic badge
  let badge = '';
  if (post.courseId && post.period) {
    const sigla = _esc(post.courseSigla || post.courseId);
    const per   = _esc(PERIOD_LABELS[post.period] || post.period);
    const sem   = post.semester ? `${post.semester}º · ` : '';
    badge = `<span class="post-academic-badge">${sigla} · ${sem}${per}</span>`;
  }

  // Image
  const imageHtml = post.imageUrl
    ? `<div class="post-card-image"><img src="${post.imageUrl}" alt="imagem" loading="lazy"
        onclick="window._viewImage('${post.imageUrl}')"></div>`
    : '';

  // Likes
  const likesUids    = Array.isArray(post.likes_uids) ? post.likes_uids : [];
  const likeCount    = likesUids.length;
  const alreadyLiked = currentUid ? likesUids.includes(currentUid) : false;
  const likeBtn = alreadyLiked
    ? `<button class="post-action-btn post-liked" disabled>❤️ <span class="post-like-count">${likeCount}</span></button>`
    : `<button class="post-action-btn" onclick="window.likePost('${post.id}',this)">❤️ <span class="post-like-count">${likeCount}</span></button>`;

  // Replies
  const replies    = Array.isArray(post.replies) ? post.replies : [];
  const replyCount = replies.length;
  const repliesHtml = replies.map((r, i) => _renderReply(post.id, r, i, currentUid, isOwn)).join('');
  const replyBtnTxt = replyCount > 0
    ? `💬 ${replyCount} resposta${replyCount > 1 ? 's' : ''}`
    : '💬 Responder';

  const ownerActions = isOwn
    ? `<button class="post-action-btn post-delete-btn" onclick="window.deletePost('${post.id}')">🗑</button>`
    : `<button class="post-action-btn post-report-btn" onclick="window.openReportModal?.('${post.id}')">🚩</button>`;

  return `
    <div class="post-card" data-post-id="${post.id}">
      <div class="post-card-header">
        <div class="post-card-avatar" onclick="window.openPublicProfile('${post.authorId}')"
          style="cursor:pointer">${author.slice(0,2).toUpperCase()}</div>
        <div class="post-card-meta">
          <span class="post-card-author" onclick="window.openPublicProfile('${post.authorId}')"
            style="cursor:pointer;text-decoration:underline dotted">${author}</span>
          ${badge}
          <span class="post-card-date">${date}</span>
        </div>
        <span class="post-card-type-badge"
          style="border-color:${color};color:${color}">${icon} ${label}</span>
      </div>
      ${imageHtml}
      <div class="post-card-body">${content}</div>
      <div class="post-card-actions">
        ${likeBtn}
        <button class="post-action-btn" onclick="window.togglePostReplies('${post.id}')">
          ${replyBtnTxt}
        </button>
        <button class="post-action-btn" onclick="window.sharePost('${post.id}')" title="Compartilhar">🔗</button>
        ${ownerActions}
      </div>
      <div class="post-replies-section" id="replies-${post.id}" style="display:none">
        <div class="replies-list" id="replies-list-${post.id}">${repliesHtml}</div>
        <div class="reply-compose">
          <textarea id="reply-ta-${post.id}" class="reply-textarea"
            placeholder="Responder… (@nome para mencionar)"
            onkeydown="if(event.key==='Enter'&&(event.ctrlKey||event.metaKey))window.submitInlineReply('${post.id}')"></textarea>
          <button class="reply-submit-btn" onclick="window.submitInlineReply('${post.id}')">Enviar</button>
        </div>
      </div>
    </div>
  `;
}

function _renderReply(postId, r, idx, currentUid, isPostOwner) {
  const author  = _esc(r.authorName || 'Usuário');
  const content = _renderContent(r.content || '');
  const date    = r.createdAt ? _fmtDate(r.createdAt) : '';
  const rLikes  = Array.isArray(r.likes_uids) ? r.likes_uids : [];
  const rLiked  = !!(currentUid && rLikes.includes(currentUid));
  const isAccepted = !!r.accepted;

  return `
    <div class="reply-item${isAccepted ? ' reply-accepted' : ''}" data-reply-idx="${idx}">
      <div class="reply-avatar">${author.slice(0,2).toUpperCase()}</div>
      <div class="reply-content-wrap">
        <div class="reply-header">
          <span class="reply-author">${author}</span>
          ${isAccepted ? '<span class="reply-accepted-badge">✔ Melhor resposta</span>' : ''}
          <span class="reply-date">${date}</span>
        </div>
        <div class="reply-text">${content}</div>
        <div class="reply-actions">
          <button class="reply-action-btn${rLiked ? ' reply-liked' : ''}"
            onclick="window.likeReply('${postId}',${idx},this)"
            ${rLiked ? 'disabled' : ''}>❤ ${rLikes.length}</button>
          ${isPostOwner && !isAccepted
            ? `<button class="reply-action-btn reply-accept-btn"
                onclick="window.acceptReply('${postId}',${idx})">✔ Aceitar</button>`
            : ''}
        </div>
      </div>
    </div>
  `;
}

// ── Toggle replies panel ───────────────────────────────────────────────────────
window.togglePostReplies = function(postId) {
  const section = document.getElementById(`replies-${postId}`);
  if (!section) return;
  const open = section.style.display === 'none';
  section.style.display = open ? 'block' : 'none';
  if (open) document.getElementById(`reply-ta-${postId}`)?.focus();
};

// ── Inline reply submit ────────────────────────────────────────────────────────
window.submitInlineReply = async function(postId) {
  const ta  = document.getElementById(`reply-ta-${postId}`);
  const content = ta?.value?.trim();
  if (!content) return;

  const btn = ta?.nextElementSibling;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }

  try {
    const user = auth.currentUser;
    if (!user) return;

    const reply = {
      authorId:   user.uid,
      authorName: user.displayName || user.email.split('@')[0],
      content,
      likes_uids: [],
      createdAt:  new Date().toISOString(),
    };

    await updateDoc(doc(db, 'posts', postId), { replies: arrayUnion(reply) });
    if (ta) ta.value = '';

    // Notify post author
    const postSnap = await getDoc(doc(db, 'posts', postId));
    if (postSnap.exists() && postSnap.data().authorId !== user.uid) {
      const mentions = content.match(/@\w+/g) || [];
      await addDoc(collection(db, 'notifications', postSnap.data().authorId, 'items'), {
        type:         mentions.length ? 'mention' : 'reply',
        fromUser:     user.uid,
        fromUserName: user.displayName || user.email?.split('@')[0] || '',
        postId,
        read:         false,
        createdAt:    new Date().toISOString(),
        ...(mentions.length ? { mention: mentions[0] } : {}),
      });
    }

    // Optimistic append
    const list = document.getElementById(`replies-list-${postId}`);
    if (list) {
      const idx = list.querySelectorAll('.reply-item').length;
      const isOwn = postSnap?.data()?.authorId === user.uid;
      list.insertAdjacentHTML('beforeend', _renderReply(postId, reply, idx, user.uid, isOwn));
    }

    // Update reply count button
    const card = document.querySelector(`[data-post-id="${postId}"]`);
    const replyBtn = card?.querySelector('.post-action-btn:nth-child(2)');
    if (replyBtn) {
      const n = (list?.querySelectorAll('.reply-item').length) || 1;
      replyBtn.textContent = `💬 ${n} resposta${n > 1 ? 's' : ''}`;
    }
  } catch (err) {
    console.error('[post-card] Erro ao responder:', err);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Enviar'; }
  }
};

// ── Like em post ───────────────────────────────────────────────────────────────
window.likePost = async function(postId, btn) {
  if (btn?.disabled) return;
  const user = auth.currentUser;
  if (!user) return;

  try {
    await updateDoc(doc(db, 'posts', postId), { likes_uids: arrayUnion(user.uid) });

    const countEl = btn?.querySelector('.post-like-count');
    if (countEl) countEl.textContent = String(parseInt(countEl.textContent || '0') + 1);
    if (btn) { btn.disabled = true; btn.classList.add('post-liked'); }

    const postSnap = await getDoc(doc(db, 'posts', postId));
    const authorId = postSnap.data()?.authorId;
    if (postSnap.exists() && authorId !== user.uid) {
      // +2 reputação para o autor do post
      updateDoc(doc(db, 'users', authorId), { 'social.reputation': increment(2) }).catch(() => {});

      await addDoc(collection(db, 'notifications', authorId, 'items'), {
        type:         'like',
        fromUser:     user.uid,
        fromUserName: user.displayName || user.email?.split('@')[0] || '',
        postId,
        read:         false,
        createdAt:    new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error('[post-card] Erro ao curtir post:', err);
  }
};

// ── Like em resposta ───────────────────────────────────────────────────────────
window.likeReply = async function(postId, replyIdx, btn) {
  if (btn?.disabled) return;
  const user = auth.currentUser;
  if (!user) return;

  try {
    const postRef = doc(db, 'posts', postId);
    const snap    = await getDoc(postRef);
    if (!snap.exists()) return;

    const replies  = snap.data().replies ? [...snap.data().replies] : [];
    const reply    = replies[replyIdx];
    if (!reply) return;

    const likes = Array.isArray(reply.likes_uids) ? [...reply.likes_uids] : [];
    if (likes.includes(user.uid)) return;
    likes.push(user.uid);
    replies[replyIdx] = { ...reply, likes_uids: likes };

    await updateDoc(postRef, { replies });

    if (btn) {
      btn.disabled = true;
      btn.classList.add('reply-liked');
      btn.innerHTML = `❤ ${likes.length}`;
    }

    // +2 reputação para o autor da resposta
    if (reply.authorId && reply.authorId !== user.uid) {
      updateDoc(doc(db, 'users', reply.authorId), { 'social.reputation': increment(2) }).catch(() => {});
    }
  } catch (err) {
    console.error('[post-card] Erro ao curtir resposta:', err);
  }
};

// ── Aceitar melhor resposta ────────────────────────────────────────────────────
window.acceptReply = async function(postId, replyIdx) {
  const user = auth.currentUser;
  if (!user) return;

  try {
    const postRef = doc(db, 'posts', postId);
    const snap    = await getDoc(postRef);
    if (!snap.exists() || snap.data().authorId !== user.uid) return;

    const replies = [...(snap.data().replies || [])];
    if (!replies[replyIdx]) return;

    replies[replyIdx] = { ...replies[replyIdx], accepted: true };
    await updateDoc(postRef, { replies });

    // +5 reputação para o autor da resposta aceita
    const replyAuthorId = replies[replyIdx].authorId;
    if (replyAuthorId && replyAuthorId !== user.uid) {
      updateDoc(doc(db, 'users', replyAuthorId), { 'social.reputation': increment(5) }).catch(() => {});
    }

    // Atualiza UI
    const replyEl = document.querySelector(`#replies-list-${postId} [data-reply-idx="${replyIdx}"]`);
    if (replyEl) {
      replyEl.classList.add('reply-accepted');
      replyEl.querySelector('.reply-accept-btn')?.remove();
      replyEl.querySelector('.reply-author')?.insertAdjacentHTML(
        'afterend',
        '<span class="reply-accepted-badge">✔ Melhor resposta</span>'
      );
    }
  } catch (err) {
    console.error('[post-card] Erro ao aceitar resposta:', err);
  }
};

// ── Compartilhar post ──────────────────────────────────────────────────────────
window.sharePost = async function(postId) {
  const url = `${location.origin}${location.pathname}?post=${postId}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Post no StudyFlow', url });
    } else {
      await navigator.clipboard.writeText(url);
      _toast('🔗 Link copiado!');
    }
  } catch { /* cancelado pelo usuário */ }
};

// ── Excluir post ───────────────────────────────────────────────────────────────
window.deletePost = async function(postId) {
  if (!confirm('Excluir este post?')) return;
  const user = auth.currentUser;
  if (!user) return;

  try {
    const snap = await getDoc(doc(db, 'posts', postId));
    if (!snap.exists() || snap.data().authorId !== user.uid) return;
    await deleteDoc(doc(db, 'posts', postId));
    document.querySelector(`[data-post-id="${postId}"]`)?.remove();
  } catch (err) {
    console.error('[post-card] Erro ao excluir:', err);
  }
};

// ── Visualizar imagem em tela cheia ───────────────────────────────────────────
window._viewImage = function(url) {
  const overlay = document.getElementById('modal-overlay');
  const body    = document.getElementById('modal-body');
  if (!overlay || !body) return;
  body.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
      <button onclick="window.closeModal?.()" style="background:none;border:none;color:#fff;font-size:20px;cursor:pointer">✕</button>
    </div>
    <img src="${url}" alt="imagem" style="max-width:100%;max-height:75vh;border-radius:8px;display:block;margin:auto">
  `;
  overlay.classList.add('active');
  document.getElementById('modal-container')?.classList.add('active');
};

// ── Helpers ────────────────────────────────────────────────────────────────────
function _renderContent(text) {
  return _esc(text).replace(/@(\w+)/g, '<span class="post-mention">@$1</span>');
}

function _esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function _fmtDate(ts) {
  if (!ts) return '';
  const d   = ts.toDate ? ts.toDate() : new Date(ts);
  const now = new Date();
  const diff = Math.floor((now - d) / 60000);
  if (diff < 1)    return 'agora';
  if (diff < 60)   return `${diff}min`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h`;
  return d.toLocaleDateString('pt-BR', { day:'2-digit', month:'short' });
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
  if (document.getElementById('post-card-styles')) return;
  const s = document.createElement('style');
  s.id = 'post-card-styles';
  s.textContent = `
    /* ── Academic badge ── */
    .post-academic-badge {
      display: inline-block;
      font-size: 10px; font-weight: 600;
      color: var(--accent,#7c5cfc);
      background: rgba(124,92,252,.12);
      border-radius: 10px; padding: 1px 7px; margin-top: 1px;
    }
    .post-card-meta { display:flex; flex-direction:column; gap:1px; }

    /* ── Type badge ── */
    .post-card-type-badge {
      font-size: 11px; font-weight: 700;
      border: 1px solid; border-radius: 10px;
      padding: 2px 8px; white-space: nowrap; flex-shrink:0;
    }

    /* ── Image ── */
    .post-card-image { margin: 8px 0; border-radius:8px; overflow:hidden; }
    .post-card-image img { width:100%; max-height:260px; object-fit:cover; cursor:zoom-in; }

    /* ── Like/action buttons ── */
    .post-liked { opacity:.6; }
    .post-delete-btn { color: #e05252 !important; }
    .post-report-btn { color: #aaa !important; }

    /* ── @mention ── */
    .post-mention { color: var(--accent,#7c5cfc); font-weight:600; }

    /* ── Replies section ── */
    .post-replies-section {
      border-top: 1px solid var(--border,#2a2a3e);
      margin-top: 8px; padding-top: 8px;
    }
    .replies-list { display:flex; flex-direction:column; gap:8px; margin-bottom:10px; }
    .reply-item {
      display: flex; gap: 8px; align-items: flex-start;
      padding: 8px; border-radius: 8px;
      background: rgba(255,255,255,.03);
    }
    .reply-item.reply-accepted {
      background: rgba(46,213,115,.06);
      border-left: 3px solid #2ed573;
    }
    .reply-avatar {
      width: 28px; height: 28px; border-radius: 50%;
      background: var(--accent,#7c5cfc); display:flex;
      align-items:center; justify-content:center;
      font-size: 10px; font-weight:700; color:#fff;
      flex-shrink:0;
    }
    .reply-content-wrap { flex:1; min-width:0; }
    .reply-header {
      display: flex; align-items: center;
      gap: 6px; flex-wrap: wrap; margin-bottom: 3px;
    }
    .reply-author { font-size:12px; font-weight:700; color:var(--text,#fff); }
    .reply-date   { font-size:11px; color:rgba(255,255,255,.35); margin-left:auto; }
    .reply-text   { font-size:13px; color:rgba(255,255,255,.8); line-height:1.45; }
    .reply-actions { display:flex; gap:8px; margin-top:4px; }
    .reply-action-btn {
      background: none; border: none; padding: 2px 6px;
      font-size: 12px; color: rgba(255,255,255,.45);
      cursor: pointer; border-radius: 6px; transition: background .15s;
    }
    .reply-action-btn:hover:not(:disabled) { background: rgba(255,255,255,.07); color:#fff; }
    .reply-action-btn:disabled { opacity:.5; cursor:default; }
    .reply-liked { color: #e05252 !important; }
    .reply-accept-btn { color: #2ed573 !important; }
    .reply-accepted-badge {
      font-size: 10px; font-weight:700; color:#2ed573;
      background: rgba(46,213,115,.12); border-radius:8px;
      padding: 1px 6px;
    }

    /* ── Reply compose ── */
    .reply-compose { display:flex; gap:6px; align-items:flex-start; }
    .reply-textarea {
      flex:1; background: rgba(255,255,255,.06);
      border: 1px solid var(--border,#2a2a3e);
      border-radius: 8px; padding: 8px 10px;
      color: var(--text,#fff); font-size:13px;
      resize: vertical; min-height:52px; outline:none;
      font-family: inherit;
    }
    .reply-textarea:focus { border-color: var(--accent,#7c5cfc); }
    .reply-submit-btn {
      padding: 8px 14px; background: var(--accent,#7c5cfc);
      color:#fff; border:none; border-radius:8px;
      font-size:13px; font-weight:700; cursor:pointer;
      white-space:nowrap; transition: opacity .15s;
    }
    .reply-submit-btn:hover { opacity:.85; }
    .reply-submit-btn:disabled { opacity:.5; cursor:default; }
  `;
  document.head.appendChild(s);
})();
