// ===== SOCIAL: GROUPS.JS =====
// Salas / fóruns por disciplina — NOVO MÓDULO

import { db, auth } from '../firebase.js';

// CORREÇÃO: import estático no lugar de top-level await
import {
  collection, addDoc, getDoc, getDocs, doc, updateDoc,
  arrayUnion, query, orderBy, limit, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ---- Criar novo grupo/sala ----
export async function createGroup({ name, subject, institution }) {
  
  const user = auth.currentUser;
  if (!user) return null;

  try {
    const ref = await addDoc(collection(db, 'groups'), {
      name: name?.trim() || 'Grupo sem nome',
      subject: subject?.trim() || '',
      institution: institution?.trim() || '',
      members: [user.uid],
      posts: [],
      createdAt: serverTimestamp(),
      createdBy: user.uid,
    });
    return ref.id;
  } catch (err) {
    console.error('[groups] Erro ao criar grupo:', err);
    return null;
  }
}

// ---- Entrar em um grupo ----
export async function joinGroup(groupId) {
  
  const user = auth.currentUser;
  if (!user) return false;
  try {
    await updateDoc(doc(db, 'groups', groupId), {
      members: arrayUnion(user.uid),
    });
    return true;
  } catch (err) {
    console.error('[groups] Erro ao entrar no grupo:', err);
    return false;
  }
}

// ---- Listar grupos (por disciplina ou todos) ----
export async function listGroups(subject = null, limitN = 20) {
  try {
    const ref = collection(db, 'groups');
    const q = query(ref, orderBy('createdAt', 'desc'), limit(limitN));
    const snap = await getDocs(q);
    const groups = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (subject) return groups.filter(g => g.subject?.toLowerCase().includes(subject.toLowerCase()));
    return groups;
  } catch (err) {
    console.error('[groups] Erro ao listar grupos:', err);
    return [];
  }
}

// ---- Carregar um grupo por ID ----
export async function loadGroup(groupId) {
  try {
    const snap = await getDoc(doc(db, 'groups', groupId));
    if (!snap.exists()) return null;
    return { id: snap.id, ...snap.data() };
  } catch (err) {
    console.error('[groups] Erro ao carregar grupo:', err);
    return null;
  }
}

// ---- Renderizar lista de grupos na página social ----
export async function renderGroupsSection(currentUid) {
  const container = document.getElementById('groups-list');
  if (!container) return;
  container.innerHTML = `<div class="feed-loading">⏳ Carregando salas...</div>`;

  const groups = await listGroups();
  if (!groups.length) {
    container.innerHTML = `<div class="feed-empty">Nenhuma sala criada ainda. Crie a sua! 🏫</div>`;
    return;
  }

  container.innerHTML = groups.map(g => {
    const isMember = (g.members || []).includes(currentUid);
    return `
      <div class="group-card">
        <div class="group-card-info">
          <span class="group-card-name">${escapeHtml(g.name)}</span>
          <span class="group-card-subject">${escapeHtml(g.subject || 'Geral')}</span>
          ${g.institution ? `<span class="group-card-inst">🏛 ${escapeHtml(g.institution)}</span>` : ''}
          <span class="group-card-members">👥 ${(g.members || []).length} membros</span>
        </div>
        <button class="user-card-btn ${isMember ? 'btn-secondary' : ''}"
          onclick="window.handleJoinGroup('${g.id}', this)">
          ${isMember ? '✔ Membro' : '➕ Entrar'}
        </button>
      </div>
    `;
  }).join('');
}

// ---- Handler global: entrar em grupo ----
window.handleJoinGroup = async function(groupId, btn) {
  const ok = await joinGroup(groupId);
  if (ok && btn) { btn.textContent = '✔ Membro'; btn.classList.add('btn-secondary'); }
};

// ---- Modal: criar novo grupo ----
window.openCreateGroupModal = function() {
  const overlay = document.getElementById('modal-overlay');
  const body = document.getElementById('modal-body');
  if (!overlay || !body) return;

  body.innerHTML = `
    <div class="modal-header"><h3>🏫 Nova Sala / Grupo</h3></div>
    <div class="modal-form">
      <div class="form-group">
        <label class="form-label">Nome do Grupo</label>
        <input id="grp-name" class="form-input" type="text" placeholder="Ex: Cálculo II - UFPE 2025">
      </div>
      <div class="form-group">
        <label class="form-label">Disciplina</label>
        <input id="grp-subject" class="form-input" type="text" placeholder="Ex: Cálculo, Física, POO...">
      </div>
      <div class="form-group">
        <label class="form-label">Instituição (opcional)</label>
        <input id="grp-institution" class="form-input" type="text" placeholder="Ex: UFPE, USP...">
      </div>
      <button class="btn-primary" onclick="window.submitCreateGroup()">Criar Sala</button>
    </div>
  `;
  overlay.classList.add('active');
  document.getElementById('modal-container')?.classList.add('active');
};

window.submitCreateGroup = async function() {
  const name = document.getElementById('grp-name')?.value?.trim();
  const subject = document.getElementById('grp-subject')?.value?.trim();
  const institution = document.getElementById('grp-institution')?.value?.trim();
  if (!name) return;

  const id = await createGroup({ name, subject, institution });
  window.closeModal?.();
  if (id) {
    
    renderGroupsSection(auth.currentUser?.uid);
  }
};

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
