// ===== SOCIAL: GROUPS.JS =====
// 2025-05-15 — Reescrita completa: lista salas do mesmo curso/período/instituição
// agrupadas por semestre. Sem criação manual de salas.

import { db, auth } from '../firebase.js';
import {
  collection, query, where, getDocs, getDoc, doc, limit, orderBy,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

import {
  loadFullAcademicProfile,
  buildRoomId,
  ensureSubjectRoom,
  joinSubjectRoom,
  isRoomMember,
  FACAPE_COURSES,
} from './turmas.js';

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const now = new Date();
  const diff = Math.floor((now - d) / 60000);
  if (diff < 1)   return 'agora';
  if (diff < 60)  return `${diff}min`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h`;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

// ── Carrega salas do mesmo curso/período/instituição do usuário ───────────────
async function loadCourseRooms(profile) {
  try {
    // Consulta por courseId (índice simples criado automaticamente pelo Firestore)
    const q = query(
      collection(db, 'subject_rooms'),
      where('courseId', '==', profile.courseId),
      limit(60)
    );
    const snap = await getDocs(q);
    return snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(r => r.period === profile.period && r.institution === profile.institution);
  } catch (err) {
    console.error('[groups] Erro ao carregar salas do curso:', err);
    return [];
  }
}

// ── Busca última mensagem de uma sala ─────────────────────────────────────────
async function getLastMessage(rId) {
  try {
    const q = query(
      collection(db, 'subject_rooms', rId, 'messages'),
      orderBy('createdAt', 'desc'),
      limit(1)
    );
    const snap = await getDocs(q);
    if (snap.empty) return null;
    return snap.docs[0].data();
  } catch { return null; }
}

// ── Renderização da aba Salas ─────────────────────────────────────────────────
export async function renderGroupsSection(currentUid) {
  const container = document.getElementById('groups-list');
  if (!container) return;
  container.innerHTML = `<div class="feed-loading">⏳ Carregando salas...</div>`;

  const profile = await loadFullAcademicProfile(currentUid);

  if (!profile?.courseId || !profile?.period) {
    container.innerHTML = `
      <div class="groups-no-profile">
        <div class="groups-no-profile-icon">🎓</div>
        <p>Configure seu perfil em <strong>Turmas</strong> para ver as salas do seu curso.</p>
        <button class="btn-primary" onclick="window.switchSocialTab('turmas')">
          Ir para Turmas
        </button>
      </div>
    `;
    return;
  }

  // Carrega salas do curso + verificação de membro em paralelo
  const courseRooms = await loadCourseRooms(profile);

  if (!courseRooms.length) {
    container.innerHTML = `
      <div class="feed-empty">
        Nenhuma sala encontrada para seu curso e período ainda.
        Configure suas matérias em <strong>Turmas</strong> para criá-las.
      </div>
    `;
    return;
  }

  // Verifica membros em paralelo
  const membershipResults = await Promise.all(
    courseRooms.map(r => isRoomMember(r.id, currentUid))
  );

  // Busca última mensagem para preview (em paralelo, com timeout implícito)
  const lastMsgResults = await Promise.all(
    courseRooms.map(r => getLastMessage(r.id))
  );

  // Agrupa por semestre
  const bySemester = {};
  courseRooms.forEach((room, i) => {
    const sem = room.semester || '?';
    if (!bySemester[sem]) bySemester[sem] = [];
    bySemester[sem].push({
      ...room,
      isMember: membershipResults[i],
      lastMsg:  lastMsgResults[i],
    });
  });

  const course   = FACAPE_COURSES.find(c => c.id === profile.courseId);
  const sigla    = course?.sigla || profile.courseId || '';
  const periodLabel = { matutino:'Matutino', vespertino:'Vespertino', noturno:'Noturno', integral:'Integral', ead:'EaD' };
  const per = periodLabel[profile.period] || profile.period;

  container.innerHTML = `
    <div class="groups-header-info">
      <span class="groups-course-label">📚 ${esc(course?.name || profile.courseId)} · ${esc(per)}</span>
      <span class="groups-total">${courseRooms.length} sala${courseRooms.length !== 1 ? 's' : ''} encontrada${courseRooms.length !== 1 ? 's' : ''}</span>
    </div>
    ${Object.keys(bySemester)
      .sort((a, b) => Number(a) - Number(b))
      .map(sem => _renderSemesterSection(sem, bySemester[sem], sigla, currentUid, profile))
      .join('')}
  `;
}

function _renderSemesterSection(sem, rooms, sigla, uid, profile) {
  const semLabel = sem === '?' ? 'Sem semestre' : `${sem}º Semestre`;
  return `
    <details class="groups-semester-section" open>
      <summary class="groups-semester-header">
        <span class="groups-semester-title">${esc(semLabel)}</span>
        <span class="groups-semester-count">${rooms.length} sala${rooms.length !== 1 ? 's' : ''}</span>
      </summary>
      <div class="groups-semester-rooms">
        ${rooms.map(r => _renderRoomCard(r, uid, profile)).join('')}
      </div>
    </details>
  `;
}

function _renderRoomCard(room, uid, profile) {
  const lastMsgText = room.lastMsg
    ? `<span class="groups-last-msg">${esc((room.lastMsg.text || '').slice(0, 50))}${(room.lastMsg.text || '').length > 50 ? '…' : ''}</span>
       <span class="groups-last-time">${fmtDate(room.lastMsg.createdAt)}</span>`
    : `<span class="groups-last-msg" style="font-style:italic;color:var(--text-muted)">Sem mensagens ainda</span>`;

  const actionBtn = room.isMember
    ? `<button class="btn-primary groups-room-btn" onclick="window._openChat('${room.id}')">Abrir</button>`
    : `<button class="btn-secondary groups-room-btn" onclick="window._groupsJoinRoom('${room.id}','${esc(room.subjectName)}','${esc(profile.courseId)}',${room.semester || 1},'${esc(profile.period)}', this)">Entrar</button>`;

  return `
    <div class="groups-room-card" data-room-id="${room.id}">
      <div class="groups-room-icon">📚</div>
      <div class="groups-room-info">
        <div class="groups-room-name">${esc(room.subjectName)}</div>
        <div class="groups-room-meta">👥 ${room.memberCount || 0} membro${(room.memberCount || 0) !== 1 ? 's' : ''}</div>
        <div class="groups-room-preview">${lastMsgText}</div>
      </div>
      <div class="groups-room-action">${actionBtn}</div>
    </div>
  `;
}

// ── Handler: entrar em sala pelo painel Salas ──────────────────────────────────
window._groupsJoinRoom = async function(rId, subjectName, courseId, semester, period, btn) {
  const uid = auth.currentUser?.uid;
  if (!uid) return;

  if (btn) { btn.disabled = true; btn.textContent = '...'; }

  // Garante que a sala existe com os campos corretos
  const profile = await loadFullAcademicProfile(uid);
  if (profile) {
    await ensureSubjectRoom(
      profile.institution, courseId, semester, period, subjectName, ''
    );
  }

  const ok = await joinSubjectRoom(rId, uid);

  if (ok) {
    showToast(`✅ Você entrou em ${subjectName}!`);
    // Atualiza o card para mostrar "Abrir"
    if (btn) {
      btn.textContent = 'Abrir';
      btn.className = 'btn-primary groups-room-btn';
      btn.onclick = () => window._openChat(rId);
      btn.disabled = false;
    }
    // Recarrega turmas tab para incluir a nova sala
    const { renderTurmasTab } = await import('./turmas.js');
    // não bloqueia a UI — dispara em background
    renderTurmasTab(uid).catch(() => {});
  } else {
    showToast('Erro ao entrar na sala. Tente novamente.');
    if (btn) { btn.disabled = false; btn.textContent = 'Entrar'; }
  }
};

// ── CSS injetado para a aba Salas ─────────────────────────────────────────────
(function _injectGroupsStyles() {
  if (document.getElementById('groups-styles')) return;
  const style = document.createElement('style');
  style.id = 'groups-styles';
  style.textContent = `
    .groups-no-profile {
      text-align: center;
      padding: 40px 20px;
      color: var(--text-muted, #888);
    }
    .groups-no-profile-icon { font-size: 40px; margin-bottom: 12px; }
    .groups-no-profile p { margin-bottom: 16px; font-size: 14px; line-height: 1.5; }

    .groups-header-info {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0 12px;
      font-size: 13px;
      color: var(--text-muted, #888);
    }
    .groups-course-label { font-weight: 600; color: var(--text, #e0e0e0); }

    .groups-semester-section {
      margin-bottom: 12px;
      border: 1px solid var(--border, #2a2a3e);
      border-radius: 12px;
      overflow: hidden;
    }
    .groups-semester-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 14px;
      cursor: pointer;
      background: var(--bg-secondary, #1a1a2e);
      list-style: none;
      -webkit-tap-highlight-color: transparent;
    }
    .groups-semester-header::-webkit-details-marker { display: none; }
    .groups-semester-title { font-weight: 600; font-size: 14px; }
    .groups-semester-count { font-size: 12px; color: var(--text-muted, #888); }
    .groups-semester-rooms { padding: 8px 0; }

    .groups-room-card {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border, #2a2a3e);
    }
    .groups-room-card:last-child { border-bottom: none; }
    .groups-room-icon { font-size: 22px; flex-shrink: 0; }
    .groups-room-info { flex: 1; min-width: 0; }
    .groups-room-name {
      font-weight: 600;
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .groups-room-meta { font-size: 12px; color: var(--text-muted, #888); margin-top: 1px; }
    .groups-room-preview {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 3px;
    }
    .groups-last-msg {
      font-size: 12px;
      color: var(--text-muted, #888);
      flex: 1;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .groups-last-time { font-size: 11px; color: var(--text-muted, #888); flex-shrink: 0; }
    .groups-room-action { flex-shrink: 0; }
    .groups-room-btn {
      padding: 6px 14px;
      font-size: 13px;
      border-radius: 20px;
      white-space: nowrap;
    }
  `;
  document.head.appendChild(style);
})();
