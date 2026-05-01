// ===== CLASSROOM.JS =====
// Integração com Google Classroom via OAuth 2.0 Authorization Code + PKCE.
// A client_secret NUNCA fica no frontend — a troca de token é feita via
// Firebase Function (classroomToken), que mantém a secret segura no servidor.

import { db, auth } from './firebase.js';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ─── CONFIGURAÇÃO ─────────────────────────────────────────────────────────────
const CLASSROOM_CLIENT_ID = '92968084905-1ete8rjlfs6e3uo3pj4h351bdm8ak947.apps.googleusercontent.com';
const CLASSROOM_SCOPES = [
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
  'https://www.googleapis.com/auth/classroom.announcements.readonly',
  'https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly',
].join(' ');

// URL da Firebase Function de proxy
const CLASSROOM_TOKEN_FUNCTION = 'https://classroomtoken-xesxvi757a-uc.a.run.app';

// ─── ESTADO INTERNO ───────────────────────────────────────────────────────────
let _STATE = null;
let _hooks  = null;

// ─── PONTO DE ENTRADA ─────────────────────────────────────────────────────────
export function initClassroom(STATE, hooks) {
  _STATE = STATE;
  _hooks  = hooks;

  injetarBotaoClassroom();
  injetarEstilosClassroom();

  const uid = auth.currentUser?.uid;
  if (uid) sincronizarSeConectado(uid);

  window._renderPostsClassroom = async () => {
    if (!uid) return;
    const token = await getTokenValido(uid);
    if (token) renderPostsClassroom(token);
  };
}

