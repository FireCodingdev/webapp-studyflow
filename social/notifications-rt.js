// ===== SOCIAL: NOTIFICATIONS-RT.JS =====
// 2025-05-15 — Adicionado suporte ao tipo chat_message (mensagens de chat das salas).

import { db } from '../firebase.js';
import {
  collection, query, orderBy, limit, onSnapshot,
  updateDoc, doc, where, getDocs,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

let _nrtUnsubscribe = null;

// ── Ícones e labels por tipo de notificação ───────────────────────────────────
const NOTIF_ICONS = {
  follow:       '👤',
  like:         '❤️',
  reply:        '💬',
  achievement:  '🏆',
  chat_message: '💬',
};

const NOTIF_LABELS = {
  follow:       'Seguiu você',
  like:         'Curtiu seu post',
  reply:        'Respondeu seu post',
  achievement:  'Conquista desbloqueada',
  chat_message: 'Nova mensagem na sala',
};

// ── Iniciar listener em tempo real ────────────────────────────────────────────
export function initRealtimeNotifications(uid) {
  if (_nrtUnsubscribe) { _nrtUnsubscribe(); _nrtUnsubscribe = null; }

  const q = query(
    collection(db, 'notifications', uid, 'items'),
    where('read', '==', false),
    orderBy('createdAt', 'desc'),
    limit(20)
  );

  _nrtUnsubscribe = onSnapshot(q, (snap) => {
    _updateBadge(snap.size);
    if (snap.size > 0) {
      const latest = snap.docs[0]?.data();
      if (latest) _showNotificationToast(latest);
    }
  }, (err) => {
    console.warn('[notifications-rt] Erro no listener:', err.message);
  });
}

export function stopRealtimeNotifications() {
  if (_nrtUnsubscribe) { _nrtUnsubscribe(); _nrtUnsubscribe = null; }
}

// ── Marcar como lida ──────────────────────────────────────────────────────────
export async function markNotificationRead(uid, notifId) {
  try {
    await updateDoc(doc(db, 'notifications', uid, 'items', notifId), { read: true });
  } catch (err) {
    console.error('[notifications-rt] Erro ao marcar lida:', err);
  }
}

// ── Atualiza badge do sino ────────────────────────────────────────────────────
function _updateBadge(count) {
  let badge  = document.getElementById('notif-badge');
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

// ── Toast de notificação ──────────────────────────────────────────────────────
let _lastNotifShown = null;
function _showNotificationToast(notif) {
  const key = (notif.fromUser || notif.roomId || '') + notif.type + (notif.createdAt?.seconds || '');
  if (_lastNotifShown === key) return;
  _lastNotifShown = key;

  let msg;
  if (notif.type === 'chat_message') {
    const author  = notif.authorName || 'Colega';
    const room    = notif.roomName   || 'Sala';
    const preview = notif.preview    ? `: "${notif.preview}"` : '';
    msg = `💬 ${author} em ${room}${preview}`;
  } else {
    msg = {
      follow:      '👤 Alguém começou a te seguir!',
      like:        '❤️ Seu post recebeu uma curtida!',
      reply:       '💬 Alguém respondeu seu post!',
      achievement: '🏆 Nova conquista desbloqueada!',
    }[notif.type] || '🔔 Nova notificação!';
  }

  const toastEl = document.getElementById('toast');
  if (toastEl) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), 3500);
  }
}

// ── Renderizar painel de notificações ─────────────────────────────────────────
export async function renderNotificationsPanel(uid) {
  const container = document.getElementById('notif-panel-list');
  if (!container) return;

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
      const n       = d.data();
      const icon    = NOTIF_ICONS[n.type]  || '🔔';
      const baseLabel = NOTIF_LABELS[n.type] || 'Notificação';

      let label = baseLabel;
      if (n.type === 'chat_message') {
        label = n.roomName
          ? `Nova mensagem em <strong>${_esc(n.roomName)}</strong>`
          : 'Nova mensagem em uma sala';
        if (n.authorName) label = `${_esc(n.authorName)} em ${n.roomName ? `<strong>${_esc(n.roomName)}</strong>` : 'uma sala'}`;
        if (n.preview)    label += `<br><span style="font-size:12px;color:var(--text-muted)">"${_esc(n.preview)}"</span>`;
      }

      const clickAction = n.type === 'chat_message' && n.roomId
        ? `onclick="window._openChat('${n.roomId}'); window.markNotifRead('${uid}','${d.id}', this)"`
        : `onclick="window.markNotifRead('${uid}','${d.id}', this)"`;

      return `
        <div class="notif-item ${n.read ? '' : 'notif-unread'}" ${clickAction}>
          <span class="notif-icon">${icon}</span>
          <span class="notif-label">${label}</span>
          ${!n.read ? '<span class="notif-dot"></span>' : ''}
        </div>
      `;
    }).join('');
  } catch (err) {
    container.innerHTML = `<div class="feed-empty">Erro ao carregar notificações.</div>`;
  }
}

// ── Handler global: marcar lida ───────────────────────────────────────────────
window.markNotifRead = async function(uid, notifId, el) {
  await markNotificationRead(uid, notifId);
  el?.classList.remove('notif-unread');
  el?.querySelector('.notif-dot')?.remove();
};

function _esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
