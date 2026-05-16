// ===== SOCIAL: CONNECTIONS.JS =====
// 2025-05-15 — Atualizado: discoverPeers prioriza colegas do mesmo curso/período/semestre
// e exibe label "Da sua turma 🎓".

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
    console.error('[connections] Erro ao seguir:', err);
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
    console.error('[connections] Erro ao deixar de seguir:', err);
    return false;
  }
}

// ── Verificar se segue ────────────────────────────────────────────────────────
export async function isFollowing(currentUid, targetUid) {
  try {
    const snap = await getDoc(doc(db, 'connections', currentUid));
    if (!snap.exists()) return false;
    return (snap.data().following || []).includes(targetUid);
  } catch { return false; }
}

export async function getFollowing(uid) {
  try {
    const snap = await getDoc(doc(db, 'connections', uid));
    if (!snap.exists()) return [];
    return snap.data().following || [];
  } catch { return []; }
}

export async function getFollowers(uid) {
  try {
    const snap = await getDoc(doc(db, 'connections', uid));
    if (!snap.exists()) return [];
    return snap.data().followers || [];
  } catch { return []; }
}

// ── Descobrir colegas (prioriza mesma turma) ──────────────────────────────────
export async function discoverPeers(currentUid, limitN = 20) {
  try {
    // Carrega perfil do usuário atual para priorização
    const mySnap = await getDoc(doc(db, 'users', currentUid, 'profile', 'academic'));
    const myData = mySnap.exists() ? mySnap.data() : {};

    const snap = await getDocs(query(collection(db, 'user_profiles'), limit(60)));
    const peers = snap.docs
      .filter(d => d.id !== currentUid)
      .map(d => ({ uid: d.id, ...d.data() }));

    // Ordena: mesmo curso + mesmo período + mesmo semestre → topo
    peers.sort((a, b) => {
      const score = (p) =>
        (p.courseId  === myData.courseId  ? 4 : 0) +
        (p.period    === myData.period    ? 2 : 0) +
        (p.semester  === myData.semester  ? 1 : 0);
      return score(b) - score(a);
    });

    // Marca quem é da mesma turma
    return peers.slice(0, limitN).map(p => ({
      ...p,
      isSameTurma: p.courseId === myData.courseId && p.period === myData.period,
    }));
  } catch (err) {
    console.error('[connections] Erro ao descobrir colegas:', err);
    return [];
  }
}

// ── Renderizar seção Descobrir ────────────────────────────────────────────────
export async function renderDiscoverSection(currentUid) {
  const container = document.getElementById('discover-list');
  if (!container) return;
  container.innerHTML = `<div class="feed-loading">⏳ Buscando colegas...</div>`;

  const peers       = await discoverPeers(currentUid);
  const followingList = await getFollowing(currentUid);

  if (!peers.length) {
    container.innerHTML = `<div class="feed-empty">Nenhum colega encontrado ainda.</div>`;
    return;
  }

  container.innerHTML = peers.map(p => {
    const card = renderUserCard(p, followingList.includes(p.uid));
    if (!p.isSameTurma) return card;
    // Injeta label "Da sua turma" no card
    return card.replace(
      'class="user-card"',
      'class="user-card same-turma"'
    ).replace(
      'class="user-card-name"',
      'class="user-card-name"'
    ).replace(
      `<span class="user-card-name">`,
      `<span class="user-turma-label">Da sua turma 🎓</span><span class="user-card-name">`
    );
  }).join('');
}

// ── Handler global: toggle follow ─────────────────────────────────────────────
window.toggleFollowUser = async function(targetUid) {
  const user = auth.currentUser;
  if (!user) return;

  const currentUid = user.uid;
  const btn = document.querySelector(`[data-follow-uid="${targetUid}"]`);
  const already = await isFollowing(currentUid, targetUid);

  if (already) {
    await unfollowUser(currentUid, targetUid);
    if (btn) { btn.textContent = '➕ Seguir'; btn.dataset.following = 'false'; }
  } else {
    await followUser(currentUid, targetUid);
    if (btn) { btn.textContent = '✔ Seguindo'; btn.dataset.following = 'true'; }
  }
};

// ── Notificação de follow ──────────────────────────────────────────────────────
async function _createFollowNotification(fromUid, toUid) {
  try {
    await addDoc(collection(db, 'notifications', toUid, 'items'), {
      type: 'follow', fromUser: fromUid, read: false, createdAt: serverTimestamp(),
    });
  } catch { /* best-effort */ }
}

// ── CSS: label "Da sua turma" ─────────────────────────────────────────────────
(function _injectStyles() {
  if (document.getElementById('connections-turma-style')) return;
  const style = document.createElement('style');
  style.id = 'connections-turma-style';
  style.textContent = `
    .user-card.same-turma {
      border-left: 3px solid var(--accent, #7c5cfc);
    }
    .user-turma-label {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      color: var(--accent, #7c5cfc);
      background: rgba(124,92,252,.12);
      border-radius: 10px;
      padding: 1px 7px;
      margin-bottom: 2px;
    }
  `;
  document.head.appendChild(style);
})();
