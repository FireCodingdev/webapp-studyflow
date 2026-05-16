// ===== CLASSROOM.JS =====
// Integração com Google Classroom via OAuth 2.0 Authorization Code + PKCE.
// A client_secret NUNCA fica no frontend — a troca de token é feita via
// Firebase Function (classroomToken), que mantém a secret segura no servidor.

import { db, auth, getAppCheckToken } from './firebase.js';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  getDocs,
  collection,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ─── CONFIGURAÇÃO ─────────────────────────────────────────────────────────────
const CLASSROOM_CLIENT_ID = '92968084905-1ete8rjlfs6e3uo3pj4h351bdm8ak947.apps.googleusercontent.com';
const CLASSROOM_SCOPES = [
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me',       // leitura + entrega
  'https://www.googleapis.com/auth/classroom.announcements.readonly',
  'https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
].join(' ');

// URL da Firebase Function de proxy
const CLASSROOM_TOKEN_FUNCTION = 'https://classroomtoken-xesxvi757a-uc.a.run.app';

// ─── ESTADO INTERNO ───────────────────────────────────────────────────────────
let _STATE = null;
let _hooks  = null;

// ─── CACHE LOCAL DE SUBMISSÕES (para não perder status "Entregue" entre renders) ──
// Firestore: users/{uid}/classroomSubmissions/{cwId} = { state, courseId, updatedAt }
// Estados relevantes: 'TURNED_IN' | 'RETURNED' | 'NEW' | 'CREATED'

async function _saveSubmissionStatus(uid, cwId, state, courseId) {
  try {
    await setDoc(doc(db, 'users', uid, 'classroomSubmissions', cwId), {
      state, courseId: courseId || '', updatedAt: new Date().toISOString(),
    });
  } catch { /* best-effort */ }
}

async function _loadSubmissionCache(uid) {
  try {
    const snap = await getDocs(collection(db, 'users', uid, 'classroomSubmissions'));
    const map = new Map();
    snap.docs.forEach(d => map.set(d.id, d.data()));
    return map;
  } catch { return new Map(); }
}

