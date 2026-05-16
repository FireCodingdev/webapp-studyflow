// ===== SOCIAL: NOTIFICATIONS-RT.JS =====
// Adicionado: tipo mention, "marcar todas como lidas", badge na aba

import { db } from '../firebase.js';
import {
  collection, query, orderBy, limit, onSnapshot,
  updateDoc, doc, where, getDocs, writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

let _nrtUnsubscribe = null;

const NOTIF_ICONS = {
  follow:       '👤',
  like:         '❤️',
  reply:        '💬',
  mention:      '@',
  achievement:  '🏆',
  chat_message: '💬',
};

const NOTIF_LABELS = {
  follow:       'Seguiu você',
  like:         'Curtiu seu post',
  reply:        'Respondeu seu post',
  mention:      'Mencionou você em uma resposta',
  achievement:  'Conquista desbloqueada',
  chat_message: 'Nova mensagem na sala',
};

// ── Listener em tempo real ────────────────────────────────────────────────────
export function initRealtimeNotifications(uid) {
  if (_nrtUnsubscribe) { _nrtUnsubscribe(); _nrtUnsubscribe = null; }

  const q = query(
    collection(db, 'notifications', uid, 'items'),
    where('read', '==', false),
    orderBy('createdAt', 'desc'),
    limit(30)
  );

  _nrtUnsubscribe = onSnapshot(q, (snap) => {
    _updateBadge(snap.size);
    _updateTabBadge(snap.size);
    if (snap.size > 0) {
      const latest = snap.docs[0]?.data();
      if (latest) _showToast(latest);
    }
  }, (err) => {
    console.warn('[notifications-rt] listener:', err.message);
  });
}

export function stopRealtimeNotifications() {
  if (_nrtUnsubscribe) { _nrtUnsubscribe(); _nrtUnsubscribe = null; }
}

// ── Marcar uma como lida ──────────────────────────────────────────────────────
export async function markNotificationRead(uid, notifId) {
  try {
    await updateDoc(doc(db, 'notifications', uid, 'items', notifId), { read: true });
  } catch (err) {
    console.error('[notifications-rt] marcar lida:', err);
  }
}

// ── Marcar todas como lidas ───────────────────────────────────────────────────
export async function markAllNotificationsRead(uid) {
  try {
    const q    = query(collection(db, 'notifications', uid, 'items'), where('read', '==', false));
    const snap = await getDocs(q);
    if (snap.empty) return;
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.update(d.ref, { read: true }));
    await batch.commit();
  } catch (err) {
    console.error('[notifications-rt] marcar todas:', err);
  }
}

// ── Badge do sino ─────────────────────────────────────────────────────────────
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

// ── Badge na aba de notificações ──────────────────────────────────────────────
function _updateTabBadge(count) {
  const tabBtn = document.querySelector('.social-tab-btn[data-tab="notifications"]');
  if (!tabBtn) return;
  let badge = tabBtn.querySelector('.tab-notif-badge');
  if (count > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'tab-notif-badge';
      tabBtn.style.position = 'relative';
      tabBtn.appendChild(badge);
    }
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.style.display = 'flex';
  } else if (badge) {
    badge.style.display = 'none';
  }
}

