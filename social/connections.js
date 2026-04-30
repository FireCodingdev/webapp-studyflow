// ===== SOCIAL: CONNECTIONS.JS =====
// Seguir, conectar, descobrir colegas — NOVO MÓDULO

import { db } from '../firebase.js';
import { renderUserCard } from '../components/user-card.js';

const {
  doc, getDoc, setDoc, updateDoc, arrayUnion, arrayRemove,
  collection, query, limit, getDocs, increment,
} = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

// ---- Seguir um usuário ----
export async function followUser(currentUid, targetUid) {
  if (!currentUid || !targetUid || currentUid === targetUid) return false;
  try {
    // Adiciona targetUid ao "following" do usuário atual
    await setDoc(doc(db, 'connections', currentUid), {
      following: arrayUnion(targetUid),
    }, { merge: true });

    // Adiciona currentUid ao "followers" do alvo
    await setDoc(doc(db, 'connections', targetUid), {
      followers: arrayUnion(currentUid),
    }, { merge: true });

    // Atualiza contadores sociais
    await updateDoc(doc(db, 'users', currentUid), { 'social.following': increment(1) });
    await updateDoc(doc(db, 'users', targetUid), { 'social.followers': increment(1) });

    // Cria notificação para o alvo
    await _createFollowNotification(currentUid, targetUid);

    return true;
  } catch (err) {
    console.error('[connections] Erro ao seguir:', err);
    return false;
  }
}

// ---- Deixar de seguir ----
export async function unfollowUser(currentUid, targetUid) {
  if (!currentUid || !targetUid) return false;
  try {
    await setDoc(doc(db, 'connections', currentUid), {
      following: arrayRemove(targetUid),
    }, { merge: true });

    await setDoc(doc(db, 'connections', targetUid), {
      followers: arrayRemove(currentUid),
    }, { merge: true });

    await updateDoc(doc(db, 'users', currentUid), { 'social.following': increment(-1) });
    await updateDoc(doc(db, 'users', targetUid), { 'social.followers': increment(-1) });

    return true;
  } catch (err) {
    console.error('[connections] Erro ao deixar de seguir:', err);
    return false;
  }
}

// ---- Verificar se já segue ----
export async function isFollowing(currentUid, targetUid) {
  try {
    const snap = await getDoc(doc(db, 'connections', currentUid));
    if (!snap.exists()) return false;
    const data = snap.data();
    return (data.following || []).includes(targetUid);
  } catch {
    return false;
  }
}

// ---- Carregar lista de following ----
export async function getFollowing(uid) {
  try {
    const snap = await getDoc(doc(db, 'connections', uid));
    if (!snap.exists()) return [];
    return snap.data().following || [];
  } catch {
    return [];
  }
}

// ---- Carregar lista de followers ----
export async function getFollowers(uid) {
  try {
    const snap = await getDoc(doc(db, 'connections', uid));
    if (!snap.exists()) return [];
    return snap.data().followers || [];
  } catch {
    return [];
  }
}

// ---- Descobrir colegas (sugestões básicas — primeiros 20 perfis) ----
export async function discoverPeers(currentUid, limitN = 20) {
  try {
    const snap = await getDocs(query(collection(db, 'user_profiles'), limit(limitN + 1)));
    return snap.docs
      .filter(d => d.id !== currentUid)
      .slice(0, limitN)
      .map(d => ({ uid: d.id, ...d.data() }));
  } catch (err) {
    console.error('[connections] Erro ao descobrir colegas:', err);
    return [];
  }
}

// ---- Renderizar seção "Descobrir Colegas" na página social ----
export async function renderDiscoverSection(currentUid) {
  const container = document.getElementById('discover-list');
  if (!container) return;
  container.innerHTML = `<div class="feed-loading">⏳ Buscando colegas...</div>`;

  const peers = await discoverPeers(currentUid);
  if (!peers.length) {
    container.innerHTML = `<div class="feed-empty">Nenhum colega encontrado ainda.</div>`;
    return;
  }

  const followingList = await getFollowing(currentUid);
  container.innerHTML = peers
    .map(p => renderUserCard(p, followingList.includes(p.uid)))
    .join('');
}

// ---- Handler global: toggle follow/unfollow ----
window.toggleFollowUser = async function(targetUid) {
  const { auth } = await import('../firebase.js');
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

// ---- Cria notificação de follow (usado internamente) ----
async function _createFollowNotification(fromUid, toUid) {
  try {
    const { addDoc, serverTimestamp } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    await addDoc(collection(db, 'notifications', toUid, 'items'), {
      type: 'follow',
      fromUser: fromUid,
      read: false,
      createdAt: serverTimestamp(),
    });
  } catch (_) {}
}
