// ===== CLASSROOM.JS =====
// Integração com Google Classroom via OAuth 2.0 + polling.
// Completamente isolado — não modifica nenhuma função existente do app.
//
// Como usar:
//   1. Importe initClassroom no app.js e chame após o login do usuário
//   2. Adicione o botão no index.html (ver comentário no final deste arquivo)
//   3. Adicione as credenciais OAuth no Google Cloud Console (ver SETUP abaixo)
//
// SETUP no Google Cloud Console:
//   - Ative a API "Google Classroom API"
//   - Crie credenciais OAuth 2.0 (tipo: Web application)
//   - Em "Authorized redirect URIs" adicione: https://aplicativo-studyflow-4f501.firebaseapp.com/__/auth/handler
//   - Copie o CLIENT_ID gerado e cole abaixo

import { db, auth } from './firebase.js';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ─── CONFIGURAÇÃO ────────────────────────────────────────────────────────────
const CLASSROOM_CLIENT_ID = 'SEU_CLIENT_ID_AQUI.apps.googleusercontent.com';
const CLASSROOM_SCOPES = [
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
  'https://www.googleapis.com/auth/classroom.announcements.readonly',
].join(' ');

// ─── ESTADO INTERNO ───────────────────────────────────────────────────────────
let _STATE = null;
let _hooks = null;

// ─── PONTO DE ENTRADA ────────────────────────────────────────────────────────
/**
 * Chame esta função no app.js após o login do usuário, passando STATE e hooks.
 * Exemplo:
 *   import { initClassroom } from './classroom.js';
 *   initClassroom(STATE, { save, renderTasks, renderDashboard, showToast });
 */
export function initClassroom(STATE, hooks) {
  _STATE = STATE;
  _hooks = hooks;

  injetarBotaoClassroom();
  injetarEstilosClassroom();

  // Ao iniciar, verifica se já tem token salvo e sincroniza automaticamente
  const uid = auth.currentUser?.uid;
  if (uid) {
    sincronizarSeConectado(uid);
  }
}

// ─── OAUTH: CONECTAR ─────────────────────────────────────────────────────────
/**
 * Abre o popup OAuth do Google. Quando o usuário autorizar,
 * salva o access_token no Firestore e faz a primeira sincronização.
 */
async function conectarClassroom() {
  if (CLASSROOM_CLIENT_ID === 'SEU_CLIENT_ID_AQUI.apps.googleusercontent.com') {
    _hooks.showToast('⚠️ Configure o CLIENT_ID no classroom.js antes de usar.');
    return;
  }

  const uid = auth.currentUser?.uid;
  if (!uid) { _hooks.showToast('Faça login primeiro.'); return; }

  // Monta URL de autorização do Google
  const redirectUri = encodeURIComponent(`${location.origin}/classroom-callback.html`);
  const scope       = encodeURIComponent(CLASSROOM_SCOPES);
  const state       = encodeURIComponent(uid); // passa uid para recuperar no callback

  const authUrl = [
    'https://accounts.google.com/o/oauth2/v2/auth',
    `?client_id=${CLASSROOM_CLIENT_ID}`,
    `&redirect_uri=${redirectUri}`,
    '&response_type=token',
    `&scope=${scope}`,
    `&state=${state}`,
    '&include_granted_scopes=true',
  ].join('');

  // Abre popup
  const popup = window.open(authUrl, 'classroom-oauth', 'width=500,height=650,menubar=no,toolbar=no');

  // Escuta mensagem do popup via postMessage (enviada pelo classroom-callback.html)
  window.addEventListener('message', async function handler(e) {
    if (e.origin !== location.origin) return;
    if (e.data?.type !== 'classroom-token') return;
    window.removeEventListener('message', handler);
    popup?.close();

    const { access_token, expires_in } = e.data;
    if (!access_token) {
      _hooks.showToast('❌ Falha ao conectar com o Classroom.');
      return;
    }

    // Salva token no Firestore
    const expiresAt = Date.now() + (parseInt(expires_in) * 1000);
    await setDoc(
      doc(db, 'users', uid),
      { classroom: { access_token, expiresAt, connectedAt: new Date().toISOString() } },
      { merge: true }
    );

    _hooks.showToast('✅ Google Classroom conectado!');
    atualizarBotaoClassroom(true);
    await sincronizarClassroom(uid, access_token);
  });
}

// ─── SINCRONIZAÇÃO ────────────────────────────────────────────────────────────
/**
 * Verifica se já existe token salvo no Firestore e sincroniza.
 * Chamado automaticamente ao abrir o app.
 */
async function sincronizarSeConectado(uid) {
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    const classroom = snap.data()?.classroom;
    if (!classroom?.access_token) return; // usuário nunca conectou

    // Token expirado? (tokens implícitos duram 1h)
    if (Date.now() > classroom.expiresAt) {
      atualizarBotaoClassroom(false, true); // mostra "reconectar"
      return;
    }

    atualizarBotaoClassroom(true);
    await sincronizarClassroom(uid, classroom.access_token);
  } catch (err) {
    console.warn('[Classroom] Erro ao verificar token:', err);
  }
}

/**
 * Busca turmas e atividades do Classroom e importa como tasks no app.
 */