// ── Toast de notificação ──────────────────────────────────────────────────────
let _lastToastKey = null;
function _showToast(notif) {
  const key = (notif.fromUser || notif.roomId || '') + notif.type + (notif.createdAt?.seconds || '');
  if (_lastToastKey === key) return;
  _lastToastKey = key;

  let msg;
  if (notif.type === 'chat_message') {
    const author  = notif.authorName || 'Colega';
    const room    = notif.roomName   || 'Sala';
    const preview = notif.preview    ? `: "${notif.preview}"` : '';
    msg = `💬 ${author} em ${room}${preview}`;
  } else {
    const who = notif.fromUserName ? `${notif.fromUserName} ` : '';
    msg = {
      follow:      `👤 ${who}começou a te seguir!`,
      like:        `❤️ ${who}curtiu seu post!`,
      reply:       `💬 ${who}respondeu seu post!`,
      mention:     `@ ${who}mencionou você!`,
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

// ── Renderizar painel ──────────────────────────────────────────────────────────
export async function renderNotificationsPanel(uid) {
  const container = document.getElementById('notif-panel-list');
  if (!container) return;

  container.innerHTML = `
    <div class="notif-toolbar">
      <span style="font-size:13px;font-weight:700;color:var(--text,#fff)">Notificações</span>
      <button class="notif-mark-all-btn" onclick="window.markAllNotifRead('${uid}')">
        ✔ Marcar todas como lidas
      </button>
    </div>
    <div id="notif-items-list"><div class="feed-empty">⏳ Carregando…</div></div>
  `;

  const q = query(
    collection(db, 'notifications', uid, 'items'),
    orderBy('createdAt', 'desc'),
    limit(40)
  );

  try {
    const snap = await getDocs(q);
    const el   = document.getElementById('notif-items-list');
    if (!el) return;

    if (snap.empty) {
      el.innerHTML = `<div class="feed-empty">Nenhuma notificação ainda. 🔔</div>`;
      return;
    }

    el.innerHTML = snap.docs.map(d => {
      const n = d.data();
      const icon  = NOTIF_ICONS[n.type]  || '🔔';
      const base  = NOTIF_LABELS[n.type] || 'Notificação';

      let label = base;
      if (n.fromUserName) label = `<strong>${_esc(n.fromUserName)}</strong> ${base.toLowerCase()}`;

      if (n.type === 'chat_message') {
        const who = n.authorName ? `<strong>${_esc(n.authorName)}</strong>` : 'Alguém';
        const room = n.roomName ? ` em <strong>${_esc(n.roomName)}</strong>` : '';
        label = `${who}${room} enviou uma mensagem`;
        if (n.preview) label += `<br><span style="font-size:12px;color:rgba(255,255,255,.4)">"${_esc(n.preview)}"</span>`;
      }

      if (n.type === 'mention' && n.mention) {
        label += ` <span style="color:var(--accent,#7c5cfc)">${_esc(n.mention)}</span>`;
      }

      const clickAction = n.type === 'chat_message' && n.roomId
        ? `onclick="window._openChat?.('${n.roomId}'); window.markNotifRead('${uid}','${d.id}',this)"`
        : `onclick="window.markNotifRead('${uid}','${d.id}',this)"`;

      return `
        <div class="notif-item${n.read ? '' : ' notif-unread'}" ${clickAction}>
          <span class="notif-icon">${icon}</span>
          <div class="notif-label">${label}</div>
          ${!n.read ? '<span class="notif-dot"></span>' : ''}
        </div>
      `;
    }).join('');
  } catch (err) {
    const el = document.getElementById('notif-items-list');
    if (el) el.innerHTML = `<div class="feed-empty">Erro ao carregar notificações.</div>`;
    console.error('[notifications-rt] renderPanel:', err);
  }
}

// ── Handlers globais ──────────────────────────────────────────────────────────
window.markNotifRead = async function(uid, notifId, el) {
  await markNotificationRead(uid, notifId);
  el?.classList.remove('notif-unread');
  el?.querySelector('.notif-dot')?.remove();
};

window.markAllNotifRead = async function(uid) {
  await markAllNotificationsRead(uid);
  document.querySelectorAll('.notif-item').forEach(el => {
    el.classList.remove('notif-unread');
    el.querySelector('.notif-dot')?.remove();
  });
  _updateBadge(0);
  _updateTabBadge(0);
};

function _esc(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Estilos injetados ──────────────────────────────────────────────────────────
(function _styles() {
  if (document.getElementById('notif-rt-styles')) return;
  const s = document.createElement('style');
  s.id = 'notif-rt-styles';
  s.textContent = `
    .notif-toolbar {
      display:flex; align-items:center; justify-content:space-between;
      padding:8px 0 12px; gap:8px;
    }
    .notif-mark-all-btn {
      background:none; border:1px solid var(--border,#2a2a3e);
      border-radius:20px; padding:4px 12px;
      font-size:11px; color:rgba(255,255,255,.5);
      cursor:pointer; transition:all .15s; white-space:nowrap;
    }
    .notif-mark-all-btn:hover {
      border-color:var(--accent,#7c5cfc);
      color:var(--accent,#7c5cfc);
    }
    .tab-notif-badge {
      position:absolute; top:-4px; right:-4px;
      background:#e05252; color:#fff;
      border-radius:50%; width:16px; height:16px;
      font-size:9px; font-weight:700;
      display:flex; align-items:center; justify-content:center;
    }
    .notif-label { flex:1; font-size:13px; line-height:1.4; }
  `;
  document.head.appendChild(s);
})();
