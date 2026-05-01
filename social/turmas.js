// ===== SOCIAL: TURMAS.JS =====
// Sistema de Turmas por Matéria vinculadas à faculdade/curso do usuário.
// Permite que alunos da mesma matéria compartilhem avisos, documentos e imagens.

import { db, auth } from '../firebase.js';

import {
  doc, getDoc, setDoc, addDoc, getDocs, updateDoc, deleteDoc,
  collection, query, where, orderBy, limit, onSnapshot,
  serverTimestamp, arrayUnion, arrayRemove,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── Estado local ──────────────────────────────────────────────────────────────
let _unsubMural = null;
let _currentRoomId = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const now = new Date();
  const diff = Math.floor((now - d) / 60000); // minutos
  if (diff < 1)  return 'agora';
  if (diff < 60) return `${diff}min`;
  if (diff < 1440) return `${Math.floor(diff/60)}h`;
  return d.toLocaleDateString('pt-BR', { day:'2-digit', month:'short' });
}

function postTypeIcon(type) {
  return { aviso:'📢', documento:'📄', imagem:'🖼️', discussao:'💬', link:'🔗' }[type] || '💬';
}

// ── Perfil Acadêmico Completo (com matérias) ─────────────────────────────────

export async function loadFullAcademicProfile(uid) {
  try {
    const snap = await getDoc(doc(db, 'users', uid, 'profile', 'academic'));
    if (snap.exists()) return snap.data();
    return null;
  } catch { return null; }
}

export async function saveFullAcademicProfile(uid, data) {
  try {
    await setDoc(doc(db, 'users', uid, 'profile', 'academic'), {
      institution: data.institution || '',
      course:      data.course || '',
      semester:    parseInt(data.semester) || 1,
      period:      data.period || 'noturno',
      subjects:    data.subjects || [],   // [{ name, code }]
      skills:      data.skills || [],
      bio:         data.bio || '',
      updatedAt:   new Date().toISOString(),
    }, { merge: true });

    // Atualiza user_profiles para busca pública
    await setDoc(doc(db, 'user_profiles', uid), {
      institution: data.institution || '',
      course:      data.course || '',
    }, { merge: true });

    return true;
  } catch (err) {
    console.error('[turmas] Erro ao salvar perfil:', err);
    return false;
  }
}

// ── Salas de Matéria ──────────────────────────────────────────────────────────
// ID de sala = slugify(institution + '::' + subject.code ou subject.name)

function roomId(institution, subjectName, subjectCode) {
  const raw = `${institution}::${subjectCode || subjectName}`;
  return raw.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9:]/g, '_')
    .slice(0, 100);
}

export async function ensureSubjectRoom(institution, subjectName, subjectCode) {
  const id = roomId(institution, subjectName, subjectCode);
  const ref = doc(db, 'subject_rooms', id);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      institution, subjectName,
      subjectCode: subjectCode || '',
      memberCount: 0,
      createdAt: serverTimestamp(),
    });
  }
  return id;
}

export async function joinSubjectRoom(roomId, uid) {
  try {
    await setDoc(doc(db, 'subject_rooms', roomId, 'members', uid), {
      uid, joinedAt: serverTimestamp(),
    });
    // Incrementa contagem (sem transaction para simplicidade)
    const snap = await getDoc(doc(db, 'subject_rooms', roomId));
    const cur = snap.data()?.memberCount || 0;
    await updateDoc(doc(db, 'subject_rooms', roomId), { memberCount: cur + 1 });
    return true;
  } catch (err) {
    console.error('[turmas] Erro ao entrar na sala:', err);
    return false;
  }
}

export async function leaveSubjectRoom(roomId, uid) {
  try {
    await deleteDoc(doc(db, 'subject_rooms', roomId, 'members', uid));
    const snap = await getDoc(doc(db, 'subject_rooms', roomId));
    const cur = snap.data()?.memberCount || 1;
    await updateDoc(doc(db, 'subject_rooms', roomId), { memberCount: Math.max(0, cur - 1) });
    return true;
  } catch { return false; }
}

export async function isRoomMember(roomId, uid) {
  try {
    const snap = await getDoc(doc(db, 'subject_rooms', roomId, 'members', uid));
    return snap.exists();
  } catch { return false; }
}

