// ===== SOCIAL: CONNECTIONS.JS =====
// Follow/unfollow, discover com busca por nome/curso, sugestão por turma

import { db, auth } from '../firebase.js';
import { renderUserCard } from '../components/user-card.js';
import {
  doc, getDoc, setDoc, updateDoc, arrayUnion, arrayRemove,
  collection, query, limit, getDocs, increment, addDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── Seguir ────────────────────────────────────────────────────────────────────
export async function followUser(currentUid, targetUid) {
  if (!currentUid || !targetUid || currentUid === targetUid) return false;
  try {
    await setDoc(doc(db, 'connections', currentUid), { following: arrayUnion(targetUid) }, { merge: true });
    await setDoc(doc(db, 'connections', targetUid), { followers: arrayUnion(currentUid) }, { merge: true });
    await updateDoc(doc(db, 'users', currentUid), { 'social.following': increment(1) });
    await updateDoc(doc(db, 'users', targetUid),  { 'social.followers': increment(1) });
    await _createFollowNotification(currentUid, targetUid);
    return true;
  } catch (err) {
    console.error('[connections] followUser:', err);
    return false;
  }
}

// ── Deixar de seguir ──────────────────────────────────────────────────────────
export async function unfollowUser(currentUid, targetUid) {
  if (!currentUid || !targetUid) return false;
  try {
    await setDoc(doc(db, 'connections', currentUid), { following: arrayRemove(targetUid) }, { merge: true });
    await setDoc(doc(db, 'connections', targetUid), { followers: arrayRemove(currentUid) }, { merge: true });
    await updateDoc(doc(db, 'users', currentUid), { 'social.following': increment(-1) });
    await updateDoc(doc(db, 'users', targetUid),  { 'social.followers': increment(-1) });
    return true;
  } catch (err) {
    console.error('[connections] unfollowUser:', err);
    return false;
  }
}

// ── Verificar se segue ────────────────────────────────────────────────────────
export async function isFollowing(currentUid, targetUid) {
  try {
    const snap = await getDoc(doc(db, 'connections', currentUid));
    return snap.exists() && (snap.data().following || []).includes(targetUid);
  } catch { return false; }
}

export async function getFollowing(uid) {
  try {
    const snap = await getDoc(doc(db, 'connections', uid));
    return snap.exists() ? (snap.data().following || []) : [];
  } catch { return []; }
}

export async function getFollowers(uid) {
  try {
    const snap = await getDoc(doc(db, 'connections', uid));
    return snap.exists() ? (snap.data().followers || []) : [];
  } catch { return []; }
}

// ── Descobrir colegas ─────────────────────────────────────────────────────────
export async function discoverPeers(currentUid, limitN = 40) {
  try {
    const mySnap = await getDoc(doc(db, 'users', currentUid, 'profile', 'academic'));
    const myData = mySnap.exists() ? mySnap.data() : {};

    const snap  = await getDocs(query(collection(db, 'user_profiles'), limit(80)));
    const peers = snap.docs
      .filter(d => d.id !== currentUid)
      .map(d => ({ uid: d.id, ...d.data() }));

    peers.sort((a, b) => {
      const score = p =>
        (p.courseId === myData.courseId ? 4 : 0) +
        (p.period   === myData.period   ? 2 : 0) +
        (p.semester === myData.semester ? 1 : 0);
      return score(b) - score(a);
    });

    return peers.slice(0, limitN).map(p => ({
      ...p,
      isSameTurma: p.courseId === myData.courseId && p.period === myData.period,
    }));
  } catch (err) {
    console.error('[connections] discoverPeers:', err);
    return [];
  }
}

// ── Renderizar seção Descobrir (com busca) ────────────────────────────────────
export async function renderDiscoverSection(currentUid) {
  const container = document.getElementById('discover-list');
  if (!container) return;

  container.innerHTML = `
    <div class="discover-search-wrap">
      <input type="search" id="discover-search" class="discover-search"
        placeholder="🔍 Buscar por nome ou curso…"
        oninput="window._filterPeers(this.value)">
    </div>
    <div id="discover-peers"><div class="feed-loading">⏳ Buscando colegas…</div></div>
  `;

  const [peers, followingList] = await Promise.all([
    discoverPeers(currentUid),
    getFollowing(currentUid),
  ]);

  window._discoverData = { peers, followingList };
  _renderPeerCards(peers, followingList);
}

function _renderPeerCards(peers, followingList) {
  const el = document.getElementById('discover-peers');
  if (!el) return;

  if (!peers.length) {
    el.innerHTML = `<div class="feed-empty">Nenhum colega encontrado.</div>`;
    return;
  }

  el.innerHTML = peers.map(p => {
    let card = renderUserCard(p, followingList.includes(p.uid));
    if (p.isSameTurma) {
      card = card
        .replace('class="user-card"', 'class="user-card same-turma"')
        .replace(
          `<span class="user-card-name">`,
          `<span class="user-turma-label">Da sua turma 🎓</span><span class="user-card-name">`
        );
    }
    return card;
  }).join('');
}

window._filterPeers = function(q) {
  const data = window._discoverData;
  if (!data) return;
  const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const qn   = norm(q || '').trim();
  const filtered = qn
    ? data.peers.filter(p =>
        norm(p.displayName  || '').includes(qn) ||
        norm(p.course       || '').includes(qn) ||
        norm(p.courseSigla  || '').includes(qn)
      )
    : data.peers;
  _renderPeerCards(filtered, data.followingList);
};

// ── Handler global: toggle follow ─────────────────────────────────────────────
window.toggleFollowUser = async function(targetUid) {
  const user = auth.currentUser;
  if (!user) return;

  const btn = document.querySelector(`[data-follow-uid="${targetUid}"]`);
  const already = await isFollowing(user.uid, targetUid);

  if (already) {
    await unfollowUser(user.uid, targetUid);
    if (btn) { btn.textContent = '➕ Seguir'; btn.classList.remove('btn-secondary'); btn.dataset.following = 'false'; }
  } else {
    await followUser(user.uid, targetUid);
    if (btn) { btn.textContent = '✔ Seguindo'; btn.classList.add('btn-secondary'); btn.dataset.following = 'true'; }
  }
};

// ── Notificação de follow ──────────────────────────────────────────────────────
async function _createFollowNotification(fromUid, toUid) {
  try {
    const fromUserName = auth.currentUser?.displayName || auth.currentUser?.email?.split('@')[0] || '';
    await addDoc(collection(db, 'notifications', toUid, 'items'), {
      type: 'follow', fromUser: fromUid, fromUserName, read: false, createdAt: serverTimestamp(),
    });
  } catch { /* best-effort */ }
}

// ── Estilos injetados ──────────────────────────────────────────────────────────
(function _styles() {
  if (document.getElementById('connections-styles')) return;
  const s = document.createElement('style');
  s.id = 'connections-styles';
  s.textContent = `
    .user-card.same-turma { border-left: 3px solid var(--accent,#7c5cfc); }
    .user-turma-label {
      display:inline-block; font-size:10px; font-weight:700;
      color:var(--accent,#7c5cfc); background:rgba(124,92,252,.12);
      border-radius:10px; padding:1px 7px; margin-bottom:2px;
    }
    .discover-search-wrap {
      padding: 0 0 12px;
      position: sticky; top:0;
      background: var(--bg,#12121e); z-index:5;
    }
    .discover-search {
      width:100%; box-sizing:border-box;
      padding:10px 14px;
      background:rgba(255,255,255,.06);
      border:1px solid var(--border,#2a2a3e);
      border-radius:24px; color:var(--text,#fff);
      font-size:14px; outline:none;
      transition:border-color .15s;
    }
    .discover-search:focus { border-color:var(--accent,#7c5cfc); }
  `;
  document.head.appendChild(s);
})();