async function sincronizarClassroom(uid, token) {
  try {
    setBotaoSincronizando(true);

    // 1. Busca turmas ativas
    const cursosRes = await fetch(
      'https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE&pageSize=20',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!cursosRes.ok) throw new Error(`Classroom API: ${cursosRes.status}`);
    const { courses = [] } = await cursosRes.json();

    if (courses.length === 0) {
      _hooks.showToast('Nenhuma turma ativa encontrada no Classroom.');
      setBotaoSincronizando(false);
      return;
    }

    // 2. Busca atividades de cada turma em paralelo
    const todasAtividades = await Promise.all(
      courses.map(curso => buscarAtividadesDaTurma(curso, token))
    );

    // 3. Importa as que ainda não existem no STATE
    const novas = importarAtividades(todasAtividades.flat());

    // 4. Salva e renderiza (usando as funções já existentes do app)
    if (novas > 0) {
      await _hooks.save();
      _hooks.renderTasks();
      _hooks.renderDashboard();
      _hooks.showToast(`📚 ${novas} atividade${novas > 1 ? 's' : ''} importada${novas > 1 ? 's' : ''} do Classroom!`);
    } else {
      _hooks.showToast('✅ Classroom sincronizado — nenhuma novidade.');
    }

    // Salva timestamp da última sync
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
  } catch {
    return [];
  }
}

/**
 * Converte atividades do Classroom para o formato de task do StudyFlow
 * e adiciona apenas as que ainda não existem (evita duplicatas).
 * Retorna a quantidade de tarefas novas adicionadas.
 */
function importarAtividades(atividades) {
  const idsExistentes = new Set(_STATE.tasks.map(t => t.classroomId).filter(Boolean));
  let novas = 0;

  for (const cw of atividades) {
    if (idsExistentes.has(cw.id)) continue; // já importada

    // Converte due date do formato do Classroom (objeto {year,month,day})
    let deadline = null;
    if (cw.dueDate) {
      const { year, month, day } = cw.dueDate;
      deadline = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    // Tenta associar a uma matéria existente pelo nome da turma
    const subject = encontrarMateria(cw._nometurma);

    _STATE.tasks.push({
      id:            `classroom_${cw.id}`,
      classroomId:   cw.id,                          // chave para evitar duplicatas
      title:         cw.title || 'Atividade sem título',
      subjectId:     subject?.id   || null,
      subjectName:   subject?.name || cw._nometurma, // usa nome da turma se não achar matéria
      subjectColor:  subject?.color || '#4285F4',    // azul Google como fallback
      type:          'work',
      deadline,
      notes:         cw.description || null,
      done:          false,
      createdAt:     cw.creationTime || new Date().toISOString(),
      source:        'classroom',                    // identifica origem
    });

    novas++;
  }

  return novas;
}

/**
 * Tenta encontrar uma matéria no STATE cujo nome esteja contido
 * no nome da turma do Classroom (busca parcial, case-insensitive).
 */
function encontrarMateria(nomeTurma) {
  if (!nomeTurma || !_STATE.subjects?.length) return null;
  const turmaLower = nomeTurma.toLowerCase();
  return _STATE.subjects.find(s => turmaLower.includes(s.name.toLowerCase())) || null;
}

// ─── BOTÃO INJETADO NA SIDEBAR ────────────────────────────────────────────────
function injetarBotaoClassroom() {
  if (document.getElementById('classroom-btn-wrapper')) return;

  // Injeta dentro do footer, antes do botão Sair
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

  // Expõe globalmente para o onclick
  window._conectarClassroom = () => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    // Se já conectado, faz sync manual; senão abre OAuth
    getDoc(doc(db, 'users', uid)).then(snap => {
      const cl = snap.data()?.classroom;
      if (cl?.access_token && Date.now() < cl.expiresAt) {
        sincronizarClassroom(uid, cl.access_token);
      } else {
        conectarClassroom();
      }
    });
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
  btn.disabled    = ativo;
  label.textContent = ativo ? '⏳ Sincronizando...' : '📚 Sincronizar Classroom';
}

// ─── ESTILOS ──────────────────────────────────────────────────────────────────
function injetarEstilosClassroom() {
  if (document.getElementById('classroom-styles')) return;
  const style = document.createElement('style');
  style.id = 'classroom-styles';
  style.textContent = `
    .classroom-btn-wrapper {
      padding: 0 0 10px;
      width: 100%;
    }
    .classroom-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 10px 14px;
      background: rgba(66, 133, 244, 0.1);
      border: 1px dashed rgba(66, 133, 244, 0.45);
      border-radius: 12px;
      color: rgba(66, 133, 244, 0.95);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s, border-color 0.2s;
    }
    .classroom-btn:hover:not(:disabled) {
      background: rgba(66, 133, 244, 0.18);
      border-color: rgba(66, 133, 244, 0.7);
    }
    .classroom-btn:disabled {
      opacity: 0.6;
      cursor: default;
    }
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

// ─── INSTRUÇÕES DE INTEGRAÇÃO ─────────────────────────────────────────────────
//
// 1. No app.js, adicione o import no topo:
//      import { initClassroom } from './classroom.js';
//
// 2. No app.js, dentro da função initApp() após o initIA(...):
//      initClassroom(STATE, { save, renderTasks, renderDashboard, showToast });
//
// 3. Crie o arquivo classroom-callback.html na raiz do projeto (ver abaixo).
//
// 4. No Google Cloud Console:
//    a. Ative a "Google Classroom API"
//    b. Crie credenciais OAuth 2.0 → Web application
//    c. Em "Authorized redirect URIs" adicione:
//       https://webapp-studyflow.pages.dev/classroom-callback.html
//    d. Cole o CLIENT_ID gerado na constante CLASSROOM_CLIENT_ID acima