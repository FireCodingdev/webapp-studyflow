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
  'https://www.googleapis.com/auth/drive.readonly',
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
  `;
  document.head.appendChild(style);
}

// ─── POSTS DO CLASSROOM NA PÁGINA DE MATERIAIS ────────────────────────────────
export async function renderPostsClassroom(token, targetEl, limit) {
  // Sempre requer um targetEl explícito — não injeta mais na página de Materiais
  const section = targetEl;
  if (!section) return;

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
    const recentes = todosPosts.slice(0, limit || 20);

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
  const dataISO = post.updateTime || post.creationTime || null;
  const data = dataISO
    ? new Date(dataISO).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';

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

  const tituloHtml = (isMaterial && !textoRaw && post.title)
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
      ${tituloHtml}${texto}${linksHtml}
    </div>`;
}

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

    const [idToken, classroomToken] = await Promise.all([
      auth.currentUser.getIdToken(),
      getTokenValido(uid),
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
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Erro ${resp.status}`);
    }

    const { resumo, usedFile } = await resp.json();
    _mostrarModalResumo(titulo, resumo, usedFile, driveFileId, driveAltLink, textoPrincipal, idToken);

  } catch (err) {
    alert('Não foi possível resumir: ' + err.message);
  } finally {
    clearInterval(loadingInterval);
    btn.disabled = false;
    btn.textContent = '✨ Resumir';
  }
};

function _mostrarModalResumo(titulo, markdown, usedFile, driveFileId, driveAltLink, textoPrincipal, idToken) {
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
        <span>⚠️ Não consegui acessar o PDF automaticamente.</span>
        <input type="file" id="cl-modal-file-input" accept=".pdf,image/*" style="display:none">
        <button class="cl-modal-btn cl-modal-btn--resumir-manual" id="cl-modal-retry-btn">
          📥 Baixar PDF e resumir novamente
        </button>
      </div>` : ''}
      <div class="cl-modal-body" id="cl-modal-content">${_markdownParaHtml(markdown)}</div>
    </div>`;

  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('cl-modal-close').addEventListener('click', () => overlay.remove());

  const contentEl = document.getElementById('cl-modal-content');
  if (contentEl) contentEl._mdSource = markdown;

  // Salvar resumo na conta (Firestore)
  document.getElementById('cl-modal-save').addEventListener('click', async () => {
    const saveBtn = document.getElementById('cl-modal-save');
    saveBtn.disabled = true;
    saveBtn.textContent = '⏳ Salvando...';
    try {
      const uid = auth.currentUser?.uid;
      if (!uid) throw new Error('login necessário');
      const { doc: fsDoc, getDoc: fsGetDoc, updateDoc: fsUpdateDoc, setDoc: fsSetDoc } =
        await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
      const { db } = await import('./firebase.js');
      const ref   = fsDoc(db, 'users', uid);
      const snap  = await fsGetDoc(ref);
      const existing = snap.data()?.classroomSummaries || [];
      const entry = {
        titulo,
        resumo: contentEl?._mdSource || markdown,
        savedAt: new Date().toISOString(),
      };
      // Evita duplicatas pelo título
      const filtered = existing.filter(s => s.titulo !== titulo);
      await fsUpdateDoc(ref, { classroomSummaries: [...filtered, entry] });
      saveBtn.textContent = '✅ Salvo!';
      saveBtn.style.color = '#2ed573';
      saveBtn.style.borderColor = 'rgba(46,213,115,0.4)';
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = '🔖 Salvar';
      alert('Erro ao salvar: ' + err.message);
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
  const retryBtn  = document.getElementById('cl-modal-retry-btn');

  // Botão único: abre o PDF no Drive + abre o seletor de arquivo
  retryBtn.addEventListener('click', () => {
    if (driveAltLink) window.open(driveAltLink, '_blank');
    fileInput.click();
  });

  // Assim que o arquivo for selecionado, re-resume automaticamente
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    const banner = document.getElementById('cl-modal-upload-banner');
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

      const resp = await fetch(GEMINI_PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
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
          <button class="cl-modal-btn cl-modal-btn--resumir-manual" id="cl-modal-retry-btn" style="margin-left:8px">Tentar novamente</button>`;
        document.getElementById('cl-modal-retry-btn')?.addEventListener('click', () => {
          if (driveAltLink) window.open(driveAltLink, '_blank');
          fileInput.click();
        });
      }
    }
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
    .cl-badge--material { background: rgba(66,133,244,0.12); color: rgba(66,133,244,0.95); }
    .cl-badge--aviso    { background: rgba(251,188,4,0.12);  color: rgba(180,130,0,0.95); }
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