async function _fetchSubmissionState(token, courseId, cwId) {
  try {
    const res = await fetch(
      `https://classroom.googleapis.com/v1/courses/${courseId}/courseWork/${cwId}/studentSubmissions?userId=me`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return (data.studentSubmissions || [])[0]?.state || null;
  } catch { return null; }
}

// Verifica em background as atividades sem status cacheado e atualiza o DOM + cache
async function _refreshUncachedSubmissions(uid, token, atividades, cache) {
  const uncached = atividades.filter(p => {
    const cached = cache.get(p.id);
    return !cached || (cached.state !== 'TURNED_IN' && cached.state !== 'RETURNED');
  });
  if (!uncached.length) return;

  await Promise.all(uncached.map(async (p) => {
    const state = await _fetchSubmissionState(token, p._courseId, p.id);
    if (!state) return;
    const isTurnedIn = state === 'TURNED_IN' || state === 'RETURNED';
    await _saveSubmissionStatus(uid, p.id, state, p._courseId);
    if (isTurnedIn) _marcarCardEntregueDOM(p.id);
  }));
}

// Atualiza todos os cards (dashboard e atividades) sem re-renderizar
function _marcarCardEntregueDOM(cwId) {
  document.querySelectorAll(`.cl-responder-btn[data-cw-id="${cwId}"]`).forEach(respBtn => {
    const postCard = respBtn.closest('.cl-post-card');
    if (postCard) {
      const dueEl = postCard.querySelector('.cl-post-due');
      if (dueEl) {
        dueEl.innerHTML = '✅ Entregue!';
        dueEl.style.cssText = 'color:#2ed573;background:rgba(46,213,115,0.1);border:1px solid rgba(46,213,115,0.25);border-radius:8px;padding:6px 12px;font-size:13px;font-weight:700;margin-bottom:8px;display:inline-flex;align-items:center;gap:6px';
      }
    }
    respBtn.remove();
  });
  // Marca a tarefa como concluída no STATE do app (se disponível)
  window._markClassroomTaskDone?.(cwId);
}

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

  // Renderiza posts compactos no dashboard
  window._renderPostsClassroomDashboard = async () => {
    const el = document.getElementById('db-classroom-posts');
    if (!el) return;
    const currentUid = auth.currentUser?.uid;
    if (!currentUid) {
      el.innerHTML = `<div class="db-empty-small">Conecte o Google Classroom nas configurações para ver as publicações aqui.</div>`;
      return;
    }
    const token = await getTokenValido(currentUid);
    if (!token) {
      el.innerHTML = `<div class="db-empty-small">Conecte o Google Classroom nas configurações para ver as publicações aqui.</div>`;
      return;
    }
    renderPostsClassroom(token, el, 5);
  };

  // Expõe STATE subjects e função de abrir resumo salvo
  window._STATE_subjects = () => _STATE?.subjects || [];
  window._abrirModalResumoSalvo = (titulo, conteudo) => {
    _mostrarModalResumo(titulo, conteudo, true, null, null, '', null, '');
  };

  // Expõe função de conexão para o painel de configurações
  window._conectarClassroom = async () => {
    const currentUid = auth.currentUser?.uid;
    if (!currentUid) return;
    const token = await getTokenValido(currentUid);
    if (token) {
      atualizarBotaoClassroom(true);
      await sincronizarClassroom(currentUid, token);
    } else {
      conectarClassroom();
    }
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
    const appCheckToken = await getAppCheckToken();
    const resp = await fetch(CLASSROOM_TOKEN_FUNCTION, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${idToken}`,
        ...(appCheckToken ? { 'X-Firebase-AppCheck': appCheckToken } : {}),
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
    // Avisa o painel de configurações que a conexão foi concluída
    window.dispatchEvent(new CustomEvent('classroom-connected'));

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
    const appCheckToken = await getAppCheckToken();

    const resp = await fetch(CLASSROOM_TOKEN_FUNCTION, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${idToken}`,
        ...(appCheckToken ? { 'X-Firebase-AppCheck': appCheckToken } : {}),
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
    if (!token) {
      // Sem token: mostra mensagem de "conecte o Classroom" no dashboard
      window._renderPostsClassroomDashboard?.();
      return;
    }
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

    // Sempre atualiza os posts no dashboard, independente de novas atividades
    window._renderPostsClassroomDashboard?.();

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
    return courseWork.map(cw => ({ ...cw, _nometurma: curso.name, _courseId: curso.id }));
  } catch { return []; }
}

function importarAtividades(atividades) {
  const idsExistentes = new Set(_STATE.tasks.map(t => t.classroomId).filter(Boolean));
  // Build map classroomId → courseId for retroactive updates on existing tasks
  const cwCourseMap = new Map(
    atividades.filter(cw => cw.id && cw._courseId).map(cw => [cw.id, cw._courseId])
  );
  let novas = 0;

  for (const task of _STATE.tasks) {
    if (!task.classroomId) continue;
    // Retroactively fill missing courseId
    if (!task.courseId && cwCourseMap.has(task.classroomId)) {
      task.courseId = cwCourseMap.get(task.classroomId);
    }
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

    const titleNorm = (cw.title || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const isExam = /prova|avalia[cç]|teste|\bp[123]\b|\bn[123]\b|simulado/.test(titleNorm);

    _STATE.tasks.push({
      id:            `classroom_${cw.id}`,
      classroomId:   cw.id,
      courseId:      cw._courseId || null,
      title:         cw.title || 'Atividade sem título',
      subjectId:     subject?.id    || null,
      subjectName:   subject?.name  || limparNomeTurma(cw._nometurma),
      subjectColor:  subject?.color || '#4285F4',
      type:          isExam ? 'exam' : 'work',
      workType:      cw.workType || 'ASSIGNMENT',
      alternateLink: cw.alternateLink || '',
      deadline,
      notes:         cw.description || null,
      done:          false,
      createdAt:     cw.creationTime || new Date().toISOString(),
      source:        'classroom',
    });

    novas++;
  }

  return novas;
}

function encontrarMateria(nomeTurma) {
  return _matchSubjectForTurma(nomeTurma);
}

// ─── BOTÃO NA SIDEBAR ─────────────────────────────────────────────────────────
function injetarBotaoClassroom() {
  // Botão removido da sidebar — acesso via Configurações > Google Classroom
  // window._conectarClassroom é definido em initClassroom
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
    .task-cl-actions {
      display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap;
    }
  `;
  document.head.appendChild(style);
}

// ─── POSTS DO CLASSROOM NA PÁGINA DE MATERIAIS ────────────────────────────────
export async function renderPostsClassroom(token, targetEl, limit) {
  const section = targetEl;
  if (!section) return;

  section.innerHTML = `
    <div class="cl-posts-header">
      <span class="cl-posts-title">📚 Publicações do Classroom</span>
      <span class="cl-posts-loading">Carregando...</span>
    </div>`;

  try {
    const uid = auth.currentUser?.uid;

    // Carrega cache de submissões e posts da API em paralelo
    const [submissionCache, cursosRes] = await Promise.all([
      uid ? _loadSubmissionCache(uid) : Promise.resolve(new Map()),
      fetch(
        'https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE&pageSize=20',
        { headers: { Authorization: `Bearer ${token}` } }
      ),
    ]);

    if (!cursosRes.ok) throw new Error(`${cursosRes.status}`);
    const { courses = [] } = await cursosRes.json();

    const todosPosts = (await Promise.all(
      courses.map(c => buscarPostsDaTurma(c, token))
    )).flat();

    todosPosts.sort((a, b) => new Date(b.creationTime) - new Date(a.creationTime));
    const recentes = todosPosts.slice(0, limit || 20);

    if (recentes.length === 0) {
      section.innerHTML = `
        <div class="cl-posts-header">
          <span class="cl-posts-title">📚 Publicações do Classroom</span>
        </div>
        <p class="cl-posts-empty">Nenhuma publicação encontrada nas turmas ativas.</p>`;
      return;
    }

    // Renderiza com status do cache (sem chamar API extra)
    section.innerHTML = `
      <div class="cl-posts-header">
        <span class="cl-posts-title">📚 Publicações do Classroom</span>
        <span class="cl-posts-count">${recentes.length} publicaç${recentes.length > 1 ? 'ões' : 'ão'}</span>
      </div>
      ${recentes.map(p => {
        const cached = submissionCache.get(p.id);
        const isTurnedIn = cached?.state === 'TURNED_IN' || cached?.state === 'RETURNED';
        return renderPostCard(p, isTurnedIn);
      }).join('')}`;

    // Verifica em background atividades sem status no cache e atualiza o DOM se necessário
    if (uid) {
      const atividades = recentes.filter(p => p._tipo === 'atividade');
      _refreshUncachedSubmissions(uid, token, atividades, submissionCache).catch(() => {});
    }

  } catch (err) {
    console.error('[Classroom] Erro ao buscar posts:', err);
    section.innerHTML = `
      <div class="cl-posts-header">
        <span class="cl-posts-title">📚 Publicações do Classroom</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;padding:4px 0">
        <p class="cl-posts-empty" style="margin:0">Erro ao carregar publicações.</p>
        <button onclick="window._renderPostsClassroomDashboard?.()" style="padding:4px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text2);font-size:12px;cursor:pointer">↻ Tentar novamente</button>
      </div>`;
  }
}

async function buscarPostsDaTurma(curso, token) {
  const cor        = encontrarCorTurma(curso.name);
  const nomeTurma  = limparNomeTurma(curso.name);   // nome limpo para exibição

  // 1. Avisos (announcements)
  const fetchAnnouncements = fetch(
    `https://classroom.googleapis.com/v1/courses/${curso.id}/announcements?pageSize=10&orderBy=updateTime+desc`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).then(r => r.ok ? r.json() : { announcements: [] })
   .then(({ announcements = [] }) =>
     announcements.map(a => ({
       ...a,
       _nomeTurma: nomeTurma,
       _corTurma:  cor,
       _tipo:      'aviso',
     }))
   ).catch(() => []);

  // 2. Materiais publicados pelo professor (courseWorkMaterials)
  const fetchMaterials = fetch(
    `https://classroom.googleapis.com/v1/courses/${curso.id}/courseWorkMaterials?pageSize=10&orderBy=updateTime+desc`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).then(r => r.ok ? r.json() : { courseWorkMaterial: [] })
   .then(data => {
     const items = data.courseWorkMaterial || [];
     return items.map(m => ({
       ...m,
       _nomeTurma: nomeTurma,
       _corTurma:  cor,
       _tipo:      'material',
       text:       m.description || m.title || '',
     }));
   }).catch(() => []);

  // 3. Atividades postadas pelo professor (courseWork — aba "Atividades")
  const fetchAtividades = fetch(
    `https://classroom.googleapis.com/v1/courses/${curso.id}/courseWork?pageSize=15&orderBy=updateTime+desc`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).then(r => r.ok ? r.json() : { courseWork: [] })
   .then(({ courseWork = [] }) =>
     courseWork.map(cw => ({
       ...cw,
       _nomeTurma: nomeTurma,
       _corTurma:  cor,
       _tipo:      'atividade',
       _courseId:  curso.id,       // garante o courseId correto
       title:      cw.title || '',
       text:       cw.description || '',
     }))
   ).catch(() => []);

  const [avisos, materiais, atividades] = await Promise.all([fetchAnnouncements, fetchMaterials, fetchAtividades]);
  return [...avisos, ...materiais, ...atividades];
}

function _normTurma(s) {
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function encontrarCorTurma(nomeTurma) {
  if (!_STATE?.subjects?.length) return '#4285F4';
  const match = _matchSubjectForTurma(nomeTurma);
  return match?.color || '#4285F4';
}

// Retorna a matéria correspondente à turma, ou null
function _matchSubjectForTurma(nomeTurma) {
  if (!_STATE?.subjects?.length) return null;
  const turmaNorm = _normTurma(nomeTurma);
  let best = null, bestScore = 0;
  for (const s of _STATE.subjects) {
    const words = _normTurma(s.name).split(' ').filter(w => w.length > 2);
    if (!words.length) continue;
    const hits = words.filter(w => turmaNorm.includes(w)).length;
    const score = hits / words.length;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore >= 0.35 ? best : null;
}

// Remove prefixo numérico e sufixos em parênteses do nome da turma
function limparNomeTurma(nomeTurma) {
  const match = _matchSubjectForTurma(nomeTurma);
  if (match) return match.name;
  return nomeTurma
    .replace(/^\d+\s+/, '')        // remove "20261 " do início
    .replace(/\s*\([^)]*\)/g, '')  // remove "(38388) (02.03.19.1.10)"
    .trim();
}

function _formatDueDate(dueDate, dueTime) {
  if (!dueDate?.year) return '';
  const h = dueTime?.hours   ?? 23;
  const m = dueTime?.minutes ?? 59;
  const d = new Date(dueDate.year, dueDate.month - 1, dueDate.day, h, m);
  const dateStr = d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
  return `${dateStr}, ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function renderPostCard(post, isTurnedIn = false) {
  post._isTurnedIn = isTurnedIn;
  const dataISO = post.updateTime || post.creationTime || null;
  const data = dataISO
    ? new Date(dataISO).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';

  const tipo = post._tipo;
  const badgeIcon  = tipo === 'material' ? '📎' : tipo === 'atividade' ? '📝' : '📢';
  const badgeLabel = tipo === 'material' ? 'Novo material' : tipo === 'atividade' ? 'Atividade' : 'Aviso';
  const badgeClass = tipo === 'material' ? 'cl-badge--material' : tipo === 'atividade' ? 'cl-badge--atividade' : 'cl-badge--aviso';

  // Due date (apenas para atividades com dueDate definida)
  const dueDateStr = tipo === 'atividade' ? _formatDueDate(post.dueDate, post.dueTime) : '';
  const dueDateHtml = tipo !== 'atividade' ? '' : isTurnedIn
    ? `<div class="cl-post-due" style="color:#2ed573;background:rgba(46,213,115,0.1);border:1px solid rgba(46,213,115,0.25);border-radius:8px;padding:6px 12px;font-size:13px;font-weight:700;margin-bottom:8px;display:inline-flex;align-items:center;gap:6px">✅ Entregue!</div>`
    : dueDateStr
      ? `<div class="cl-post-due"><span class="cl-post-due-icon">⏰</span> Entrega: <strong>${dueDateStr}</strong></div>`
      : '';

  const links = (post.materials || [])
    .map(m => {
      if (m.driveFile)    return { url: m.driveFile.driveFile?.alternateLink,  label: m.driveFile.driveFile?.title || 'Arquivo Drive', icon: '📁' };
      if (m.youtubeVideo) return { url: m.youtubeVideo.alternateLink,          label: m.youtubeVideo.title || 'Vídeo YouTube',         icon: '▶️' };
      if (m.link)         return { url: m.link.url,                            label: m.link.title || m.link.url,                      icon: '🔗' };
      if (m.form)         return { url: m.form.formUrl,                        label: m.form.title || 'Formulário',                    icon: '📋' };
      return null;
    })
    .filter(Boolean);

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

  const tituloHtml = (tipo === 'material' && !textoRaw && post.title)
    ? `<p class="cl-post-text cl-post-title-material">${esc(post.title)}</p>`
    : '';

  // Extrai dados do Drive antecipadamente (evita serializar o post inteiro)
  const driveMatl    = (post.materials || []).find(m => m.driveFile?.driveFile?.id);
  const driveFileId  = driveMatl?.driveFile?.driveFile?.id  || '';
  const driveAltLink = driveMatl?.driveFile?.driveFile?.alternateLink || '';
  const driveTitle   = driveMatl?.driveFile?.driveFile?.title || '';

  const nomesMateriais = (post.materials || []).map(m => {
    if (m.driveFile)    return `[Arquivo Drive] ${m.driveFile.driveFile?.title || ''}`;
    if (m.youtubeVideo) return `[YouTube] ${m.youtubeVideo.title || ''}`;
    if (m.link)         return `[Link] ${m.link.title || m.link.url || ''}`;
    if (m.form)         return `[Formulário] ${m.form.title || ''}`;
    return null;
  }).filter(Boolean).join('\n');

  const isAtividade = tipo === 'atividade';
  const alternateLinkPost = post.alternateLink || '';
  const responderBtn = isAtividade && !post._isTurnedIn ? `
    <button class="cl-responder-btn" onclick="window._abrirModalResponder(this)"
      data-course-id="${esc(post._courseId || post.courseId || '')}"
      data-cw-id="${esc(post.id || '')}"
      data-worktype="${esc(post.workType || 'ASSIGNMENT')}"
      data-title="${esc(post.title || '')}"
      data-text="${esc(textoRaw)}"
      data-due="${esc(dueDateStr)}"
      data-link="${esc(alternateLinkPost)}">Responder →</button>` : '';

  return `
    <div class="cl-post-card cl-post-card--${post._tipo}">
      <div class="cl-post-card-top">
        <div class="cl-post-card-top-left">
          <span class="cl-badge ${badgeClass}">${badgeIcon} ${badgeLabel}</span>
          <span class="cl-post-turma" style="color:${post._corTurma}">${esc(post._nomeTurma)}</span>
        </div>
        <div class="cl-post-card-top-right">
          <span class="cl-post-data">${data}</span>
          <button class="cl-resumir-btn" title="Resumir com IA" onclick="window._resumirPostClassroom(this)"
            data-title="${esc(post.title || '')}"
            data-text="${esc(textoRaw)}"
            data-turma="${esc(post._nomeTurma || '')}"
            data-materiais="${esc(nomesMateriais)}"
            data-drive-id="${esc(driveFileId)}"
            data-drive-link="${esc(driveAltLink)}"
            data-drive-title="${esc(driveTitle)}">✨ Resumir</button>
        </div>
      </div>
      ${dueDateHtml}
      ${tituloHtml}${texto}${linksHtml}
      ${responderBtn}
    </div>`;
}

// ─── RESPONDER ATIVIDADE ──────────────────────────────────────────────────────
window._abrirModalResponder = async function(btn) {
  const courseId  = btn.dataset.courseId;
  const cwId      = btn.dataset.cwId;
  const workType  = btn.dataset.worktype || 'ASSIGNMENT';
  const titulo    = btn.dataset.title || 'Atividade';
  const descricao = btn.dataset.text  || '';
  const due       = btn.dataset.due   || '';
  const link      = btn.dataset.link  || '';

  // Remove modal anterior se existir
  document.getElementById('cl-resp-overlay')?.remove();

  const isShortAnswer = workType === 'SHORT_ANSWER_QUESTION';
  const overlay = document.createElement('div');
  overlay.id = 'cl-resp-overlay';
  overlay.className = 'cl-modal-overlay';
  overlay.innerHTML = `
    <div class="cl-modal-box cl-resp-box">
      <div class="cl-modal-header">
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1">
          <span style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:0.5px">📝 Atividade</span>
          <span style="font-size:15px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(titulo)}</span>
        </div>
        ${link ? `<a href="${esc(link)}" target="_blank" style="font-size:12px;color:var(--text2);text-decoration:underline;white-space:nowrap;align-self:center;margin-right:10px;background:none;border:none;cursor:pointer">Ver no Classroom →</a>` : ''}
        <button onclick="document.getElementById('cl-resp-overlay').remove()" style="background:none;border:none;color:var(--text2);font-size:20px;cursor:pointer;padding:4px;line-height:1">✕</button>
      </div>
      ${due ? `<div class="cl-resp-due">⏰ Entrega: <strong>${esc(due)}</strong></div>` : ''}
      ${descricao ? `<div class="cl-resp-desc">${esc(descricao)}</div>` : ''}
      <div id="cl-resp-body">
        <div class="cl-resp-loading">⏳ Carregando sua resposta...</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  const uid = auth.currentUser?.uid;
  const token = uid ? await getTokenValido(uid) : null;

  if (!token || !courseId || !cwId) {
    document.getElementById('cl-resp-body').innerHTML = `
      <p style="color:var(--text2);font-size:13px;margin-bottom:10px">Não foi possível carregar a submissão. Reconecte o Classroom.</p>
      ${link ? `<a href="${esc(link)}" target="_blank" class="cl-resp-open-btn">🔗 Abrir no Classroom</a>` : ''}`;
    return;
  }

  try {
    // Busca a submissão existente do aluno
    const subRes = await fetch(
      `https://classroom.googleapis.com/v1/courses/${courseId}/courseWork/${cwId}/studentSubmissions?userId=me`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const subData = subRes.ok ? await subRes.json() : {};
    const submission = (subData.studentSubmissions || [])[0] || null;
    const subId      = submission?.id || null;
    const state      = submission?.state || 'NEW';
    const isTurnedIn = state === 'TURNED_IN' || state === 'RETURNED';
    if (isTurnedIn) window._marcarAtividadeEntregue(cwId);
    const existingAnswer = isShortAnswer
      ? (submission?.shortAnswerSubmission?.answer || '')
      : '';

    const body = document.getElementById('cl-resp-body');

    if (isShortAnswer) {
      body.innerHTML = `
        <div class="cl-resp-field">
          <label style="font-size:12px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:0.4px">Sua resposta</label>
          <textarea id="cl-resp-textarea" class="cl-resp-textarea" placeholder="Digite sua resposta aqui..." ${isTurnedIn ? 'disabled' : ''}>${esc(existingAnswer)}</textarea>
        </div>
        <div class="cl-resp-actions">
          ${isTurnedIn
            ? `<div class="cl-resp-status delivered">✅ Entregue</div>`
            : `<button id="cl-resp-submit" class="cl-resp-submit-btn" onclick="window._entregarResposta('${courseId}','${cwId}','${subId}',false)">📤 Entregar</button>
               <button class="cl-resp-save-btn" onclick="window._entregarResposta('${courseId}','${cwId}','${subId}',true)">💾 Rascunho</button>
               <button id="cl-resp-ai-btn" class="cl-resp-ai-btn" data-titulo="${esc(titulo)}" data-descricao="${esc(descricao)}" onclick="window._gerarRespostaIA()">✨ Gerar com IA</button>`}
        </div>`;
    } else {
      // ASSIGNMENT — não suporta upload de arquivo via app
      body.innerHTML = `
        ${isTurnedIn
          ? `<div class="cl-resp-status delivered">✅ Entregue</div>`
          : `<p class="cl-resp-info">Este tipo de atividade pode exigir envio de arquivo. Use o Classroom para entregar anexos.</p>`}
        ${link ? `<a href="${esc(link)}" target="_blank" class="cl-resp-open-btn">🔗 Abrir no Classroom para entregar</a>` : ''}`;
    }
  } catch(err) {
    document.getElementById('cl-resp-body').innerHTML =
      `<p style="color:#ff4757;font-size:13px">Erro ao carregar: ${err.message}</p>`;
  }
};

window._entregarResposta = async function(courseId, cwId, subId, apenasRascunho) {
  const textarea = document.getElementById('cl-resp-textarea');
  const answer   = textarea?.value?.trim() || '';
  const submitBtn = document.getElementById('cl-resp-submit');

  if (!answer && !apenasRascunho) {
    textarea?.setAttribute('style', 'border-color:#ff4757');
    setTimeout(() => textarea?.removeAttribute('style'), 1500);
    return;
  }

  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '⏳ Enviando...'; }

  const uid = auth.currentUser?.uid;
  const token = uid ? await getTokenValido(uid) : null;
  if (!token) { if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '📤 Entregar'; } return; }

  try {
    // Salva a resposta (PATCH)
    if (subId && subId !== 'null') {
      await fetch(
        `https://classroom.googleapis.com/v1/courses/${courseId}/courseWork/${cwId}/studentSubmissions/${subId}?updateMask=shortAnswerSubmission`,
        { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ shortAnswerSubmission: { answer } }) }
      );
      // Entrega (turnIn) se não for só rascunho
      if (!apenasRascunho) {
        await fetch(
          `https://classroom.googleapis.com/v1/courses/${courseId}/courseWork/${cwId}/studentSubmissions/${subId}:turnIn`,
          { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' }
        );
        // Persiste status no Firestore para que o card não volte ao estado "aberto"
        const uid = auth.currentUser?.uid;
        if (uid) await _saveSubmissionStatus(uid, cwId, 'TURNED_IN', courseId);

        const body = document.getElementById('cl-resp-body');
        if (body) body.innerHTML = `<div class="cl-resp-status delivered">✅ Atividade entregue com sucesso!</div>`;
        window._marcarAtividadeEntregue(cwId);
        return;
      }
    }
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '📤 Entregar'; }
    const saveBtn = document.querySelector('.cl-resp-save-btn');
    if (saveBtn && apenasRascunho) { saveBtn.textContent = '✅ Salvo'; setTimeout(() => { saveBtn.textContent = '💾 Rascunho'; }, 2000); }
  } catch(err) {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '📤 Entregar'; }
    alert('Erro ao enviar: ' + err.message);
  }
};

