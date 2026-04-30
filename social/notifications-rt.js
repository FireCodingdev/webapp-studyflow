// ===== SOCIAL: NOTIFICATIONS-RT.JS =====
// Notificações em tempo real via Firestore onSnapshot — NOVO MÓDULO

import { db } from '../firebase.js';

// CORREÇÃO: substituído "await import(...)" (top-level await) por import estático.
// O top-level await travava toda a cadeia de módulos, impedindo o app de sair do splash.
import {
  collection, query, orderBy, limit, onSnapshot,
  updateDoc, doc, where, getDocs,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

let _nrtUnsubscribe = null;

// ---- Iniciar listener de notificações ----
export function initRealtimeNotifications(uid) {
  if (_nrtUnsubscribe) { _nrtUnsubscribe(); _nrtUnsubscribe = null; }

  const q = query(
    collection(db, 'notifications', uid, 'items'),
    where('read', '==', false),
    orderBy('createdAt', 'desc'),
    limit(20)
  );

  _nrtUnsubscribe = onSnapshot(q, (snap) => {
    const count = snap.size;
    _updateBadge(count);

    if (count > 0) {
      const latest = snap.docs[0]?.data();
      if (latest) _showNotificationToast(latest);
    }
  }, (err) => {
    console.warn('[notifications-rt] Erro no listener:', err.message);
  });
}

// ---- Parar listener ----
export function stopRealtimeNotifications() {
  if (_nrtUnsubscribe) { _nrtUnsubscribe(); _nrtUnsubscribe = null; }
}

// ---- Marcar notificação como lida ----
export async function markNotificationRead(uid, notifId) {
  try {
    await updateDoc(doc(db, 'notifications', uid, 'items', notifId), { read: true });
  } catch (err) {
    console.error('[notifications-rt] Erro ao marcar lida:', err);
  }
}

// ---- Atualiza badge no ícone de sino ----
function _updateBadge(count) {
  let badge = document.getElementById('notif-badge');
  const bellBtn = document.querySelector('.bell-btn');
  if (!bellBtn) return;

  if (count > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'notif-badge';
      badge.className = 'notif-badge';
      bellBtn.style.position = 'relative';
      bellBtn.appendChild(badge);
    }
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.style.display = 'flex';
  } else if (badge) {
    badge.style.display = 'none';
  }
}

// ---- Exibe toast de notificação ----
let _lastNotifShown = null;
function _showNotificationToast(notif) {
  const key = notif.fromUser + notif.type + (notif.createdAt?.seconds || '');
  if (_lastNotifShown === key) return;
  _lastNotifShown = key;

  const messages = {
    follow: '👤 Alguém começou a te seguir!',
    like: '❤️ Seu post recebeu uma curtida!',
    reply: '💬 Alguém respondeu seu post!',
    achievement: '🏆 Nova conquista desbloqueada!',
  };

  const msg = messages[notif.type] || '🔔 Nova notificação!';
  const toastEl = document.getElementById('toast');
  if (toastEl) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), 3500);
  }
}

// ---- Renderizar painel de notificações (chamado ao abrir painel) ----
export async function renderNotificationsPanel(uid) {
  const container = document.getElementById('notif-panel-list');
  if (!container) return;

  // getDocs já está disponível via import estático no topo do arquivo
  const q = query(
    collection(db, 'notifications', uid, 'items'),
    orderBy('createdAt', 'desc'),
    limit(30)
  );

  try {
    const snap = await getDocs(q);
    if (snap.empty) {
      container.innerHTML = `<div class="feed-empty">Nenhuma notificação ainda. 🔔</div>`;
      return;
    }

    container.innerHTML = snap.docs.map(d => {
      const n = d.data();
      const icons = { follow: '👤', like: '❤️', reply: '💬', achievement: '🏆' };
      const labels = { follow: 'Seguiu você', like: 'Curtiu seu post', reply: 'Respondeu seu post', achievement: 'Conquista desbloqueada' };
      return `
        <div class="notif-item ${n.read ? '' : 'notif-unread'}" onclick="window.markNotifRead('${uid}','${d.id}', this)">
          <span class="notif-icon">${icons[n.type] || '🔔'}</span>
          <span class="notif-label">${labels[n.type] || 'Notificação'}</span>
          ${!n.read ? '<span class="notif-dot"></span>' : ''}
        </div>
      `;
    }).join('');
  } catch (err) {
    container.innerHTML = `<div class="feed-empty">Erro ao carregar notificações.</div>`;
  }
}

// ---- Handler global: marcar lida ao clicar ----
window.markNotifRead = async function(uid, notifId, el) {
  await markNotificationRead(uid, notifId);
  el?.classList.remove('notif-unread');
  el?.querySelector('.notif-dot')?.remove();
};