// ─── PKCE helpers ─────────────────────────────────────────────────────────────
function gerarVerifier() {
  const arr = new Uint8Array(48);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function gerarChallenge(verifier) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ─── OAUTH: CONECTAR (Authorization Code + PKCE) ─────────────────────────────
async function conectarClassroom() {
  const uid = auth.currentUser?.uid;
  if (!uid) { _hooks.showToast('Faça login primeiro.'); return; }

  const verifier  = gerarVerifier();
  const challenge = await gerarChallenge(verifier);
  const state     = crypto.randomUUID();

  sessionStorage.setItem('cl_verifier', verifier);
  sessionStorage.setItem('cl_state',    state);
  sessionStorage.setItem('cl_uid',      uid);

  const redirectUri = `${location.origin}/classroom-callback.html`;
  const params = new URLSearchParams({
    client_id:             CLASSROOM_CLIENT_ID,
    redirect_uri:          redirectUri,
    response_type:         'code',
    scope:                 CLASSROOM_SCOPES,
    state,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    access_type:           'offline',   // garante refresh_token
    prompt:                'consent',   // força consentimento para receber refresh_token
  });

  const popup = window.open(
    `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    'classroom-oauth',
    'width=500,height=650,menubar=no,toolbar=no'
  );

  window.addEventListener('message', async function handler(e) {
    if (e.origin !== location.origin) return;
    if (e.data?.type !== 'classroom-code') return;
    window.removeEventListener('message', handler);
    popup?.close();

    const { code, state: retState, error } = e.data;

    if (error || !code) {
      _hooks.showToast('❌ Autorização negada ou falhou.');
      return;
    }
    if (retState !== sessionStorage.getItem('cl_state')) {
      _hooks.showToast('❌ Erro de segurança (state mismatch). Tente novamente.');
      return;
    }

    await trocarCodePorToken(code, uid);
  });
}

// ─── TROCA CODE → TOKEN via Firebase Function (secret segura no servidor) ────
async function trocarCodePorToken(code, uid) {
  const verifier    = sessionStorage.getItem('cl_verifier');
  const redirectUri = `${location.origin}/classroom-callback.html`;

  try {
    setBotaoSincronizando(true);

    const idToken = await auth.currentUser.getIdToken();
    const resp = await fetch(CLASSROOM_TOKEN_FUNCTION, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        action:       'exchange',
        code,
        code_verifier: verifier,
        redirect_uri:  redirectUri,
      }),
    });

    const data = await resp.json();

    if (!resp.ok || !data.access_token) {
      console.error('[Classroom] exchange falhou:', data);
      _hooks.showToast(`❌ Falha ao conectar: ${data.error || 'erro desconhecido'}`);
      return;
    }

    // Limpa sessão temporária
    sessionStorage.removeItem('cl_verifier');
    sessionStorage.removeItem('cl_state');
    sessionStorage.removeItem('cl_uid');

    _hooks.showToast('✅ Google Classroom conectado!');
    atualizarBotaoClassroom(true);
    await sincronizarClassroom(uid, data.access_token);

  } catch (err) {
    console.error('[Classroom] Erro na troca de token:', err);
    _hooks.showToast('❌ Erro ao conectar com o Classroom.');
  } finally {
    setBotaoSincronizando(false);
  }
}

// ─── RENOVAR TOKEN via Firebase Function ─────────────────────────────────────
async function renovarToken(uid, refreshToken) {
  try {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) return null;

    const resp = await fetch(CLASSROOM_TOKEN_FUNCTION, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({ action: 'refresh', refresh_token: refreshToken }),
    });

    const data = await resp.json();
    if (!resp.ok || !data.access_token) return null;

    return data.access_token;
  } catch {
    return null;
  }
}

// ─── OBTER TOKEN VÁLIDO (com auto-refresh) ────────────────────────────────────
async function getTokenValido(uid) {
  try {
    const snap      = await getDoc(doc(db, 'users', uid));
    const classroom = snap.data()?.classroom;
    if (!classroom?.access_token) return null;

    // Token ainda válido (com margem de 2 minutos)
    if (Date.now() < classroom.expiresAt - 120_000) {
      return classroom.access_token;
    }

    // Token expirado — tenta renovar
    if (classroom.refresh_token) {
      const novoToken = await renovarToken(uid, classroom.refresh_token);
      if (novoToken) return novoToken;
    }

    // Sem refresh_token ou renovação falhou
    atualizarBotaoClassroom(false, true);
    return null;
  } catch {
    return null;
  }
}

// ─── SINCRONIZAÇÃO ────────────────────────────────────────────────────────────
async function sincronizarSeConectado(uid) {
  try {
    const token = await getTokenValido(uid);
    if (!token) return;
    atualizarBotaoClassroom(true);
    await sincronizarClassroom(uid, token);
  } catch (err) {
    console.warn('[Classroom] Erro ao verificar token:', err);
  }
}

async function sincronizarClassroom(uid, token) {
  try {
    setBotaoSincronizando(true);

    const cursosRes = await fetch(
      'https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE&pageSize=20',
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (cursosRes.status === 401) {
      // Token inválido — tenta renovar uma vez
      const snap = await getDoc(doc(db, 'users', uid));
      const refreshToken = snap.data()?.classroom?.refresh_token;
      if (refreshToken) {
        const novoToken = await renovarToken(uid, refreshToken);
        if (novoToken) {
          // Tenta de novo com token novo
          await sincronizarClassroom(uid, novoToken);
          return;
        }
      }
      await updateDoc(doc(db, 'users', uid), { 'classroom.access_token': null });
      atualizarBotaoClassroom(false, true);
      _hooks.showToast('🔄 Sessão do Classroom expirada. Reconecte.');
      return;
    }

    if (!cursosRes.ok) throw new Error(`Classroom API: ${cursosRes.status}`);
    const { courses = [] } = await cursosRes.json();

    if (courses.length === 0) {
      _hooks.showToast('Nenhuma turma ativa encontrada no Classroom.');
      setBotaoSincronizando(false);
      return;
    }

    const todasAtividades = await Promise.all(
      courses.map(curso => buscarAtividadesDaTurma(curso, token))
    );

    const novas = importarAtividades(todasAtividades.flat());

    if (novas > 0) {
      await _hooks.save();
      _hooks.renderTasks();
      _hooks.renderDashboard();
      _hooks.showToast(`📚 ${novas} atividade${novas > 1 ? 's' : ''} importada${novas > 1 ? 's' : ''} do Classroom!`);
    } else {
      _hooks.showToast('✅ Classroom sincronizado — nenhuma novidade.');
    }

    await updateDoc(doc(db, 'users', uid), {
      'classroom.lastSync': new Date().toISOString(),
    });

  } catch (err) {
    console.error('[Classroom] Erro na sincronização:', err);
    _hooks.showToast('❌ Erro ao sincronizar com o Classroom.');
  } finally {
    setBotaoSincronizando(false);
  }
}

async function buscarAtividadesDaTurma(curso, token) {
  try {
    const res = await fetch(
      `https://classroom.googleapis.com/v1/courses/${curso.id}/courseWork?pageSize=30&orderBy=dueDate+desc`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return [];
    const { courseWork = [] } = await res.json();
    return courseWork.map(cw => ({ ...cw, _nometurma: curso.name }));
  } catch { return []; }
}

function importarAtividades(atividades) {
  const idsExistentes = new Set(_STATE.tasks.map(t => t.classroomId).filter(Boolean));
  let novas = 0;

  for (const task of _STATE.tasks) {
    if (!task.classroomId) continue;
    if (task.subjectId && _STATE.subjects.find(s => s.id === task.subjectId)) continue;
    const subject = encontrarMateria(task.subjectName);
    if (subject) {
      task.subjectId    = subject.id;
      task.subjectColor = subject.color;
      task.subjectName  = subject.name;
    }
  }

  for (const cw of atividades) {
    if (idsExistentes.has(cw.id)) continue;

    let deadline = null;
    if (cw.dueDate) {
      const { year, month, day } = cw.dueDate;
      deadline = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    const subject = encontrarMateria(cw._nometurma);

    _STATE.tasks.push({
      id:           `classroom_${cw.id}`,
      classroomId:  cw.id,
      title:        cw.title || 'Atividade sem título',
      subjectId:    subject?.id    || null,
      subjectName:  subject?.name  || cw._nometurma,
      subjectColor: subject?.color || '#4285F4',
      type:         'work',
      deadline,
      notes:        cw.description || null,
      done:         false,
      createdAt:    cw.creationTime || new Date().toISOString(),
      source:       'classroom',
    });

    novas++;
  }

  return novas;
}

function encontrarMateria(nomeTurma) {
  if (!nomeTurma || !_STATE.subjects?.length) return null;
  const turmaLower = nomeTurma.toLowerCase();
  return _STATE.subjects.find(s => {
    const sLower = s.name.toLowerCase();
    return turmaLower.includes(sLower) || sLower.includes(turmaLower);
  }) || null;
}

// ─── BOTÃO NA SIDEBAR ─────────────────────────────────────────────────────────
function injetarBotaoClassroom() {
  if (document.getElementById('classroom-btn-wrapper')) return;

  const logoutBtn = document.querySelector('.sidebar-footer .logout-btn');
  if (!logoutBtn) return;

  const wrapper = document.createElement('div');
  wrapper.id = 'classroom-btn-wrapper';
  wrapper.className = 'classroom-btn-wrapper';
  wrapper.innerHTML = `
    <button id="classroom-connect-btn" class="classroom-btn" onclick="window._conectarClassroom()">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
      </svg>
      <span id="classroom-btn-label">Conectar Classroom</span>
    </button>
  `;
  logoutBtn.insertAdjacentElement('beforebegin', wrapper);

  window._conectarClassroom = async () => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const token = await getTokenValido(uid);
    if (token) {
      atualizarBotaoClassroom(true);
      await sincronizarClassroom(uid, token);
    } else {
      conectarClassroom();
    }
  };
}

function atualizarBotaoClassroom(conectado, expirado = false) {
  const btn   = document.getElementById('classroom-connect-btn');
  const label = document.getElementById('classroom-btn-label');
  if (!btn || !label) return;

  if (expirado) {
    label.textContent = '🔄 Reconectar Classroom';
    btn.classList.remove('classroom-btn--connected');
  } else if (conectado) {
    label.textContent = '📚 Sincronizar Classroom';
    btn.classList.add('classroom-btn--connected');
  } else {
    label.textContent = 'Conectar Classroom';
    btn.classList.remove('classroom-btn--connected');
  }
}

function setBotaoSincronizando(ativo) {
  const btn   = document.getElementById('classroom-connect-btn');
  const label = document.getElementById('classroom-btn-label');
  if (!btn || !label) return;
  btn.disabled      = ativo;
  label.textContent = ativo ? '⏳ Sincronizando...' : '📚 Sincronizar Classroom';
}

// ─── ESTILOS ──────────────────────────────────────────────────────────────────
function injetarEstilosClassroom() {
  if (document.getElementById('classroom-styles')) return;
  const style = document.createElement('style');
  style.id = 'classroom-styles';
  style.textContent = `
    .classroom-btn-wrapper { padding: 0 0 10px; width: 100%; }
    .classroom-btn {
      display: flex; align-items: center; gap: 8px; width: 100%;
      padding: 10px 14px;
      background: rgba(66, 133, 244, 0.1);
      border: 1px dashed rgba(66, 133, 244, 0.45);
      border-radius: 12px;
      color: rgba(66, 133, 244, 0.95);
      font-size: 13px; font-weight: 600;
      cursor: pointer; transition: background 0.2s, border-color 0.2s;
    }
    .classroom-btn:hover:not(:disabled) {
      background: rgba(66, 133, 244, 0.18);
      border-color: rgba(66, 133, 244, 0.7);
    }
    .classroom-btn:disabled { opacity: 0.6; cursor: default; }
    .classroom-btn--connected {
      background: rgba(52, 168, 83, 0.1);
      border-color: rgba(52, 168, 83, 0.45);
      color: rgba(52, 168, 83, 0.95);
    }
    .classroom-btn--connected:hover:not(:disabled) {
      background: rgba(52, 168, 83, 0.18);
      border-color: rgba(52, 168, 83, 0.7);
    }
  `;
  document.head.appendChild(style);
}

// ─── POSTS DO CLASSROOM NA PÁGINA DE MATERIAIS ────────────────────────────────
export async function renderPostsClassroom(token) {
  let section = document.getElementById('classroom-posts-section');
  if (!section) {
    const linksList = document.getElementById('links-list');
    if (!linksList) return;
    section = document.createElement('div');
    section.id = 'classroom-posts-section';
    linksList.insertAdjacentElement('afterend', section);
  }

  section.innerHTML = `
    <div class="cl-posts-header">
      <span class="cl-posts-title">📚 Publicações do Classroom</span>
      <span class="cl-posts-loading">Carregando...</span>
    </div>`;

  try {
    const cursosRes = await fetch(
      'https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE&pageSize=20',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!cursosRes.ok) throw new Error(`${cursosRes.status}`);
    const { courses = [] } = await cursosRes.json();

    const todosPosts = (await Promise.all(
      courses.map(c => buscarPostsDaTurma(c, token))
    )).flat();

    todosPosts.sort((a, b) => new Date(b.creationTime) - new Date(a.creationTime));
    const recentes = todosPosts.slice(0, 20);

    if (recentes.length === 0) {
      section.innerHTML = `
        <div class="cl-posts-header">
          <span class="cl-posts-title">📚 Publicações do Classroom</span>
        </div>
        <p class="cl-posts-empty">Nenhuma publicação encontrada nas turmas ativas.</p>`;
      return;
    }

    section.innerHTML = `
      <div class="cl-posts-header">
        <span class="cl-posts-title">📚 Publicações do Classroom</span>
        <span class="cl-posts-count">${recentes.length} publicaç${recentes.length > 1 ? 'ões' : 'ão'}</span>
      </div>
      ${recentes.map(renderPostCard).join('')}`;

  } catch (err) {
    console.error('[Classroom] Erro ao buscar posts:', err);
    section.innerHTML = `
      <div class="cl-posts-header">
        <span class="cl-posts-title">📚 Publicações do Classroom</span>
      </div>
      <p class="cl-posts-empty">Erro ao carregar publicações. Tente sincronizar novamente.</p>`;
  }
}

async function buscarPostsDaTurma(curso, token) {
  const cor = encontrarCorTurma(curso.name);

  // 1. Avisos (announcements)
  const fetchAnnouncements = fetch(
    `https://classroom.googleapis.com/v1/courses/${curso.id}/announcements?pageSize=10&orderBy=updateTime+desc`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).then(r => r.ok ? r.json() : { announcements: [] })
   .then(({ announcements = [] }) =>
     announcements.map(a => ({
       ...a,
       _nomeTurma: curso.name,
       _corTurma:  cor,
       _tipo:      'aviso',         // discriminator
     }))
   ).catch(() => []);

  // 2. Materiais publicados pelo professor (courseWorkMaterials)
  const fetchMaterials = fetch(
    `https://classroom.googleapis.com/v1/courses/${curso.id}/courseWorkMaterials?pageSize=10&orderBy=updateTime+desc`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).then(r => r.ok ? r.json() : { courseWorkMaterial: [] })
   .then(data => {
     // A API retorna a chave "courseWorkMaterial" (singular) nesta rota
     const items = data.courseWorkMaterial || [];
     return items.map(m => ({
       ...m,
       _nomeTurma: curso.name,
       _corTurma:  cor,
       _tipo:      'material',      // discriminator
       // Normaliza campo de texto para reutilizar renderPostCard
       text:       m.description || m.title || '',
     }));
   }).catch(() => []);

  const [avisos, materiais] = await Promise.all([fetchAnnouncements, fetchMaterials]);
  return [...avisos, ...materiais];
}

function encontrarCorTurma(nomeTurma) {
  if (!_STATE?.subjects?.length) return '#4285F4';
  const turmaLower = nomeTurma.toLowerCase();
  const match = _STATE.subjects.find(s => turmaLower.includes(s.name.toLowerCase()));
  return match?.color || '#4285F4';
}

function renderPostCard(post) {
  // courseWorkMaterials usa updateTime; announcements usa updateTime também,
  // mas tem creationTime como fallback.
  const dataISO = post.updateTime || post.creationTime || null;
  const data = dataISO
    ? new Date(dataISO).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';

  // Badge visual por tipo de publicação
  const isMaterial = post._tipo === 'material';
  const badgeIcon  = isMaterial ? '📎' : '📢';
  const badgeLabel = isMaterial ? 'Novo material' : 'Aviso';
  const badgeClass = isMaterial ? 'cl-badge--material' : 'cl-badge--aviso';

  const links = (post.materials || [])
    .map(m => {
      if (m.driveFile)    return { url: m.driveFile.driveFile?.alternateLink,  label: m.driveFile.driveFile?.title || 'Arquivo Drive', icon: '📁' };
      if (m.youtubeVideo) return { url: m.youtubeVideo.alternateLink,          label: m.youtubeVideo.title || 'Vídeo YouTube',         icon: '▶️' };
      if (m.link)         return { url: m.link.url,                            label: m.link.title || m.link.url,                      icon: '🔗' };
      if (m.form)         return { url: m.form.formUrl,                        label: m.form.title || 'Formulário',                    icon: '📋' };
      return null;
    })
    .filter(Boolean);

  // Para materiais, o campo text foi normalizado para description/title; para avisos usa text diretamente.
  const textoRaw = post.text || '';
  const texto = textoRaw
    ? `<p class="cl-post-text">${esc(textoRaw.slice(0, 200))}${textoRaw.length > 200 ? '…' : ''}</p>`
    : '';

  const linksHtml = links.length
    ? `<div class="cl-post-links">${links.map(l =>
        `<a class="cl-post-link" href="${l.url}" target="_blank" rel="noopener">
          <span>${l.icon}</span><span>${esc(l.label)}</span>
        </a>`).join('')}</div>`
    : '';

  // Para materiais sem descrição, mostra o título como texto principal
  const tituloHtml = (isMaterial && !textoRaw && post.title)
    ? `<p class="cl-post-text cl-post-title-material">${esc(post.title)}</p>`
    : '';

  return `
    <div class="cl-post-card cl-post-card--${post._tipo}">
      <div class="cl-post-card-top">
        <div class="cl-post-card-top-left">
          <span class="cl-badge ${badgeClass}">${badgeIcon} ${badgeLabel}</span>
          <span class="cl-post-turma" style="color:${post._corTurma}">${esc(post._nomeTurma)}</span>
        </div>
        <span class="cl-post-data">${data}</span>
      </div>
      ${tituloHtml}${texto}${linksHtml}
    </div>`;
}

function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// CSS dos posts
(function injetarEstilosPostsClassroom() {
  if (document.getElementById('classroom-posts-styles')) return;
  const s = document.createElement('style');
  s.id = 'classroom-posts-styles';
  s.textContent = `
    #classroom-posts-section { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--border); }
    .cl-posts-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .cl-posts-title { font-size: 13px; font-weight: 700; color: var(--text); letter-spacing: 0.04em; text-transform: uppercase; }
    .cl-posts-count, .cl-posts-loading { font-size: 11px; color: var(--text2); }
    .cl-posts-empty { font-size: 13px; color: var(--text2); padding: 8px 0; }
    .cl-post-card { background: var(--bg3); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; }
    .cl-post-card--material { border-left: 3px solid rgba(66,133,244,0.7); }
    .cl-post-card--aviso    { border-left: 3px solid rgba(251,188,4,0.7); }
    .cl-post-card-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 6px; gap: 8px; }
    .cl-post-card-top-left { display: flex; flex-direction: column; gap: 3px; }
    .cl-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 20px; letter-spacing: 0.04em; text-transform: uppercase; }
    .cl-badge--material { background: rgba(66,133,244,0.12); color: rgba(66,133,244,0.95); }
    .cl-badge--aviso    { background: rgba(251,188,4,0.12);  color: rgba(180,130,0,0.95); }
    .cl-post-turma { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
    .cl-post-data { font-size: 11px; color: var(--text2); white-space: nowrap; }
    .cl-post-text { font-size: 13px; color: var(--text); line-height: 1.5; margin: 0 0 8px; white-space: pre-wrap; }
    .cl-post-title-material { font-weight: 600; }
    .cl-post-links { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
    .cl-post-link {
      display: flex; align-items: center; gap: 5px; padding: 5px 10px;
      background: rgba(66,133,244,0.1); border: 1px solid rgba(66,133,244,0.25);
      border-radius: 8px; font-size: 12px; color: rgba(66,133,244,0.95);
      text-decoration: none; transition: background 0.15s;
    }
    .cl-post-link:hover { background: rgba(66,133,244,0.2); }
  `;
  document.head.appendChild(s);
})();