// Garante inscrição automática nas salas das matérias do usuário
export async function syncUserRooms(uid, profile) {
  if (!profile?.institution || !profile?.subjects?.length) return;
  for (const sub of profile.subjects) {
    const rid = await ensureSubjectRoom(profile.institution, sub.name, sub.code);
    await joinSubjectRoom(rid, uid);
  }
}

// Lista salas do usuário (baseado no perfil acadêmico)
export async function listMyRooms(uid) {
  const profile = await loadFullAcademicProfile(uid);
  if (!profile?.subjects?.length || !profile?.institution) return [];

  const rooms = [];
  for (const sub of profile.subjects) {
    const rid = roomId(profile.institution, sub.name, sub.code);
    try {
      const snap = await getDoc(doc(db, 'subject_rooms', rid));
      if (snap.exists()) {
        const isMember = await isRoomMember(rid, uid);
        rooms.push({ id: rid, ...snap.data(), isMember, subjectRef: sub });
      } else {
        // Sala ainda não criada — cria agora
        await ensureSubjectRoom(profile.institution, sub.name, sub.code);
        await joinSubjectRoom(rid, uid);
        rooms.push({
          id: rid, institution: profile.institution,
          subjectName: sub.name, subjectCode: sub.code || '',
          memberCount: 1, isMember: true, subjectRef: sub,
        });
      }
    } catch { /* ignora salas que falharam */ }
  }
  return rooms;
}

// ── Posts do Mural ────────────────────────────────────────────────────────────