// ─── MARCAR CARD COMO ENTREGUE ───────────────────────────────────────────────
window._marcarAtividadeEntregue = function(cwId) {
  _marcarCardEntregueDOM(cwId);
};

// ─── IA: GERAR RESPOSTA PARA ATIVIDADE ───────────────────────────────────────
window._gerarRespostaIA = async function() {
  const aiBtn    = document.getElementById('cl-resp-ai-btn');
  const textarea = document.getElementById('cl-resp-textarea');
  if (!textarea || !aiBtn) return;

  const titulo   = aiBtn.dataset.titulo   || '';
  const descricao = aiBtn.dataset.descricao || '';

  aiBtn.disabled = true;
  aiBtn.textContent = '⏳ Gerando...';

  try {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) throw new Error('Faça login primeiro.');
    const appCheckToken = await getAppCheckToken();

    const resp = await fetch(GEMINI_PROXY, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${idToken}`,
        ...(appCheckToken ? { 'X-Firebase-AppCheck': appCheckToken } : {}),
      },
      body: JSON.stringify({ mode: 'answer', titulo, descricao }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Erro ao gerar resposta');

    textarea.value = data.resposta;
  } catch (err) {
    alert('Erro ao gerar com IA: ' + err.message);
  } finally {
    aiBtn.disabled = false;
    aiBtn.textContent = '✨ Gerar com IA';
  }
};

// ─── IA: RESUMIR PUBLICAÇÃO ────────────────────────────────────────────────────
const GEMINI_PROXY = 'https://geminiproxy-xesxvi757a-uc.a.run.app';

window._resumirPostClassroom = async function(btn) {
  // Lê dados dos atributos individuais (mais robusto que JSON do post inteiro)
  const titulo       = btn.dataset.title    || btn.dataset.text || 'Publicação';
  const driveFileId  = btn.dataset.driveId  || null;
  const driveAltLink = btn.dataset.driveLink || null;

  let textoPrincipal = '';
  if (btn.dataset.title)    textoPrincipal += `Título: ${btn.dataset.title}\n`;
  if (btn.dataset.text)     textoPrincipal += `\nDescrição:\n${btn.dataset.text}\n`;
  if (btn.dataset.turma)    textoPrincipal += `\nTurma: ${btn.dataset.turma}\n`;
  if (btn.dataset.materiais) textoPrincipal += `\nMateriais anexados:\n${btn.dataset.materiais}\n`;

  btn.disabled = true;
  btn.textContent = '⏳ Lendo material...';
  const loadingInterval = setInterval(() => {
    const msgs = ['⏳ Lendo PDF...', '⏳ Analisando...', '⏳ Gerando resumo...'];
    btn.textContent = msgs[Math.floor(Date.now() / 3000) % msgs.length];
  }, 3000);

  try {
    const uid = auth.currentUser?.uid;
    if (!uid) throw new Error('Faça login primeiro.');

    const [idToken, classroomToken, appCheckToken] = await Promise.all([
      auth.currentUser.getIdToken(),
      getTokenValido(uid),
      getAppCheckToken(),
    ]);

    if (!textoPrincipal.trim() && !driveFileId) {
      throw new Error('Esta publicação não tem conteúdo para resumir.');
    }

    const body = { mode: 'summarize', text: textoPrincipal };
    if (driveFileId && classroomToken) {
      body.driveFileId          = driveFileId;
      body.classroomAccessToken = classroomToken;
    }

    const resp = await fetch(GEMINI_PROXY, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${idToken}`,
        ...(appCheckToken ? { 'X-Firebase-AppCheck': appCheckToken } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Erro ${resp.status}`);
    }

    const { resumo, usedFile } = await resp.json();
    const turma = btn.dataset.turma || '';
    _mostrarModalResumo(titulo, resumo, usedFile, driveFileId, driveAltLink, textoPrincipal, idToken, turma);

  } catch (err) {
    alert('Não foi possível resumir: ' + err.message);
  } finally {
    clearInterval(loadingInterval);
    btn.disabled = false;
    btn.textContent = '✨ Resumir';
  }
};

function _mostrarModalResumo(titulo, markdown, usedFile, driveFileId, driveAltLink, textoPrincipal, idToken, turma) {
  document.getElementById('cl-resumo-modal')?.remove();

  const showBanner = driveFileId && !usedFile;
  const labelExtra = usedFile ? ' · 📄 PDF analisado' : (driveFileId ? ' · ⚠️ sem PDF' : '');

  const overlay = document.createElement('div');
  overlay.id = 'cl-resumo-modal';
  overlay.className = 'cl-modal-overlay';
  overlay.innerHTML = `
    <div class="cl-modal-box">
      <div class="cl-modal-header">
        <div class="cl-modal-title">
          <span class="cl-modal-icon">✨</span>
          <div>
            <div class="cl-modal-label">Resumo com IA${labelExtra}</div>
            <div class="cl-modal-subtitle">${esc(titulo.slice(0, 80))}${titulo.length > 80 ? '…' : ''}</div>
          </div>
        </div>
        <div class="cl-modal-actions">
          <button class="cl-modal-btn cl-modal-btn--save" id="cl-modal-save">🔖 Salvar</button>
          <button class="cl-modal-btn cl-modal-btn--download" id="cl-modal-download">⬇️ Baixar</button>
          <button class="cl-modal-btn cl-modal-btn--close" id="cl-modal-close">✕</button>
        </div>
      </div>
      ${showBanner ? `
      <div class="cl-modal-upload-banner" id="cl-modal-upload-banner">
        <span>⚠️ Não foi possível abrir o PDF, você deve baixar e enviar manualmente.</span>
        ${driveAltLink ? `<a class="cl-modal-open-pdf-link" href="${driveAltLink}" target="_blank" rel="noopener">📄 Abrir PDF</a>` : ''}
        <input type="file" id="cl-modal-file-input" accept=".pdf,image/*" style="display:none">
        <label class="cl-modal-btn cl-modal-btn--resumir-manual" for="cl-modal-file-input">📎 Selecionar e resumir</label>
      </div>` : ''}
      <div class="cl-modal-body" id="cl-modal-content">${_markdownParaHtml(markdown)}</div>
    </div>`;

  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('cl-modal-close').addEventListener('click', () => overlay.remove());

  const contentEl = document.getElementById('cl-modal-content');
  if (contentEl) contentEl._mdSource = markdown;

  // Salvar resumo na matéria correspondente
  document.getElementById('cl-modal-save').addEventListener('click', async () => {
    const saveBtn = document.getElementById('cl-modal-save');
    if (saveBtn.disabled) return;

    const conteudo = contentEl?._mdSource || markdown;
    const resumoEntry = { id: Date.now().toString(), titulo, conteudo, turma, savedAt: new Date().toISOString() };

    // Tenta encontrar a matéria automaticamente
    const subject = window._findSubjectByTurma?.(turma);

    if (subject) {
      saveBtn.disabled = true;
      saveBtn.textContent = '⏳ Salvando...';
      const ok = await window._saveResumoToSubject?.(subject.id, resumoEntry);
      if (ok) {
        saveBtn.textContent = `✅ Salvo em ${subject.name.slice(0, 20)}`;
        saveBtn.style.color = '#2ed573';
        saveBtn.style.borderColor = 'rgba(46,213,115,0.4)';
      } else {
        saveBtn.disabled = false;
        saveBtn.textContent = '🔖 Salvar';
      }
    } else {
      // Nenhuma matéria encontrada — mostra seletor inline
      _mostrarSeletorMateria(saveBtn, resumoEntry);
    }
  });

  document.getElementById('cl-modal-download').addEventListener('click', () => {
    const src  = contentEl?._mdSource || markdown;
    const blob = new Blob([src], { type: 'text/markdown;charset=utf-8' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `resumo-${titulo.slice(0, 40).replace(/[^a-z0-9]/gi, '_')}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  if (!showBanner) return;

  const fileInput = document.getElementById('cl-modal-file-input');

  // Assim que o arquivo for selecionado pelo label, re-resume automaticamente
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    const banner = document.getElementById('cl-modal-upload-banner');

    const MAX_BYTES = 15 * 1024 * 1024; // 15 MB
    if (file.size > MAX_BYTES) {
      if (banner) {
        banner.innerHTML = '<span style="color:#ff4757;font-size:13px">❌ PDF muito grande (máx. 15 MB). Tente comprimir o arquivo antes de enviar.</span>';
      }
      return;
    }

    if (banner) {
      banner.innerHTML = '<span style="color:var(--text2);font-size:12px">⏳ Lendo PDF e gerando resumo...</span>';
    }

    try {
      const reader = new FileReader();
      const base64 = await new Promise((resolve, reject) => {
        reader.onload  = e => resolve(e.target.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const acToken = await getAppCheckToken();
      const resp = await fetch(GEMINI_PROXY, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${idToken}`,
          ...(acToken ? { 'X-Firebase-AppCheck': acToken } : {}),
        },
        body: JSON.stringify({
          mode: 'summarize',
          text: textoPrincipal,
          fileBase64: base64,
          fileMimeType: file.type || 'application/pdf',
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `Erro ${resp.status}`);
      }

      const { resumo: novoResumo } = await resp.json();

      if (contentEl) {
        contentEl.innerHTML = _markdownParaHtml(novoResumo);
        contentEl._mdSource = novoResumo;
      }
      if (banner) {
        banner.innerHTML = '<span style="color:#2ed573;font-size:13px;font-weight:600">✅ PDF analisado com sucesso!</span>';
        setTimeout(() => banner.remove(), 3000);
      }
      const labelEl = overlay.querySelector('.cl-modal-label');
      if (labelEl) labelEl.textContent = 'Resumo com IA · 📄 PDF analisado';

    } catch (err) {
      if (banner) {
        banner.innerHTML = `
          <span style="color:#ff4757">❌ Erro: ${esc(err.message)}</span>
          <input type="file" id="cl-modal-file-input" accept=".pdf,image/*" style="display:none">
          <label class="cl-modal-btn cl-modal-btn--resumir-manual" for="cl-modal-file-input">📎 Tentar novamente</label>`;
        document.getElementById('cl-modal-file-input')?.addEventListener('change', () => fileInput.dispatchEvent(new Event('change')));
      }
    }
  });
}

function _mostrarSeletorMateria(saveBtn, resumoEntry) {
  const subjects = window._STATE_subjects?.() || [];
  if (!subjects.length) { alert('Adicione matérias primeiro.'); return; }

  const sel = document.createElement('div');
  sel.className = 'cl-subject-picker';
  sel.innerHTML = `
    <span style="font-size:12px;color:var(--text2)">Escolha a matéria:</span>
    ${subjects.map(s => `
      <button class="cl-subject-pick-btn" data-id="${s.id}" style="border-left:3px solid ${s.color}">
        ${esc(s.name.slice(0, 25))}
      </button>`).join('')}
    <button class="cl-subject-pick-btn cl-subject-pick-btn--cancel">Cancelar</button>`;

  saveBtn.replaceWith(sel);

  sel.querySelectorAll('[data-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ok = await window._saveResumoToSubject?.(btn.dataset.id, resumoEntry);
      if (ok) {
        sel.outerHTML = `<button class="cl-modal-btn cl-modal-btn--save" style="color:#2ed573;border-color:rgba(46,213,115,0.4)" disabled>✅ Salvo!</button>`;
      }
    });
  });
  sel.querySelector('.cl-subject-pick-btn--cancel')?.addEventListener('click', () => {
    sel.outerHTML = `<button class="cl-modal-btn cl-modal-btn--save" id="cl-modal-save">🔖 Salvar</button>`;
  });
}

function _markdownParaHtml(md) {
  // Process line by line to avoid paragraph-wrapping already-tagged lines
  const lines = md
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .split('\n');

  const out = [];
  let inList = false;

  for (const raw of lines) {
    let line = raw;
    if (/^### /.test(line))        { if (inList) { out.push('</ul>'); inList = false; } out.push(line.replace(/^### (.+)/, '<h3>$1</h3>')); continue; }
    if (/^## /.test(line))         { if (inList) { out.push('</ul>'); inList = false; } out.push(line.replace(/^## (.+)/, '<h2>$1</h2>')); continue; }
    if (/^# /.test(line))          { if (inList) { out.push('</ul>'); inList = false; } out.push(line.replace(/^# (.+)/, '<h1>$1</h1>')); continue; }
    if (/^---+$/.test(line.trim())) { if (inList) { out.push('</ul>'); inList = false; } out.push('<hr>'); continue; }
    if (/^[-*] /.test(line))       { if (!inList) { out.push('<ul>'); inList = true; } out.push(line.replace(/^[-*] (.+)/, '<li>$1</li>')); continue; }
    if (inList)                    { out.push('</ul>'); inList = false; }
    if (line.trim() === '')        { out.push(''); continue; }
    out.push(`<p>${line}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
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
    .cl-badge--material  { background: rgba(66,133,244,0.12);  color: rgba(66,133,244,0.95); }
    .cl-badge--aviso     { background: rgba(251,188,4,0.12);   color: rgba(180,130,0,0.95); }
    .cl-badge--atividade { background: rgba(46,213,115,0.12);  color: rgba(30,160,80,0.95); }
    .cl-post-turma { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
    .cl-post-data { font-size: 11px; color: var(--text2); white-space: nowrap; }
    .cl-post-card-top-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
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
    .cl-resumir-btn {
      display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px;
      background: rgba(138,43,226,0.1); border: 1px solid rgba(138,43,226,0.3);
      border-radius: 20px; font-size: 11px; font-weight: 600; color: rgba(138,43,226,0.9);
      cursor: pointer; transition: background 0.15s, transform 0.1s; white-space: nowrap;
    }
    .cl-resumir-btn:hover:not(:disabled) { background: rgba(138,43,226,0.2); transform: scale(1.03); }
    .cl-resumir-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    /* Modal */
    .cl-modal-overlay {
      position: fixed; inset: 0; z-index: 9999;
      background: rgba(0,0,0,0.55); backdrop-filter: blur(4px);
      display: flex; align-items: center; justify-content: center; padding: 16px;
    }
    .cl-modal-box {
      background: var(--bg2, #1e1e2e); border: 1px solid var(--border, rgba(255,255,255,0.1));
      border-radius: 16px; width: 100%; max-width: 680px; max-height: 85vh;
      display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 24px 64px rgba(0,0,0,0.4);
    }
    .cl-modal-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 20px; border-bottom: 1px solid var(--border, rgba(255,255,255,0.1));
      gap: 12px; flex-shrink: 0;
    }
    .cl-modal-title { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .cl-modal-icon { font-size: 22px; flex-shrink: 0; }
    .cl-modal-label { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: rgba(138,43,226,0.9); }
    .cl-modal-subtitle { font-size: 14px; font-weight: 600; color: var(--text, #e0e0e0); margin-top: 2px; }
    .cl-modal-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .cl-modal-btn {
      padding: 6px 14px; border-radius: 8px; font-size: 12px; font-weight: 600;
      cursor: pointer; border: 1px solid transparent; transition: opacity 0.15s;
    }
    .cl-modal-btn--save {
      background: rgba(66,133,244,0.12); border-color: rgba(66,133,244,0.35); color: rgba(66,133,244,0.95);
    }
    .cl-modal-btn--save:hover:not(:disabled) { opacity: 0.8; }
    .cl-modal-btn--save:disabled { cursor: default; }
    .cl-modal-btn--download {
      background: rgba(46,213,115,0.15); border-color: rgba(46,213,115,0.35); color: #2ed573;
    }
    .cl-modal-btn--download:hover { opacity: 0.8; }
    .cl-modal-btn--close {
      background: rgba(255,255,255,0.07); border-color: rgba(255,255,255,0.15); color: var(--text2, #aaa);
    }
    .cl-modal-btn--close:hover { opacity: 0.8; }
    .cl-modal-upload-banner {
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      padding: 10px 20px; background: rgba(255,183,0,0.08);
      border-bottom: 1px solid rgba(255,183,0,0.2); font-size: 12px; color: rgba(255,183,0,0.9);
    }
    .cl-modal-btn--resumir-manual {
      background: rgba(138,43,226,0.15); border: 1px solid rgba(138,43,226,0.35);
      color: rgba(138,43,226,0.95); white-space: nowrap; margin-left: auto;
    }
    .cl-modal-btn--resumir-manual:hover { opacity: 0.8; }
    .cl-modal-body {
      padding: 20px 24px; overflow-y: auto; font-size: 14px; line-height: 1.7;
      color: var(--text, #e0e0e0);
    }
    .cl-modal-body h1, .cl-modal-body h2, .cl-modal-body h3 {
      color: var(--text, #e0e0e0); margin: 16px 0 8px; font-weight: 700;
    }
    .cl-modal-body h1 { font-size: 18px; border-bottom: 1px solid var(--border, rgba(255,255,255,0.1)); padding-bottom: 6px; }
    .cl-modal-body h2 { font-size: 16px; }
    .cl-modal-body h3 { font-size: 14px; }
    .cl-modal-body ul { padding-left: 20px; margin: 8px 0; }
    .cl-modal-body li { margin-bottom: 4px; }
    .cl-modal-body p { margin: 8px 0; }
    .cl-modal-body code { background: rgba(255,255,255,0.08); border-radius: 4px; padding: 1px 5px; font-size: 13px; }
    .cl-modal-body strong { font-weight: 700; color: var(--text, #e0e0e0); }
  `;
  document.head.appendChild(s);
})();