export async function postToMural(roomId, { type, content, fileUrl, fileName, fileType }) {
  const user = auth.currentUser;
  if (!user || !content?.trim()) return null;
  try {
    const ref = await addDoc(collection(db, 'subject_rooms', roomId, 'posts'), {
      authorId:   user.uid,
      authorName: user.displayName || user.email.split('@')[0],
      type:       type || 'discussao',
      content:    content.trim(),
      fileUrl:    fileUrl || null,
      fileName:   fileName || null,
      fileType:   fileType || null,
      likes:      [],
      createdAt:  serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    console.error('[turmas] Erro ao postar:', err);
    return null;
  }
}

export async function deletePost(roomId, postId, uid) {
  try {
    const ref = doc(db, 'subject_rooms', roomId, 'posts', postId);
    const snap = await getDoc(ref);
    if (!snap.exists() || snap.data().authorId !== uid) return false;
    await deleteDoc(ref);
    return true;
  } catch { return false; }
}

export async function toggleLikePost(roomId, postId, uid) {
  try {
    const ref = doc(db, 'subject_rooms', roomId, 'posts', postId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const likes = snap.data().likes || [];
    if (likes.includes(uid)) {
      await updateDoc(ref, { likes: arrayRemove(uid) });
    } else {
      await updateDoc(ref, { likes: arrayUnion(uid) });
    }
  } catch (err) { console.error('[turmas] Erro ao curtir:', err); }
}

// ── Listener em Tempo Real do Mural ──────────────────────────────────────────

export function subscribeMural(roomId, callback) {
  if (_unsubMural) { _unsubMural(); _unsubMural = null; }
  _currentRoomId = roomId;
  const q = query(
    collection(db, 'subject_rooms', roomId, 'posts'),
    orderBy('createdAt', 'desc'),
    limit(50)
  );
  _unsubMural = onSnapshot(q, (snap) => {
    const posts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    callback(posts);
  }, (err) => {
    console.error('[turmas] Erro no listener do mural:', err);
    callback(null, err);
  });
  return () => { if (_unsubMural) { _unsubMural(); _unsubMural = null; } };
}

// ── Renderização da aba Turmas ────────────────────────────────────────────────

export async function renderTurmasTab(uid) {
  const container = document.getElementById('turmas-tab-content');
  if (!container) return;

  const profile = await loadFullAcademicProfile(uid);

  // Usuário sem perfil acadêmico → mostra onboarding
  if (!profile?.institution || !profile?.subjects?.length) {
    renderOnboarding(container, uid);
    return;
  }

  // Mostra salas do usuário
  container.innerHTML = `
    <div class="turmas-profile-bar">
      <div class="turmas-profile-info">
        <span class="turmas-inst">${esc(profile.institution)}</span>
        <span class="turmas-course">${esc(profile.course)} · ${profile.semester}º sem · ${esc(profile.period || 'noturno')}</span>
      </div>
      <button class="turmas-edit-btn" onclick="window.openTurmasOnboarding()">✏️ Editar</button>
    </div>
    <div class="turmas-rooms-list" id="turmas-rooms-list">
      <div class="turmas-loading">⏳ Carregando suas turmas...</div>
    </div>
  `;

  const rooms = await listMyRooms(uid);
  const listEl = document.getElementById('turmas-rooms-list');
  if (!listEl) return;

  if (!rooms.length) {
    listEl.innerHTML = `<div class="turmas-empty">Nenhuma turma encontrada. <button onclick="window.openTurmasOnboarding()">Adicionar matérias</button></div>`;
    return;
  }

  listEl.innerHTML = rooms.map(room => `
    <div class="turma-card" onclick="window.openMural('${room.id}', '${esc(room.subjectName)}')">
      <div class="turma-card-left">
        <div class="turma-card-icon">📚</div>
        <div class="turma-card-info">
          <span class="turma-card-name">${esc(room.subjectName)}</span>
          ${room.subjectCode ? `<span class="turma-card-code">${esc(room.subjectCode)}</span>` : ''}
          <span class="turma-card-members">👥 ${room.memberCount || 1} aluno${(room.memberCount||1) !== 1 ? 's' : ''}</span>
        </div>
      </div>
      <div class="turma-card-arrow">›</div>
    </div>
  `).join('');
}

// ── Onboarding: coleta dados acadêmicos ──────────────────────────────────────

function renderOnboarding(container, uid) {
  container.innerHTML = `
    <div class="turmas-onboarding">
      <div class="turmas-onboarding-icon">🎓</div>
      <h3 class="turmas-onboarding-title">Configure seu Perfil Acadêmico</h3>
      <p class="turmas-onboarding-desc">Informe sua faculdade e matérias para interagir com seus colegas de turma.</p>
      <button class="btn-primary turmas-onboarding-btn" onclick="window.openTurmasOnboarding()">
        Configurar agora
      </button>
    </div>
  `;
}

window.openTurmasOnboarding = async function() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const profile = await loadFullAcademicProfile(uid) || {};

  // Monta lista de matérias existentes
  const subjectsJson = JSON.stringify(profile.subjects || []).replace(/'/g, '&#39;');

  openModal('🎓 Perfil Acadêmico', `
    <div class="turmas-form">
      <div class="form-group">
        <label class="form-label">Instituição de Ensino *</label>
        <input id="ta-institution" class="form-input" placeholder="Ex: UFPE, USP, IFPE..." value="${esc(profile.institution || '')}">
      </div>
      <div class="form-group">
        <label class="form-label">Curso *</label>
        <input id="ta-course" class="form-input" placeholder="Ex: Engenharia de Software" value="${esc(profile.course || '')}">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Semestre</label>
          <input id="ta-semester" class="form-input" type="number" min="1" max="20" value="${profile.semester || 1}">
        </div>
        <div class="form-group">
          <label class="form-label">Período</label>
          <select id="ta-period" class="form-select">
            <option value="matutino" ${profile.period === 'matutino' ? 'selected' : ''}>Matutino</option>
            <option value="vespertino" ${profile.period === 'vespertino' ? 'selected' : ''}>Vespertino</option>
            <option value="noturno" ${(profile.period === 'noturno' || !profile.period) ? 'selected' : ''}>Noturno</option>
            <option value="integral" ${profile.period === 'integral' ? 'selected' : ''}>Integral</option>
            <option value="ead" ${profile.period === 'ead' ? 'selected' : ''}>EaD</option>
          </select>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Minhas Matérias</label>
        <div class="turmas-subjects-list" id="ta-subjects-list"></div>
        <div class="turmas-add-subject">
          <input id="ta-sub-name" class="form-input" placeholder="Nome da matéria" style="flex:2">
          <input id="ta-sub-code" class="form-input" placeholder="Código (opcional)" style="flex:1">
          <button class="btn-secondary" onclick="window._taAddSubject()" style="white-space:nowrap">+ Adicionar</button>
        </div>
      </div>

      <button class="btn-primary" onclick="window._taSave()" style="width:100%;margin-top:8px">
        💾 Salvar e Entrar nas Turmas
      </button>
    </div>
  `);

  // Estado interno das matérias
  let subjects = profile.subjects ? [...profile.subjects] : [];
  renderSubjectChips();

  function renderSubjectChips() {
    const el = document.getElementById('ta-subjects-list');
    if (!el) return;
    if (!subjects.length) {
      el.innerHTML = `<span class="turmas-no-subjects">Nenhuma matéria adicionada ainda</span>`;
      return;
    }
    el.innerHTML = subjects.map((s, i) => `
      <div class="turmas-subject-chip">
        <span>${esc(s.name)}${s.code ? ` <small>(${esc(s.code)})</small>` : ''}</span>
        <button onclick="window._taRemoveSubject(${i})" title="Remover">×</button>
      </div>
    `).join('');
  }

  window._taAddSubject = function() {
    const name = document.getElementById('ta-sub-name')?.value?.trim();
    if (!name) { showToast('Digite o nome da matéria'); return; }
    const code = document.getElementById('ta-sub-code')?.value?.trim() || '';
    if (subjects.find(s => s.name.toLowerCase() === name.toLowerCase())) {
      showToast('Matéria já adicionada'); return;
    }
    subjects.push({ name, code });
    document.getElementById('ta-sub-name').value = '';
    document.getElementById('ta-sub-code').value = '';
    renderSubjectChips();
  };

  window._taRemoveSubject = function(idx) {
    subjects.splice(idx, 1);
    renderSubjectChips();
  };

  window._taSave = async function() {
    const institution = document.getElementById('ta-institution')?.value?.trim();
    const course = document.getElementById('ta-course')?.value?.trim();
    const semester = parseInt(document.getElementById('ta-semester')?.value) || 1;
    const period = document.getElementById('ta-period')?.value || 'noturno';

    if (!institution) { showToast('Informe a instituição'); return; }
    if (!course) { showToast('Informe o curso'); return; }
    if (!subjects.length) { showToast('Adicione pelo menos uma matéria'); return; }

    const btn = document.querySelector('button[onclick="window._taSave()"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }

    const ok = await saveFullAcademicProfile(uid, { institution, course, semester, period, subjects });
    if (!ok) { showToast('Erro ao salvar. Tente novamente.'); if (btn) { btn.disabled = false; btn.textContent = '💾 Salvar'; } return; }

    // Sincroniza salas automaticamente
    await syncUserRooms(uid, { institution, subjects });

    closeModal();
    showToast('✅ Perfil acadêmico salvo! Entrando nas turmas...');
    // Re-renderiza a aba
    const container = document.getElementById('turmas-tab-content');
    if (container) await renderTurmasTab(uid);
  };
};

// ── Mural de uma matéria ──────────────────────────────────────────────────────

window.openMural = async function(roomId, subjectName) {
  const uid = auth.currentUser?.uid;
  if (!uid) return;

  openModal(`📚 ${subjectName}`, `
    <div class="mural-container">
      <div class="mural-new-post">
        <select id="mural-type" class="form-select mural-type-sel">
          <option value="discussao">💬 Discussão</option>
          <option value="aviso">📢 Aviso</option>
          <option value="link">🔗 Link</option>
          <option value="documento">📄 Documento (link)</option>
          <option value="imagem">🖼️ Imagem (link)</option>
        </select>
        <textarea id="mural-content" class="form-textarea mural-textarea" placeholder="Escreva um aviso, compartilhe um link ou inicie uma discussão..." rows="3"></textarea>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn-primary" onclick="window._muralPost('${roomId}')">Publicar</button>
        </div>
      </div>
      <div id="mural-posts-list" class="mural-posts-list">
        <div class="turmas-loading">⏳ Carregando mural...</div>
      </div>
    </div>
  `);

  // Inicia listener em tempo real
  subscribeMural(roomId, (posts, err) => {
    const listEl = document.getElementById('mural-posts-list');
    if (!listEl) return;
    if (err || !posts) {
      listEl.innerHTML = `<div class="turmas-empty">Erro ao carregar o mural. Verifique sua conexão.</div>`;
      return;
    }
    if (!posts.length) {
      listEl.innerHTML = `<div class="mural-empty">Nenhuma publicação ainda. Seja o primeiro! 🚀</div>`;
      return;
    }
    listEl.innerHTML = posts.map(p => renderMuralPost(p, uid, roomId)).join('');
  });
};

function renderMuralPost(post, uid, roomId) {
  const isOwn = post.authorId === uid;
  const likes = (post.likes || []).length;
  const liked = (post.likes || []).includes(uid);
  const avatar = (post.authorName || 'A')[0].toUpperCase();

  const typeColors = {
    aviso: '#ff6b35',
    documento: '#1e90ff',
    imagem: '#2ed573',
    link: '#a29bfe',
    discussao: 'var(--accent)',
  };
  const color = typeColors[post.type] || 'var(--accent)';

  let extra = '';
  if (post.fileUrl) {
    if (post.fileType === 'imagem' || post.type === 'imagem') {
      extra = `<img src="${esc(post.fileUrl)}" alt="imagem" class="mural-post-img" onerror="this.style.display='none'">`;
    } else if (post.type === 'link' || post.type === 'documento') {
      extra = `<a href="${esc(post.fileUrl)}" target="_blank" rel="noopener" class="mural-post-link">
        📎 ${esc(post.fileName || post.fileUrl)}
      </a>`;
    }
  }

  // Detecta links no conteúdo
  const contentWithLinks = esc(post.content).replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener" class="mural-inline-link">$1</a>'
  );

  return `
    <div class="mural-post" id="mpost-${post.id}">
      <div class="mural-post-header">
        <div class="mural-post-avatar">${avatar}</div>
        <div class="mural-post-meta">
          <span class="mural-post-author">${esc(post.authorName)}</span>
          <div class="mural-post-badges">
            <span class="mural-post-type-badge" style="background:${color}22;color:${color}">
              ${postTypeIcon(post.type)} ${esc(post.type)}
            </span>
            <span class="mural-post-time">${fmtDate(post.createdAt)}</span>
          </div>
        </div>
        ${isOwn ? `<button class="mural-del-btn" onclick="window._muralDelete('${roomId}','${post.id}')" title="Excluir">🗑️</button>` : ''}
      </div>
      <div class="mural-post-content">${contentWithLinks}</div>
      ${extra}
      <div class="mural-post-actions">
        <button class="mural-like-btn ${liked ? 'liked' : ''}" onclick="window._muralLike('${roomId}','${post.id}')">
          ${liked ? '❤️' : '🤍'} ${likes}
        </button>
      </div>
    </div>
  `;
}

window._muralPost = async function(roomId) {
  const content = document.getElementById('mural-content')?.value?.trim();
  const type = document.getElementById('mural-type')?.value || 'discussao';
  if (!content) { showToast('Escreva algo antes de publicar'); return; }

  const btn = document.querySelector('button[onclick*="_muralPost"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Publicando...'; }

  // Se é link/documento/imagem, o conteúdo pode conter a URL
  let fileUrl = null, fileName = null;
  const urlMatch = content.match(/https?:\/\/[^\s]+/);
  if ((type === 'link' || type === 'documento' || type === 'imagem') && urlMatch) {
    fileUrl = urlMatch[0];
    fileName = fileUrl.split('/').pop().split('?')[0] || fileUrl;
  }

  const id = await postToMural(roomId, { type, content, fileUrl, fileName });
  if (btn) { btn.disabled = false; btn.textContent = 'Publicar'; }
  if (id) {
    const ta = document.getElementById('mural-content');
    if (ta) ta.value = '';
    showToast('✅ Publicado no mural!');
  } else {
    showToast('Erro ao publicar. Tente novamente.');
  }
};

window._muralDelete = async function(roomId, postId) {
  if (!confirm('Excluir esta publicação?')) return;
  const uid = auth.currentUser?.uid;
  const ok = await deletePost(roomId, postId, uid);
  if (!ok) showToast('Não foi possível excluir.');
};

window._muralLike = async function(roomId, postId) {
  const uid = auth.currentUser?.uid;
  if (!uid) { showToast('Faça login para curtir'); return; }
  await toggleLikePost(roomId, postId, uid);
};

// ── Inicialização ─────────────────────────────────────────────────────────────

export function initTurmas() {
  // Garante que o listener do mural é cancelado ao fechar o modal
  const modalOverlay = document.getElementById('modal-overlay');
  if (modalOverlay) {
    modalOverlay.addEventListener('click', () => {
      if (_unsubMural) { _unsubMural(); _unsubMural = null; _currentRoomId = null; }
    });
  }
}
