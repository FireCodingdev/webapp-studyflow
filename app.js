import {
  auth,
  db,
  loginUser,
  registerUser,
  logoutUser,
  onAuthStateChanged,
  syncToFirestore,
  loadFromFirestore,
} from './firebase.js';

import { initIA } from './ia.js';
import { initClassroom, renderPostsClassroom } from './classroom.js';
import { initFeed, renderFeed } from './social/feed.js';
import { initRealtimeNotifications, stopRealtimeNotifications } from './social/notifications-rt.js';
import { checkAchievements, showAchievementToast } from './components/achievement-toast.js';

// ===== STATE =====
// Helper: busca cor atual da matéria por id, com fallback por nome
function getSubjectColor(subjectId, subjectName, fallback) {
  // 1. Busca exata por ID (mais confiável)
  const byId = STATE.subjects.find(s => s.id === subjectId);
  if (byId) return byId.color;

  if (subjectName) {
    const nameLower = subjectName.toLowerCase();

    // 2. Busca exata por nome
    const byExactName = STATE.subjects.find(s => s.name.toLowerCase() === nameLower);
    if (byExactName) return byExactName.color;

    // 3. Busca parcial bidirecional: nome da matéria contém o subjectName OU subjectName contém o nome da matéria
    const byPartial = STATE.subjects.find(s => {
      const sLower = s.name.toLowerCase();
      return nameLower.includes(sLower) || sLower.includes(nameLower);
    });
    if (byPartial) return byPartial.color;
  }

  return fallback || 'var(--accent)';
}

// Corrige tasks cujo subjectId não bate com nenhuma matéria salva,
// usando busca bidirecional pelo subjectName para reencontrar a matéria correta.
function fixTaskSubjects() {
  if (!STATE.subjects.length || !STATE.tasks.length) return;
  for (const task of STATE.tasks) {
    // Já tem id válido? pula
    if (task.subjectId && STATE.subjects.find(s => s.id === task.subjectId)) continue;
    if (!task.subjectName) continue;
    const nameLower = task.subjectName.toLowerCase();
    const match = STATE.subjects.find(s => {
      const sLower = s.name.toLowerCase();
      return nameLower.includes(sLower) || sLower.includes(nameLower);
    });
    if (match) {
      task.subjectId    = match.id;
      task.subjectColor = match.color;
      task.subjectName  = match.name;
    }
  }
}

const STATE = {
  subjects: [],
  classes: [],
  tasks: [],
  flashcards: [],
  currentPage: 'dashboard',
  selectedDay: new Date().getDay(),
  taskFilter: 'all',
  flashcardFilter: 'all',
  currentUser: null,
  isOnline: navigator.onLine,
  pendingSync: false,
};

const COLORS = ['#6c63ff','#ff6584','#ffa502','#2ed573','#1e90ff','#ff4757','#eccc68','#a29bfe'];
const DAYS = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];

// ===== UI HELPERS =====
function escapeHtml(value) {
  const s = String(value ?? '');
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function toLocalISODate(d = new Date()) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isHttpUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function updateSyncStatus(mode) {
  const statusEl = document.getElementById('sidebar-sync-status');
  if (!statusEl) return;

  switch(mode) {
    case 'syncing': statusEl.textContent = 'Sincronizando...'; break;
    case 'synced': statusEl.textContent = 'Sincronizado ✓'; break;
    case 'offline': statusEl.textContent = 'Offline (Pendente)'; break;
    case 'error': statusEl.textContent = 'Erro ao sincronizar'; break;
    case 'local': statusEl.textContent = 'Salvo localmente'; break;
    default: statusEl.textContent = mode;
  }
}

function showSyncIndicator(active) {
  const el = document.getElementById('sync-indicator');
  if (!el) return;
  if (active) {
    el.style.display = 'block';
    el.classList.add('spinning');
  } else {
    el.classList.remove('spinning');
    setTimeout(() => { el.style.display = 'none'; }, 1000);
  }
}

// ===== LOCAL STORAGE (fallback offline) =====
function saveLocal() {
  localStorage.setItem('studyflow_v3', JSON.stringify({
    subjects: STATE.subjects,
    classes: STATE.classes,
    tasks: STATE.tasks,
    flashcards: STATE.flashcards,
  }));
}

function loadLocal() {
  const raw = localStorage.getItem('studyflow_v3');
  if (raw) {
    try {
      const data = JSON.parse(raw);
      STATE.subjects = data.subjects || [];
      STATE.classes = data.classes || [];
      STATE.tasks = data.tasks || [];
      STATE.flashcards = data.flashcards || [];
      fixTaskSubjects();
      return true;
    } catch(e) {}
  }
  // Fallback para migração da versão v2, caso exista
  const oldRaw = localStorage.getItem('studyflow_v2');
  if (oldRaw) {
    try {
      const data = JSON.parse(oldRaw);
      STATE.subjects = data.subjects || [];
      STATE.classes = data.classes || [];
      STATE.tasks = data.tasks || [];
      STATE.flashcards = [];
      return true;
    } catch(e) {}
  }
  return false;
}

// ===== FIREBASE SYNC =====
async function syncData() {
  if (!STATE.currentUser) return false;
  
  showSyncIndicator(true);
  updateSyncStatus('syncing');

  // Garante que o token de autenticação está fresco antes de sincronizar
  try {
    await STATE.currentUser.getIdToken(true);
  } catch (tokenErr) {
    console.warn('Não foi possível renovar token:', tokenErr.message);
  }
  
  const ok = await syncToFirestore(STATE.currentUser.uid, {
    subjects: STATE.subjects,
    classes: STATE.classes,
    tasks: STATE.tasks,
    flashcards: STATE.flashcards,
  });
  
  showSyncIndicator(false);
  
  if (ok) {
    STATE.pendingSync = false;
    updateSyncStatus('synced');
  } else {
    STATE.pendingSync = true;
    updateSyncStatus('error');
    // Tenta sincronizar novamente após 5 segundos
    setTimeout(async () => {
      if (STATE.pendingSync && STATE.isOnline && STATE.currentUser) {
        console.log('Tentando sincronizar novamente...');
        await syncData();
      }
    }, 5000);
  }
  return ok;
}

// Combined save: always save locally + try to sync
async function save() {
  saveLocal();
  if (STATE.isOnline && STATE.currentUser) {
    await syncData();
  } else {
    STATE.pendingSync = true;
    updateSyncStatus('local');
  }
}

// ===== ONLINE / OFFLINE DETECTION =====
window.addEventListener('online', async () => {
  STATE.isOnline = true;
  document.getElementById('offline-banner').style.display = 'none';
  if (STATE.pendingSync && STATE.currentUser) {
    await syncData();
  } else {
    updateSyncStatus('synced');
  }
});

window.addEventListener('offline', () => {
  STATE.isOnline = false;
  document.getElementById('offline-banner').style.display = 'block';
  updateSyncStatus('offline');
});

// ===== AUTH INIT =====
window.addEventListener('DOMContentLoaded', () => {
  // Timeout de segurança apenas para o estado inicial (antes do primeiro disparo)
  // Não bloqueia disparos futuros (login após timeout)
  let initialCheckDone = false;

  const authTimeout = setTimeout(() => {
    if (!initialCheckDone) {
      initialCheckDone = true;
      console.warn('Firebase auth timeout — exibindo tela de login');
      STATE.currentUser = null;
      showAuthScreen();
    }
  }, 8000);

  onAuthStateChanged(auth, async (user) => {
    // Cancela o timeout na primeira resposta do Firebase
    if (!initialCheckDone) {
      initialCheckDone = true;
      clearTimeout(authTimeout);
    }

    try {
      if (user) {
        STATE.currentUser = user;
        await initAppForUser(user);
      } else {
        STATE.currentUser = null;
        showAuthScreen();
      }
    } catch (err) {
      console.error('Falha ao inicializar após login:', err);
      STATE.currentUser = null;
      showAuthScreen();
      const errEl = document.getElementById('auth-error-login');
      if (errEl) showAuthError(errEl, 'Erro ao entrar. Recarregue a página e tente novamente.');
    }
  });
});

async function initAppForUser(user) {
  const name = user.displayName || user.email.split('@')[0];
  const initials = name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  const avatarEl = document.getElementById('sidebar-avatar');
  const nameEl = document.getElementById('sidebar-name');
  
  if (avatarEl) avatarEl.textContent = initials;
  if (nameEl) nameEl.textContent = name;

  // Restore cached avatar photo if available
  const cachedPhoto = localStorage.getItem('accs_avatar_' + user.uid);
  if (cachedPhoto && avatarEl) {
    avatarEl.innerHTML = `<img src="${cachedPhoto}" style="width:100%;height:100%;border-radius:50%;object-fit:cover" alt="avatar">`;
  }

  // Salva perfil público para sistema de busca de destinatário (envio de cards)
  try {
    const { setDoc: _setDoc, doc: _doc } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    await _setDoc(_doc(db, 'user_profiles', user.uid), {
      uid: user.uid, email: user.email, displayName: name, updatedAt: new Date().toISOString(),
    }, { merge: true });
  } catch(_) {}

  // Regra: quando online, prioriza a nuvem (Firestore) e só usa local como fallback.
  // Quando offline, usa apenas local.
  let loaded = false;

  if (STATE.isOnline) {
    showSyncIndicator(true);
    updateSyncStatus('syncing');
    try {
      const cloudData = await Promise.race([
        loadFromFirestore(user.uid),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Firestore timeout')), 10000))
      ]);
      if (cloudData) {
        STATE.subjects = cloudData.subjects || [];
        STATE.classes = cloudData.classes || [];
        STATE.tasks = cloudData.tasks || [];
        STATE.flashcards = cloudData.flashcards || [];
        fixTaskSubjects();
        saveLocal();
        loaded = true;
      } else {
        // Sem doc na nuvem: tenta local (ex: dados criados offline em outra sessão)
        loaded = loadLocal();
      }
    } catch (err) {
      console.warn('Falha ao carregar dados da nuvem:', err.message);
      // Se falhou por rede, entra em modo offline e usa dados locais
      STATE.isOnline = navigator.onLine;
      if (!STATE.isOnline) {
        document.getElementById('offline-banner').style.display = 'block';
        updateSyncStatus('offline');
      } else {
        updateSyncStatus('error');
      }
      loaded = loadLocal();
    }
    showSyncIndicator(false);
    if (STATE.isOnline) updateSyncStatus('synced');
  } else {
    loaded = loadLocal();
    updateSyncStatus('local');
  }

  if (!loaded) {
    // Garante arrays válidos mesmo sem nuvem/local
    STATE.subjects = STATE.subjects || [];
    STATE.classes = STATE.classes || [];
    STATE.tasks = STATE.tasks || [];
    STATE.flashcards = STATE.flashcards || [];
  }

  showMainApp();
  initRealtimeNotifications(user.uid);
  checkAchievements(STATE);
}

function showAuthScreen() {
  document.getElementById('splash').classList.add('hide');
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('main-app').style.display = 'none';
  resetAuthUi();
}

function showMainApp() {
  document.getElementById('splash').classList.add('hide');
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('main-app').style.display = 'flex';

  initGreeting();
  renderSidebar();
  renderDashboard();
  renderSchedule();
  renderTasks();
  renderFlashcards();
  initDayButtons();

  if (!STATE.isOnline) {
    document.getElementById('offline-banner').style.display = 'block';
  }

  // Inicializa o módulo de IA (importar cronograma por foto)
  initIA(STATE, {
    save,
    renderSidebar,
    renderSchedule,
    renderDashboard,
    renderTasks,
    showToast,
    openModal: window.openModal,
    closeModal: window.closeModal,
    navigateTo: window.navigateTo,
    COLORS,
    DAYS,
  });

  // Integração com Google Classroom (polling ao abrir o app)
  initClassroom(STATE, { save, renderTasks, renderDashboard, showToast });
  initFeed(STATE, { save, showToast, navigateTo: window.navigateTo });
}

// ===== AUTH HANDLERS =====
function resetAuthUi() {
  const btnLogin = document.getElementById('btn-login');
  if (btnLogin) {
    btnLogin.disabled = false;
    btnLogin.innerHTML = '<span>Entrar</span>';
  }

  const btnRegister = document.getElementById('btn-register');
  if (btnRegister) {
    btnRegister.disabled = false;
    btnRegister.innerHTML = '<span>Criar conta</span>';
  }
}

window.showAuthTab = function(tab) {
  document.getElementById('form-login').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('form-register').style.display = tab === 'register' ? 'block' : 'none';
  document.getElementById('tab-login').classList.toggle('active', tab === 'login');
  document.getElementById('tab-register').classList.toggle('active', tab === 'register');
};

window.handleLogin = async function() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('auth-error-login');
  const btn = document.getElementById('btn-login');

  if (!email || !password) { showAuthError(errEl, 'Preencha e-mail e senha'); return; }

  btn.disabled = true;
  btn.innerHTML = '<span>Entrando...</span>';
  errEl.style.display = 'none';

  try {
    await Promise.race([
      loginUser(email, password),
      new Promise((_, reject) => setTimeout(() => reject(new Error('AUTH_TIMEOUT')), 15000)),
    ]);
  } catch (err) {
    const msg = err?.message === 'AUTH_TIMEOUT'
      ? 'Tempo esgotado ao entrar. Verifique sua conexão e tente novamente.'
      : translateAuthError(err.code);
    showAuthError(errEl, msg);
    btn.disabled = false;
    btn.innerHTML = '<span>Entrar</span>';
  }
};

window.handleRegister = async function() {
  const name = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const errEl = document.getElementById('auth-error-register');
  const btn = document.getElementById('btn-register');

  if (!name || !email || !password) { showAuthError(errEl, 'Preencha todos os campos'); return; }
  if (password.length < 6) { showAuthError(errEl, 'Senha deve ter ao menos 6 caracteres'); return; }

  btn.disabled = true;
  btn.innerHTML = '<span>Criando conta...</span>';
  errEl.style.display = 'none';

  try {
    await Promise.race([
      registerUser(email, password, name),
      new Promise((_, reject) => setTimeout(() => reject(new Error('AUTH_TIMEOUT')), 20000)),
    ]);
  } catch (err) {
    const msg = err?.message === 'AUTH_TIMEOUT'
      ? 'Tempo esgotado ao criar conta. Verifique sua conexão e tente novamente.'
      : translateAuthError(err.code);
    showAuthError(errEl, msg);
    btn.disabled = false;
    btn.innerHTML = '<span>Criar conta</span>';
  }
};

window.handleLogout = async function() {
  if (!confirm('Deseja sair da sua conta?')) return;
  await logoutUser();
  STATE.subjects = [];
  STATE.classes = [];
  STATE.tasks = [];
  STATE.flashcards = [];
  localStorage.removeItem('studyflow_v3');
};

function showAuthError(el, msg) {
  el.textContent = msg;
  el.style.display = 'block';
}

function translateAuthError(code) {
  const map = {
    'auth/user-not-found': 'E-mail não cadastrado',
    'auth/wrong-password': 'Senha incorreta',
    'auth/invalid-email': 'E-mail inválido',
    'auth/email-already-in-use': 'E-mail já cadastrado',
    'auth/weak-password': 'Senha muito fraca',
    'auth/invalid-credential': 'E-mail ou senha incorretos',
    'auth/network-request-failed': 'Sem conexão com a internet',
  };
  return map[code] || 'Erro ao autenticar. Tente novamente.';
}

// ===== GREETING =====
function initGreeting() {
  const h = new Date().getHours();
  const el = document.getElementById('greeting-text');
  if (!el) return;
  if (h < 12) el.textContent = 'Bom dia! ☀️';
  else if (h < 18) el.textContent = 'Boa tarde! 🌤️';
  else el.textContent = 'Boa noite! 🌙';
}

// ===== NAVIGATION =====
window.navigateTo = function(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${page}`).classList.add('active');
  const navEl = document.querySelector(`[data-page="${page}"]`);
  if (navEl) navEl.classList.add('active');
  const titles = { dashboard: 'Dashboard', schedule: 'Cronograma', tasks: 'Atividades', flashcards: 'Flashcards', links: 'Materiais & Links', feed: 'Feed Social', social: 'Comunidade' };
  document.getElementById('page-title').textContent = titles[page] || page;
  STATE.currentPage = page;
  
  if (page === 'dashboard') renderDashboard();
  if (page === 'schedule') renderSchedule();
  if (page === 'tasks') renderTasks();
  if (page === 'flashcards') renderFlashcards();
  if (page === 'links') {
    renderLinks();
    // Exibe posts do Classroom se o usuário já estiver conectado
    window._renderPostsClassroom?.();
  }
  if (page === 'feed') window._renderFeed?.();
  if (page === 'social') window._renderSocialPage?.();
  closeSidebar();
};

// ===== SIDEBAR =====
window.openSidebar = function() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-overlay').classList.add('active');
};
window.closeSidebar = function() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('active');
};

function renderSidebar() {
  const list = document.getElementById('subjects-list');
  if (!list) return;
  list.innerHTML = STATE.subjects.map(s => `
    <div class="subject-item" onclick="filterBySubject('${s.id}')">
      <div class="subject-dot" style="background:${s.color}"></div>
      <span class="subject-name">${escapeHtml(s.name)}</span>
    </div>
  `).join('');
}

window.filterBySubject = function(id) {
  navigateTo('tasks');
  STATE.taskFilter = 'all';
  renderTasks(id);
  closeSidebar();
};

// ===== ADD SUBJECT =====
window.openAddSubject = function() {
  const colors = COLORS.map((c, i) => `
    <div class="color-swatch ${i === 0 ? 'selected' : ''}" style="background:${c}" data-color="${c}"></div>
  `).join('');
  openModal('Nova Matéria', `
    <div class="form-group">
      <label class="form-label">Nome da Matéria</label>
      <input id="sub-name" class="form-input" placeholder="Ex: Matemática" />
    </div>
    <div class="form-group">
      <label class="form-label">Cor</label>
      <div class="color-picker" id="color-picker-container">${colors}</div>
    </div>
    <div class="form-group">
      <label class="form-label">Links Úteis (um por linha)</label>
      <textarea id="sub-links" class="form-textarea" placeholder="https://drive.google.com/...&#10;https://youtube.com/...&#10;https://notion.so/..." rows="3"></textarea>
      <span style="font-size:11px;color:var(--text2)">Cole links do Google Drive, YouTube, Notion, etc.</span>
    </div>
    <button class="btn-primary" onclick="saveSubject()">Adicionar Matéria</button>
  `);

  // Event delegation: escuta cliques no container, não nos swatches individualmente
  // Isso evita problemas de bubbling com o overlay do modal
  setTimeout(() => {
    const container = document.getElementById('color-picker-container');
    if (container) {
      container.addEventListener('click', function(e) {
        const swatch = e.target.closest('.color-swatch');
        if (!swatch) return;
        e.stopPropagation();
        container.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
        swatch.classList.add('selected');
      });
    }
  }, 0);
};

window.selectColor = function(el) {
  // mantida por compatibilidade — a lógica real agora usa event delegation em openAddSubject
  document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
  el.classList.add('selected');
};

window.saveSubject = async function() {
  const name = document.getElementById('sub-name')?.value?.trim();
  if (!name) { showToast('Digite o nome da matéria'); return; }
  const colorEl = document.querySelector('.color-swatch.selected');
  const color = colorEl ? colorEl.dataset.color : COLORS[0];
  const linksRaw = document.getElementById('sub-links')?.value || '';
  const links = linksRaw
    .split('\n')
    .map(l => l.trim())
    .filter(isHttpUrl);
  
  STATE.subjects.push({ id: Date.now().toString(), name, color, links });
  await save();
  renderSidebar();
  closeModal();
  showToast('✅ Matéria adicionada!');
};

// ===== ADD CLASS =====
window.openAddClass = function() {
  const subOptions = STATE.subjects.map(s =>
    `<option value="${s.id}">${s.name}</option>`
  ).join('');
  const dayOptions = DAYS.map((d, i) =>
    `<option value="${i}" ${i === STATE.selectedDay ? 'selected' : ''}>${d}</option>`
  ).join('');

  openModal('Nova Aula', `
    <div class="form-group">
      <label class="form-label">Matéria</label>
      <select id="cls-subject" class="form-select">
        ${subOptions || '<option>Crie uma matéria primeiro</option>'}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Dia da Semana</label>
      <select id="cls-day" class="form-select">${dayOptions}</select>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Início</label>
        <input id="cls-start" class="form-input" type="time" value="08:00" />
      </div>
      <div class="form-group">
        <label class="form-label">Fim</label>
        <input id="cls-end" class="form-input" type="time" value="09:00" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Local / Sala (opcional)</label>
      <input id="cls-room" class="form-input" placeholder="Ex: Sala 201" />
    </div>
    <button class="btn-primary" onclick="saveClass()">Salvar Aula</button>
  `);
};

window.saveClass = async function() {
  if (!STATE.subjects.length) { showToast('Adicione uma matéria primeiro'); return; }
  const subjectId = document.getElementById('cls-subject')?.value;
  const day = parseInt(document.getElementById('cls-day')?.value);
  const start = document.getElementById('cls-start')?.value;
  const end = document.getElementById('cls-end')?.value;
  const room = document.getElementById('cls-room')?.value?.trim();
  if (!start || !end) { showToast('Preencha os horários'); return; }
  if (end <= start) { showToast('Horário de fim deve ser após o início'); return; }
  
  const subject = STATE.subjects.find(s => s.id === subjectId);
  STATE.classes.push({
    id: Date.now().toString(),
    subjectId,
    subjectName: subject?.name || '?',
    subjectColor: subject?.color || '#6c63ff',
    day, start, end, room,
  });
  
  await save();
  renderSchedule();
  renderDashboard();
  closeModal();
  showToast('✅ Aula adicionada!');
};

// ===== ADD TASK =====
window.openAddTask = function() {
  const subOptions = STATE.subjects.map(s =>
    `<option value="${s.id}">${s.name}</option>`
  ).join('');
  
  openModal('Nova Atividade', `
    <div class="form-group">
      <label class="form-label">Título</label>
      <input id="task-title" class="form-input" placeholder="Ex: Lista de exercícios cap. 3" />
    </div>
    <div class="form-group">
      <label class="form-label">Matéria</label>
      <select id="task-subject" class="form-select">
        <option value="">Sem matéria</option>
        ${subOptions}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Tipo</label>
      <select id="task-type" class="form-select">
        <option value="task">Atividade</option>
        <option value="exam">Prova / Avaliação</option>
        <option value="work">Trabalho</option>
        <option value="study">Estudo</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Prazo</label>
      <input id="task-deadline" class="form-input" type="date" />
    </div>
    <div class="form-group">
      <label class="form-label">Observações (opcional)</label>
      <textarea id="task-notes" class="form-textarea" placeholder="Detalhes, capítulos, etc..."></textarea>
    </div>
    <button class="btn-primary" onclick="saveTask()">Salvar Atividade</button>
  `);
  
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  document.getElementById('task-deadline').value = toLocalISODate(tomorrow);
};

window.saveTask = async function() {
  const title = document.getElementById('task-title')?.value?.trim();
  if (!title) { showToast('Digite o título da atividade'); return; }
  
  const subjectId = document.getElementById('task-subject')?.value;
  const type = document.getElementById('task-type')?.value || 'task';
  const deadline = document.getElementById('task-deadline')?.value;
  const notes = document.getElementById('task-notes')?.value?.trim();
  const subject = STATE.subjects.find(s => s.id === subjectId);
  
  STATE.tasks.push({
    id: Date.now().toString(),
    title,
    subjectId: subjectId || null,
    subjectName: subject?.name || null,
    subjectColor: subject?.color || null,
    type, deadline, notes,
    done: false,
    createdAt: new Date().toISOString(),
  });
  
  await save();
  renderTasks();
  renderDashboard();
  closeModal();
  showToast('✅ Atividade criada!');
};

// ===== RENDER DASHBOARD =====
function renderDashboard() {
  const now = new Date();
  const today = now.getDay();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const todayClasses = STATE.classes.filter(c => c.day === today)
    .sort((a, b) => a.start.localeCompare(b.start));
  const pendingTasks = STATE.tasks.filter(t => !t.done);
  const doneTasks   = STATE.tasks.filter(t => t.done);
  const exams       = pendingTasks.filter(t => t.type === 'exam' && t.deadline);
  const upcomingTasks = [...pendingTasks]
    .sort((a, b) => (a.deadline || '9999-12-31') < (b.deadline || '9999-12-31') ? -1 : 1)
    .slice(0, 3);

  // ── Stats ──────────────────────────────────────────────
  document.getElementById('stat-classes').textContent = todayClasses.length;
  document.getElementById('stat-tasks').textContent   = pendingTasks.length;
  document.getElementById('stat-exams').textContent   = exams.length;

  // ── Greeting subtitle ──────────────────────────────────
  const titleEl = document.getElementById('greeting-title');
  if (titleEl) {
    if (todayClasses.length > 0) {
      const next = todayClasses.find(c => {
        const [sh, sm] = c.start.split(':').map(Number);
        return sh * 60 + sm > nowMin;
      });
      if (next) titleEl.textContent = `Próxima aula: ${next.subjectName}`;
      else if (todayClasses.some(c => { const [sh,sm]=c.start.split(':').map(Number); const [eh,em]=c.end.split(':').map(Number); return nowMin>=sh*60+sm&&nowMin<eh*60+em; }))
        titleEl.textContent = 'Você tem uma aula agora!';
      else titleEl.textContent = 'Todas as aulas de hoje concluídas!';
    } else {
      titleEl.textContent = 'Pronto para estudar?';
    }
  }

  // ── Foco do dia ────────────────────────────────────────
  const focusEl = document.getElementById('db-focus-block');
  if (focusEl) {
    const nextCls = todayClasses.find(c => {
      const [sh, sm] = c.start.split(':').map(Number);
      return sh * 60 + sm > nowMin;
    });
    const liveCls = todayClasses.find(c => {
      const [sh,sm] = c.start.split(':').map(Number);
      const [eh,em] = c.end.split(':').map(Number);
      return nowMin >= sh*60+sm && nowMin < eh*60+em;
    });
    const targetCls = liveCls || nextCls;
    if (targetCls) {
      const [sh,sm] = targetCls.start.split(':').map(Number);
      const [eh,em] = targetCls.end.split(':').map(Number);
      const startMin = sh*60+sm, endMin = eh*60+em;
      const isLive = !!liveCls;
      const minsLeft = isLive ? endMin - nowMin : startMin - nowMin;
      const hLeft = Math.floor(minsLeft/60), mLeft = minsLeft%60;
      const timeLabel = isLive
        ? `Termina em ${hLeft>0?hLeft+'h ':''}${mLeft}min`
        : `Começa em ${hLeft>0?hLeft+'h ':''}${mLeft}min`;
      const prog = isLive ? Math.round(((nowMin-startMin)/(endMin-startMin))*100) : 0;
      focusEl.innerHTML = `
        <div class="db-focus-card" style="border-left:3px solid ${getSubjectColor(targetCls.subjectId, targetCls.subjectName, targetCls.subjectColor)}">
          <div class="db-focus-badge ${isLive?'live':'next'}">${isLive?'AO VIVO':'PRÓXIMA'}</div>
          <div class="db-focus-name">${targetCls.subjectName}</div>
          <div class="db-focus-meta">
            <span>${targetCls.start} – ${targetCls.end}</span>
            ${targetCls.room ? `<span>· ${targetCls.room}</span>` : ''}
            <span class="db-focus-time">· ${timeLabel}</span>
          </div>
          ${isLive ? `<div class="db-focus-bar"><div class="db-focus-fill" style="width:${prog}%;background:${getSubjectColor(targetCls.subjectId, targetCls.subjectName, targetCls.subjectColor)}"></div></div>` : ''}
        </div>`;
    } else {
      focusEl.innerHTML = '';
    }
  }

  // ── Progresso por matéria ──────────────────────────────
  const subjProgEl = document.getElementById('db-subject-progress');
  const overallEl  = document.getElementById('db-overall-pct');
  if (subjProgEl) {
    const total = STATE.tasks.length;
    const doneCount = doneTasks.length;
    if (overallEl) overallEl.textContent = total > 0 ? `${Math.round((doneCount/total)*100)}% geral` : '';
    if (STATE.subjects.length === 0 || total === 0) {
      subjProgEl.innerHTML = `<div class="db-empty-small">Nenhuma atividade ainda</div>`;
    } else {
      subjProgEl.innerHTML = STATE.subjects.map(s => {
        const sTasks  = STATE.tasks.filter(t => t.subjectId === s.id);
        const sDone   = sTasks.filter(t => t.done).length;
        const sPct    = sTasks.length === 0 ? 0 : Math.round((sDone / sTasks.length) * 100);
        return `
          <div class="db-subj-row">
            <span class="db-subj-dot" style="background:${s.color}"></span>
            <span class="db-subj-name">${escapeHtml(s.name)}</span>
            <div class="db-subj-bar-wrap">
              <div class="db-subj-bar-fill" style="width:${sPct}%;background:${s.color}"></div>
            </div>
            <span class="db-subj-pct">${sTasks.length === 0 ? '—' : sPct + '%'}</span>
          </div>`;
      }).join('');
    }
  }

  // ── Provas agendadas ────────────────────────────────────
  const examsEl = document.getElementById('db-exams-list');
  if (examsEl) {
    const todayD = new Date(); todayD.setHours(0,0,0,0);
    // Apenas provas futuras ou de hoje (passadas somem da lista)
    const upcoming = exams
      .filter(e => {
        const d = new Date(e.deadline + 'T00:00:00');
        return d >= todayD;
      })
      .sort((a,b) => a.deadline.localeCompare(b.deadline));

    if (upcoming.length === 0) {
      examsEl.innerHTML = `<div class="db-empty-small">Nenhuma prova agendada</div>`;
    } else {
      examsEl.innerHTML = upcoming.map(e => {
        const d = new Date(e.deadline + 'T00:00:00');
        const diff = Math.round((d - todayD) / (1000*60*60*24));

        const dateLabel = diff === 0 ? 'HOJE' : diff === 1 ? 'amanhã' :
          d.toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' })
           .replace(/\./g, '');

        // Cor baseada no número/tipo da prova
        const titleLower = (e.title || '').toLowerCase();
        const subjectColor =
          /final/i.test(titleLower)     ? '#222222' :
          /prova\s*3/i.test(titleLower) ? '#e74c3c' :
          /prova\s*2/i.test(titleLower) ? '#1e90ff' :
          /prova\s*1/i.test(titleLower) ? '#2ed573' :
          getSubjectColor(e.subjectId, e.subjectName, e.subjectColor);

        const notesLine = e.notes
          ? `<div class="exam-card-notes" style="color:${subjectColor}">${escapeHtml(e.notes)}</div>`
          : '';

        return `
          <div class="cls-card">
            <div class="cls-card-bar" style="background:${subjectColor}"></div>
            <div class="cls-card-body">
              <div class="cls-card-row">
                <span class="cls-card-name">${escapeHtml(e.title)}</span>
              </div>
              <div class="cls-card-meta">
                ${e.subjectName ? `<span class="cls-meta" style="color:${subjectColor};font-weight:600">${escapeHtml(e.subjectName)}</span>` : ''}
                <span class="cls-meta cls-meta--dim" style="margin-left:auto">${dateLabel}</span>
              </div>
              ${notesLine}
            </div>
          </div>`;
      }).join('');
    }
  }

  // ── Flashcards para revisar ────────────────────────────
  const fcEl = document.getElementById('db-flashcards-due');
  if (fcEl) {
    const todayStr = now.toISOString().slice(0,10);
    const due = STATE.flashcards.filter(c => c.nextReview <= todayStr);
    if (STATE.flashcards.length === 0) {
      fcEl.innerHTML = `<div class="db-empty-small">Nenhum flashcard criado</div>`;
    } else if (due.length === 0) {
      fcEl.innerHTML = `<div class="db-fc-ok"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M20 6L9 17l-5-5"/></svg> Em dia! ${STATE.flashcards.length} card${STATE.flashcards.length!==1?'s':''} no total</div>`;
    } else {
      const bySubj = {};
      due.forEach(c => {
        const k = c.subjectId || '__none__';
        if (!bySubj[k]) bySubj[k] = { name: c.subjectName || 'Sem matéria', color: getSubjectColor(c.subjectId, c.subjectName, c.subjectColor || 'var(--text2)'), count: 0 };
        bySubj[k].count++;
      });
      fcEl.innerHTML = `
        <div class="db-fc-summary">
          <span class="db-fc-count">${due.length}</span> card${due.length!==1?'s':''} para revisar hoje
        </div>
        <div class="db-fc-subjects">
          ${Object.values(bySubj).map(s => `
            <span class="db-fc-chip" style="background:${s.color}22;color:${s.color}">${s.count}× ${s.name}</span>
          `).join('')}
        </div>`;
    }
  }

  // ── Aulas de hoje ──────────────────────────────────────
  const classesEl = document.getElementById('today-classes');
  classesEl.innerHTML = todayClasses.length === 0 ? `
    <div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
      <p>Nenhuma aula hoje</p>
      <button onclick="navigateTo('schedule')">Adicionar aulas</button>
    </div>` : todayClasses.map(cls => renderClassCard(cls)).join('');

  // ── Próximas atividades ────────────────────────────────
  const tasksEl = document.getElementById('upcoming-tasks');
  tasksEl.innerHTML = upcomingTasks.length === 0 ? `
    <div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
      <p>Nenhuma atividade pendente</p>
      <button onclick="navigateTo('tasks')">Criar atividade</button>
    </div>` : upcomingTasks.map(t => renderTaskCard(t)).join('');
}

// ===== RENDER SCHEDULE =====
function initDayButtons() {
  renderCalendar();
}

function renderCalendar() {
  const container = document.getElementById('schedule-calendar');
  if (!container) return;

  const today      = new Date();
  const todayDow   = today.getDay();
  const todayDate  = today.getDate();
  const todayMonth = today.getMonth();
  const todayYear  = today.getFullYear();

  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - todayDow);

  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(startOfWeek);
    d.setDate(startOfWeek.getDate() + i);
    return d;
  });

  const DAY_SHORT   = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const MONTH_NAMES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                       'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

  const months     = [...new Set(weekDays.map(d => d.getMonth()))];
  const monthLabel = months.map(m => MONTH_NAMES[m]).join(' · ') + ' ' + weekDays[0].getFullYear();

  const countByDay = Array(7).fill(0);
  STATE.classes.forEach(c => { if (c.day >= 0 && c.day <= 6) countByDay[c.day]++; });

  const sel = STATE.selectedDay;

  container.innerHTML = `
    <div class="cal-wrap">
      <div class="cal-month">${monthLabel}</div>
      <div class="cal-grid">
        ${weekDays.map((d, i) => {
          const isToday = d.getDate() === todayDate && d.getMonth() === todayMonth && d.getFullYear() === todayYear;
          const isSel   = i === sel;
          const count   = countByDay[i];
          return `
            <button
              class="cal-cell ${isSel ? 'is-selected' : ''} ${isToday ? 'is-today' : ''}"
              onclick="selectCalDay(${i})"
            >
              <span class="cal-dow">${DAY_SHORT[i]}</span>
              <span class="cal-num">${d.getDate()}</span>
              <span class="cal-pip ${count > 0 ? 'has-classes' : ''}"></span>
            </button>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

window.selectCalDay = function(i) {
  STATE.selectedDay = i;
  renderCalendar();
  renderSchedule();
};

function renderSchedule() {
  const el = document.getElementById('schedule-day-classes');
  if (!el) return;

  const sel      = STATE.selectedDay;
  const now      = new Date();
  const nowMin   = now.getHours() * 60 + now.getMinutes();
  const todayDow = now.getDay();

  const dayClasses = STATE.classes
    .filter(c => c.day === sel)
    .sort((a, b) => a.start.localeCompare(b.start));

  if (dayClasses.length === 0) {
    el.innerHTML = `
      <div class="sched-empty">
        <div class="sched-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4">
            <rect x="3" y="4" width="18" height="18" rx="2.5"/>
            <path d="M16 2v4M8 2v4M3 10h18"/>
          </svg>
        </div>
        <p class="sched-empty-title">Nenhuma aula</p>
        <p class="sched-empty-sub">Importe uma foto ou adicione manualmente</p>
        <button class="sched-empty-btn" onclick="openAddClass()">+ Adicionar aula</button>
      </div>`;
    return;
  }

  const blocks = [
    { label: 'Manhã', icon: '🌅', classes: [] },
    { label: 'Tarde', icon: '☀️',  classes: [] },
    { label: 'Noite', icon: '🌙', classes: [] },
  ];
  dayClasses.forEach(cls => {
    if      (cls.start < '12:00') blocks[0].classes.push(cls);
    else if (cls.start < '18:00') blocks[1].classes.push(cls);
    else                          blocks[2].classes.push(cls);
  });

  el.innerHTML = blocks
    .filter(b => b.classes.length > 0)
    .map(b => `
      <div class="sched-block">
        <div class="sched-block-hd">
          <span>${b.icon}</span>
          <span class="sched-block-name">${b.label}</span>
          <span class="sched-block-ct">${b.classes.length} aula${b.classes.length > 1 ? 's' : ''}</span>
        </div>
        ${b.classes.map(cls => renderClassCard(cls, nowMin, sel, todayDow)).join('')}
      </div>
    `).join('');
}

function renderClassCard(cls, nowMinArg, selArg, todayArg) {
  const now      = new Date();
  const nowMin   = nowMinArg  ?? (now.getHours() * 60 + now.getMinutes());
  const sel      = selArg     ?? STATE.selectedDay;
  const todayDow = todayArg   ?? now.getDay();

  const [sh, sm] = cls.start.split(':').map(Number);
  const [eh, em] = cls.end.split(':').map(Number);
  const startMin = sh * 60 + sm;
  const endMin   = eh * 60 + em;
  const dur      = endMin - startMin;
  const durText  = dur >= 60
    ? `${Math.floor(dur / 60)}h${dur % 60 > 0 ? (dur % 60) + 'min' : ''}`
    : `${dur}min`;

  const isLive   = sel === todayDow && nowMin >= startMin && nowMin < endMin;
  const progress = isLive ? Math.round(((nowMin - startMin) / dur) * 100) : null;
  const clsColor = getSubjectColor(cls.subjectId, cls.subjectName, cls.subjectColor);

  return `
    <div class="cls-card ${isLive ? 'cls-card--live' : ''}">
      <div class="cls-card-bar" style="background:${clsColor}"></div>
      <div class="cls-card-body">
        <div class="cls-card-row">
          <span class="cls-card-name">${cls.subjectName}</span>
          ${isLive ? '<span class="cls-live-chip">AO VIVO</span>' : ''}
        </div>
        <div class="cls-card-meta">
          <span class="cls-meta">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
            ${cls.start} – ${cls.end}
          </span>
          <span class="cls-meta cls-meta--dim">${durText}</span>
          ${cls.room ? `<span class="cls-meta">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
            ${cls.room}</span>` : ''}
        </div>
        ${isLive ? `<div class="cls-progress"><div class="cls-progress-fill" style="width:${progress}%;background:${clsColor}"></div></div>` : ''}
      </div>
      <button class="cls-del-btn" onclick="deleteClass('${cls.id}')" title="Remover">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
      </button>
    </div>`;
}

window.deleteClass = async function(id) {
  STATE.classes = STATE.classes.filter(c => c.id !== id);
  await save();
  renderSchedule();
  renderDashboard();
  showToast('Aula removida');
};

// ===== RENDER TASKS =====
function renderTasks(subjectFilter = null) {
  let tasks = [...STATE.tasks];
  if (subjectFilter) {
    tasks = tasks.filter(t => t.subjectId === subjectFilter);
  } else {
    if (STATE.taskFilter === 'pending') tasks = tasks.filter(t => !t.done);
    else if (STATE.taskFilter === 'done') tasks = tasks.filter(t => t.done);
    else if (STATE.taskFilter === 'exam') tasks = tasks.filter(t => t.type === 'exam');
  }
  tasks.sort((a, b) => {
    if (!a.done && b.done) return -1;
    if (a.done && !b.done) return 1;
    return (a.deadline || '9999-12-31') < (b.deadline || '9999-12-31') ? -1 : 1;
  });
  const el = document.getElementById('tasks-list');
  if (!el) return;
  el.innerHTML = tasks.length === 0 ? `
    <div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 11l3 3L22 4"/></svg>
      <p>Nenhuma atividade</p>
      <button onclick="openAddTask()">Criar atividade</button>
    </div>` : tasks.map(t => renderTaskCard(t)).join('');
}

function renderTaskCard(task) {
  const deadlineLabel = task.deadline ? formatDeadline(task.deadline) : '';
  const typeLabels = { task: 'Atividade', exam: '📝 Prova', work: 'Trabalho', study: 'Estudo' };
  return `
    <div class="task-card ${task.done ? 'done' : ''} fade-in" id="task-${task.id}">
      <div class="task-card-top">
        <div class="task-check ${task.done ? 'checked' : ''}" onclick="toggleTask('${task.id}')">
          ${task.done ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>' : ''}
        </div>
        <div class="task-content">
          <div class="task-title" style="${task.done ? 'text-decoration:line-through;color:var(--text2)' : ''}">${escapeHtml(task.title)}</div>
          ${task.notes ? `<div style="font-size:12px;color:var(--text2);margin-top:3px">${escapeHtml(task.notes)}</div>` : ''}
          <div class="task-meta">
            ${task.subjectName ? `<span class="tag tag-subject" style="background:${getSubjectColor(task.subjectId, task.subjectName, task.subjectColor)}22;color:${getSubjectColor(task.subjectId, task.subjectName, task.subjectColor)}">${escapeHtml(task.subjectName)}</span>` : ''}
            ${task.type === 'exam' ? `<span class="tag tag-exam">${typeLabels[task.type]}</span>` : ''}
            ${deadlineLabel ? `<span class="tag ${isUrgent(task.deadline) ? 'tag-deadline' : 'tag-ok'}">${deadlineLabel}</span>` : ''}
          </div>
        </div>
        <button class="task-delete" onclick="deleteTask('${task.id}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
        </button>
      </div>
    </div>`;
}

function formatDeadline(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0,0,0,0);
  const diff = Math.round((d - today) / (1000*60*60*24));
  if (diff < 0) return `Venceu há ${Math.abs(diff)}d`;
  if (diff === 0) return 'Hoje!';
  if (diff === 1) return 'Amanhã';
  return `Em ${diff} dias`;
}

function isUrgent(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0,0,0,0);
  return Math.round((d - today) / (1000*60*60*24)) <= 2;
}

window.toggleTask = async function(id) {
  const task = STATE.tasks.find(t => t.id === id);
  if (task) {
    task.done = !task.done;
    await save();
    renderTasks();
    renderDashboard();
    showToast(task.done ? '✅ Concluída!' : 'Marcada como pendente');
  }
};

window.deleteTask = async function(id) {
  STATE.tasks = STATE.tasks.filter(t => t.id !== id);
  await save();
  renderTasks();
  renderDashboard();
  showToast('Atividade removida');
};

window.filterTasks = function(filter) {
  STATE.taskFilter = filter;
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-filter="${filter}"]`)?.classList.add('active');
  renderTasks();
};

// ===== MODAL =====
window.openModal = function(title, body) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = body;
  document.getElementById('modal-overlay').classList.add('open');
};
window.closeModal = function() {
  document.getElementById('modal-overlay').classList.remove('open');
};

// ===== TOAST =====
window.showToast = function(msg, duration = 2500) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
};

// ===== FLASHCARDS (SRS) =====
window.openAddFlashcard = function() {
  const subOptions = STATE.subjects.map(s =>
    `<option value="${s.id}">${s.name}</option>`
  ).join('');
  openModal('Novo Flashcard', `
    <div class="form-group">
      <label class="form-label">Matéria</label>
      <select id="fc-subject" class="form-select">
        <option value="">Sem matéria</option>
        ${subOptions}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Frente (Pergunta)</label>
      <textarea id="fc-front" class="form-textarea" placeholder="Ex: O que é fotossíntese?" rows="3"></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Verso (Resposta)</label>
      <textarea id="fc-back" class="form-textarea" placeholder="Ex: Processo pelo qual plantas convertem luz em energia..." rows="3"></textarea>
    </div>
    <button class="btn-primary" onclick="saveFlashcard()">Salvar Flashcard</button>
  `);
};

window.saveFlashcard = async function() {
  const front = document.getElementById('fc-front')?.value?.trim();
  const back = document.getElementById('fc-back')?.value?.trim();
  if (!front || !back) { showToast('Preencha frente e verso'); return; }
  const subjectId = document.getElementById('fc-subject')?.value;
  const subject = STATE.subjects.find(s => s.id === subjectId);
  
  STATE.flashcards.push({
    id: Date.now().toString(),
    front, back,
    subjectId: subjectId || null,
    subjectName: subject?.name || null,
    subjectColor: subject?.color || null,
    interval: 1,       // days until next review
    easeFactor: 2.5,   // SM-2 ease factor
    nextReview: toLocalISODate(),
    repetitions: 0,
    createdAt: new Date().toISOString(),
  });
  
  await save();
  renderFlashcards();
  closeModal();
  showToast('✅ Flashcard criado!');
};

// Paleta de cores para sticky notes (varia por índice)
const FC_NOTE_COLORS = [
  { bg: '#fef08a', text: '#713f12', fold: '#eab308' }, // amarelo
  { bg: '#86efac', text: '#14532d', fold: '#22c55e' }, // verde
  { bg: '#93c5fd', text: '#1e3a5f', fold: '#3b82f6' }, // azul
  { bg: '#fca5a5', text: '#7f1d1d', fold: '#ef4444' }, // vermelho
  { bg: '#f9a8d4', text: '#831843', fold: '#ec4899' }, // rosa
  { bg: '#c4b5fd', text: '#3b0764', fold: '#8b5cf6' }, // roxo
  { bg: '#fdba74', text: '#7c2d12', fold: '#f97316' }, // laranja
  { bg: '#67e8f9', text: '#164e63', fold: '#06b6d4' }, // ciano
];

function renderFlashcards() {
  const el = document.getElementById('flashcards-list');
  if (!el) return;

  const today = toLocalISODate();
  let cards = [...STATE.flashcards];
  if (STATE.flashcardFilter === 'due') {
    cards = cards.filter(c => c.nextReview <= today);
  } else if (STATE.flashcardFilter !== 'all') {
    cards = cards.filter(c => c.subjectId === STATE.flashcardFilter);
  }

  const dueCount = STATE.flashcards.filter(c => c.nextReview <= today).length;
  const dueEl = document.getElementById('fc-due-count');
  if (dueEl) dueEl.textContent = dueCount > 0 ? `${dueCount} para revisar hoje` : 'Em dia! ✓';

  if (cards.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M8 12h8M8 8h5"/></svg>
        <p>Nenhum flashcard${STATE.flashcardFilter !== 'all' ? ' neste filtro' : ''}</p>
        <button onclick="openAddFlashcard()">Criar flashcard</button>
      </div>`;
    return;
  }

  // Determina índice estável de cor por id do card
  const colorIdx = (id) => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
    return h % FC_NOTE_COLORS.length;
  };

  el.innerHTML = cards.map(c => {
    const isDue = c.nextReview <= today;
    const col = FC_NOTE_COLORS[colorIdx(c.id)];
    // se tem cor de matéria, tinta levemente com ela na aba superior
    const subCol = c.subjectId ? getSubjectColor(c.subjectId, c.subjectName, c.subjectColor) : col.fold;

    return `
    <div class="sn-card ${isDue ? 'sn-due' : ''}" id="fc-${c.id}"
         style="--sn-bg:${col.bg};--sn-text:${col.text};--sn-fold:${col.fold};--sn-sub:${subCol}">

      <!-- topo com matéria + pin -->
      <div class="sn-top">
        <span class="sn-subject">${c.subjectName ? escapeHtml(c.subjectName) : '&nbsp;'}</span>
        <div style="display:flex;gap:4px;align-items:center">
          ${isDue ? '<span class="sn-due-dot" title="Para revisar hoje">●</span>' : ''}
          <button class="sn-del-btn" onclick="deleteFlashcard('${c.id}')" title="Excluir">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="13" height="13"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>

      <!-- corpo clicável (vira o card) -->
      <div class="sn-body" onclick="flipCard('${c.id}')">
        <div class="sn-front" id="sn-front-${c.id}">
          <p class="sn-text">${escapeHtml(c.front)}</p>
          <span class="sn-hint">toque para revelar ↓</span>
        </div>
        <div class="sn-back" id="sn-back-${c.id}" style="display:none">
          <p class="sn-text sn-answer">${escapeHtml(c.back)}</p>
          <div class="sn-rating" onclick="event.stopPropagation()">
            <span class="sn-rating-label">Como foi?</span>
            <div class="sn-rating-btns">
              <button class="sn-rbtn sn-fail" onclick="rateCard(event,'${c.id}',1)">😣 Errei</button>
              <button class="sn-rbtn sn-hard" onclick="rateCard(event,'${c.id}',3)">😅 Difícil</button>
              <button class="sn-rbtn sn-ok"   onclick="rateCard(event,'${c.id}',4)">😊 Bom</button>
              <button class="sn-rbtn sn-easy" onclick="rateCard(event,'${c.id}',5)">🤩 Fácil</button>
            </div>
          </div>
        </div>
      </div>

      <!-- dobra no canto inferior direito -->
      <div class="sn-fold"></div>
    </div>`;
  }).join('');
}

window.flipCard = function(id) {
  const front = document.getElementById(`sn-front-${id}`);
  const back  = document.getElementById(`sn-back-${id}`);
  if (!front || !back) return;
  const isFlipped = back.style.display !== 'none';
  front.style.display = isFlipped ? 'flex' : 'none';
  back.style.display  = isFlipped ? 'none' : 'flex';
};

window.rateCard = async function(evt, id, quality) {
  evt.stopPropagation();
  const card = STATE.flashcards.find(c => c.id === id);
  if (!card) return;

  // SM-2 algorithm
  const q = quality; // 1-5
  if (q >= 3) {
    if (card.repetitions === 0) card.interval = 1;
    else if (card.repetitions === 1) card.interval = 6;
    else card.interval = Math.round(card.interval * card.easeFactor);
    card.repetitions++;
  } else {
    card.repetitions = 0;
    card.interval = 1;
  }
  card.easeFactor = Math.max(1.3, card.easeFactor + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  const next = new Date();
  next.setDate(next.getDate() + card.interval);
  card.nextReview = toLocalISODate(next);

  await save();
  renderFlashcards();
  showToast(q >= 4 ? '🎉 Ótimo!' : q === 3 ? '👍 Marcado para revisão' : '🔁 Repetindo em breve');
};

window.deleteFlashcard = async function(id) {
  STATE.flashcards = STATE.flashcards.filter(c => c.id !== id);
  await save();
  renderFlashcards();
  showToast('Flashcard removido');
};

window.filterFlashcards = function(filter) {
  STATE.flashcardFilter = filter;
  document.querySelectorAll('.fc-filter-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-fcfilter="${filter}"]`)?.classList.add('active');
  renderFlashcards();
};

// ===== FLASHCARDS SOCIAL =====
import {
  collection, addDoc, getDocs, query, orderBy, limit,
  where, serverTimestamp, updateDoc, arrayUnion, arrayRemove,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

let _fcCurrentTab = 'personal';

window.switchFcTab = function(tab) {
  _fcCurrentTab = tab;
  document.querySelectorAll('.fctab').forEach(b => b.classList.toggle('active', b.dataset.fctab === tab));
  document.querySelectorAll('.fc-panel').forEach(p => p.classList.remove('fc-panel--active'));
  document.getElementById(`fc-panel-${tab}`)?.classList.add('fc-panel--active');

  if (tab === 'feed') loadFeedCards();
  if (tab === 'inbox') loadInbox();
};

// ── Feed Global ──────────────────────────────────────────────────────────────
window.loadFeedCards = async function() {
  const el = document.getElementById('fc-feed-list');
  if (!el) return;
  el.innerHTML = `<div class="fc-feed-loading">Carregando...</div>`;
  try {
    const q = query(collection(db, 'fc_feed'), orderBy('createdAt', 'desc'), limit(40));
    const snap = await getDocs(q);
    if (snap.empty) {
      el.innerHTML = `<div class="fc-feed-empty">Nenhum card publicado ainda. Seja o primeiro! 🚀</div>`;
      return;
    }
    const uid = auth.currentUser?.uid;
    el.innerHTML = snap.docs.map(d => {
      const c = d.data();
      const col = FC_NOTE_COLORS[Math.abs(d.id.split('').reduce((a,ch)=>a*31+ch.charCodeAt(0),0)) % FC_NOTE_COLORS.length];
      const likes = (c.likes || []).length;
      const liked = uid && (c.likes||[]).includes(uid);
      const isOwn = uid && c.authorId === uid;
      const date  = c.createdAt?.toDate?.()?.toLocaleDateString('pt-BR',{day:'2-digit',month:'short'}) || '';
      const authorName = escapeHtml(c.authorName || 'Anônimo');
      const avatarLetter = (c.authorName || 'A')[0].toUpperCase();
      return `
      <div class="sn-card" style="--sn-bg:${col.bg};--sn-text:${col.text};--sn-fold:${col.fold};--sn-sub:${col.fold}">
        <div class="sn-top" style="display:flex;align-items:center;gap:7px;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:6px;min-width:0">
            <div class="fc-author-avatar">${avatarLetter}</div>
            <span class="fc-author-name">${authorName}${isOwn ? ' <span class="fc-own-badge">você</span>' : ''}</span>
          </div>
          <span style="font-size:10px;color:rgba(255,255,255,0.6);white-space:nowrap;flex-shrink:0">${date}</span>
        </div>
        <div class="sn-body" onclick="flipFeedCard('${d.id}')">
          <div class="sn-front" id="fdf-${d.id}">
            ${c.subject ? `<span style="font-size:10px;font-weight:800;opacity:0.6;text-transform:uppercase;letter-spacing:.05em">${escapeHtml(c.subject)}</span>` : ''}
            <p class="sn-text">${escapeHtml(c.front)}</p>
            <span class="sn-hint">toque para revelar ↓</span>
          </div>
          <div class="sn-back" id="fdb-${d.id}" style="display:none">
            <p class="sn-text sn-answer">${escapeHtml(c.back)}</p>
            <div class="fc-feed-actions" onclick="event.stopPropagation()">
              <button class="fc-like-btn ${liked?'fc-liked':''}" onclick="toggleLike('${d.id}',${liked})">
                ${liked?'❤️':'🤍'} ${likes}
              </button>
              ${!isOwn ? `<button class="fc-save-btn" onclick="saveFeedCard('${d.id}')">📥 Salvar</button>` : ''}
              ${isOwn  ? `<button class="fc-del-feed-btn" onclick="deleteFeedCard('${d.id}')">🗑️</button>` : ''}
            </div>
          </div>
        </div>
        <div class="sn-fold"></div>
      </div>`;
    }).join('');
  } catch(e) {
    console.error(e);
    el.innerHTML = `<div class="fc-feed-empty">Erro ao carregar feed.</div>`;
  }
};

window.flipFeedCard = function(id) {
  const f = document.getElementById(`fdf-${id}`);
  const b = document.getElementById(`fdb-${id}`);
  if (!f||!b) return;
  const flipped = b.style.display !== 'none';
  f.style.display = flipped ? 'flex' : 'none';
  b.style.display = flipped ? 'none' : 'flex';
};

window.toggleLike = async function(docId, currentlyLiked) {
  const uid = auth.currentUser?.uid;
  if (!uid) { showToast('Faça login para curtir'); return; }
  try {
    const ref = doc(db, 'fc_feed', docId);
    await updateDoc(ref, { likes: currentlyLiked ? arrayRemove(uid) : arrayUnion(uid) });
    loadFeedCards();
  } catch(e) { showToast('Erro ao curtir'); }
};

window.saveFeedCard = async function(docId) {
  try {
    const snap = await getDocs(query(collection(db,'fc_feed'), where('__name__','==',docId)));
    if (snap.empty) return;
    const c = snap.docs[0].data();
    STATE.flashcards.push({
      id: Date.now().toString(), front: c.front, back: c.back,
      subjectId: null, subjectName: c.subject || null, subjectColor: null,
      interval: 1, easeFactor: 2.5, nextReview: toLocalISODate(),
      repetitions: 0, createdAt: new Date().toISOString(), fromFeed: docId,
    });
    await save();
    showToast('📥 Card salvo nos seus flashcards!');
  } catch(e) { showToast('Erro ao salvar card'); }
};

window.deleteFeedCard = async function(docId) {
  if (!confirm('Remover do feed?')) return;
  try {
    const { deleteDoc } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    await deleteDoc(doc(db,'fc_feed',docId));
    showToast('Card removido do feed');
    loadFeedCards();
  } catch(e) { showToast('Erro ao remover'); }
};

window.openPublishCard = function() {
  openModal('Publicar no Feed Global', `
    <div class="form-group">
      <label class="form-label">Assunto / Matéria</label>
      <input id="pub-subject" class="form-input" placeholder="Ex: Fotossíntese, Derivadas..." maxlength="40">
    </div>
    <div class="form-group">
      <label class="form-label">Pergunta (frente)</label>
      <textarea id="pub-front" class="form-textarea" rows="3" placeholder="O que é...?"></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Resposta (verso)</label>
      <textarea id="pub-back" class="form-textarea" rows="3" placeholder="Resposta..."></textarea>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn-primary" onclick="publishCard()">🌐 Publicar</button>
      <button class="btn-secondary" onclick="closeModal()">Cancelar</button>
    </div>
  `);
};

window.publishCard = async function() {
  const front   = document.getElementById('pub-front')?.value?.trim();
  const back    = document.getElementById('pub-back')?.value?.trim();
  const subject = document.getElementById('pub-subject')?.value?.trim();
  if (!front || !back) { showToast('Preencha pergunta e resposta'); return; }
  const user = auth.currentUser;
  if (!user) { showToast('Faça login primeiro'); return; }
  try {
    await addDoc(collection(db,'fc_feed'), {
      front, back, subject: subject || '',
      authorId: user.uid,
      authorName: user.displayName || user.email?.split('@')[0] || 'Anônimo',
      likes: [],
      createdAt: serverTimestamp(),
    });
    closeModal();
    showToast('🌐 Card publicado no feed!');
    switchFcTab('feed');
  } catch(e) { showToast('Erro ao publicar'); }
};

// ── Trocas (envio/recebimento) ───────────────────────────────────────────────
window.switchInboxTab = function(tab) {
  document.querySelectorAll('.fc-itab').forEach(b => b.classList.toggle('active', b.dataset.itab === tab));
  document.getElementById('fc-inbox-received').style.display = tab === 'received' ? '' : 'none';
  document.getElementById('fc-inbox-sent').style.display     = tab === 'sent'     ? '' : 'none';
};

window.loadInbox = async function() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  try {
    const [recvSnap, sentSnap] = await Promise.all([
      getDocs(query(collection(db,'fc_inbox'), where('toId','==',uid), orderBy('createdAt','desc'), limit(30))),
      getDocs(query(collection(db,'fc_inbox'), where('fromId','==',uid), orderBy('createdAt','desc'), limit(30))),
    ]);

    // badge
    const unread = recvSnap.docs.filter(d => !d.data().read).length;
    const badge = document.getElementById('inbox-badge');
    if (badge) { badge.textContent = unread; badge.style.display = unread ? 'inline-flex' : 'none'; }

    const renderInboxCards = (docs, isSent) => {
      if (docs.length === 0) return `<div class="fc-feed-empty">${isSent ? 'Nenhum card enviado.' : 'Nenhum card recebido.'}</div>`;
      return `<div class="flashcards-list">${docs.map(d => {
        const c = d.data();
        const col = FC_NOTE_COLORS[Math.abs(d.id.split('').reduce((a,ch)=>a*31+ch.charCodeAt(0),0)) % FC_NOTE_COLORS.length];
        const date = c.createdAt?.toDate?.()?.toLocaleDateString('pt-BR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) || '';
        return `
        <div class="sn-card ${!c.read && !isSent ? 'sn-unread' : ''}" style="--sn-bg:${col.bg};--sn-text:${col.text};--sn-fold:${col.fold};--sn-sub:${col.fold}">
          <div class="sn-top">
            <span class="sn-subject">${isSent ? '→ '+escapeHtml(c.toName||'') : '← '+escapeHtml(c.fromName||'')}</span>
            <span style="font-size:10px;color:rgba(255,255,255,0.7)">${date}</span>
          </div>
          <div class="sn-body" onclick="flipFeedCard('ib-${d.id}')">
            <div class="sn-front" id="fdf-ib-${d.id}">
              ${c.subject ? `<span style="font-size:10px;font-weight:800;opacity:0.6;text-transform:uppercase">${escapeHtml(c.subject)}</span>` : ''}
              <p class="sn-text">${escapeHtml(c.front)}</p>
              <span class="sn-hint">toque para revelar ↓</span>
            </div>
            <div class="sn-back" id="fdb-ib-${d.id}" style="display:none">
              <p class="sn-text sn-answer">${escapeHtml(c.back)}</p>
              <div class="fc-feed-actions" onclick="event.stopPropagation()">
                ${!isSent ? `<button class="fc-save-btn" onclick="saveInboxCard('${d.id}')">📥 Salvar</button>` : ''}
              </div>
            </div>
          </div>
          <div class="sn-fold"></div>
        </div>`;
      }).join('')}</div>`;
    };

    document.getElementById('fc-inbox-received').innerHTML = renderInboxCards(recvSnap.docs, false);
    document.getElementById('fc-inbox-sent').innerHTML     = renderInboxCards(sentSnap.docs, true);

    // Marcar como lidos
    for (const d of recvSnap.docs) {
      if (!d.data().read) updateDoc(doc(db,'fc_inbox',d.id), { read: true }).catch(()=>{});
    }
  } catch(e) { console.error(e); }
};

window.saveInboxCard = async function(docId) {
  try {
    const snap = await getDocs(query(collection(db,'fc_inbox'), where('__name__','==',docId)));
    if (snap.empty) return;
    const c = snap.docs[0].data();
    STATE.flashcards.push({
      id: Date.now().toString(), front: c.front, back: c.back,
      subjectId: null, subjectName: c.subject || null, subjectColor: null,
      interval:1, easeFactor:2.5, nextReview: toLocalISODate(),
      repetitions:0, createdAt: new Date().toISOString(),
    });
    await save();
    showToast('📥 Card salvo!');
  } catch(e) { showToast('Erro ao salvar'); }
};

window.openSendCard = function() {
  const myCards = STATE.flashcards;
  const cardOpts = myCards.length
    ? myCards.map(c => `<option value="${c.id}">${escapeHtml(c.front.slice(0,50))}</option>`).join('')
    : '<option disabled>Nenhum card pessoal</option>';
  openModal('Enviar Card para Alguém', `
    <div class="form-group">
      <label class="form-label">E-mail do destinatário</label>
      <input id="send-email" class="form-input" type="email" placeholder="amigo@email.com">
    </div>
    <div class="form-group">
      <label class="form-label">Ou criar novo card para enviar</label>
    </div>
    <div class="form-group">
      <label class="form-label">Assunto</label>
      <input id="send-subject" class="form-input" placeholder="Matéria / tema" maxlength="40">
    </div>
    <div class="form-group">
      <label class="form-label">Pergunta</label>
      <textarea id="send-front" class="form-textarea" rows="2" placeholder="Frente do card..."></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Resposta</label>
      <textarea id="send-back" class="form-textarea" rows="2" placeholder="Verso do card..."></textarea>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn-primary" onclick="sendCard()">📤 Enviar</button>
      <button class="btn-secondary" onclick="closeModal()">Cancelar</button>
    </div>
  `);
};

window.sendCard = async function() {
  const email   = document.getElementById('send-email')?.value?.trim();
  const front   = document.getElementById('send-front')?.value?.trim();
  const back    = document.getElementById('send-back')?.value?.trim();
  const subject = document.getElementById('send-subject')?.value?.trim();
  if (!email) { showToast('Digite o e-mail do destinatário'); return; }
  if (!front || !back) { showToast('Preencha pergunta e resposta'); return; }
  const user = auth.currentUser;
  if (!user) { showToast('Faça login primeiro'); return; }

  try {
    // Busca uid do destinatário pelo e-mail via coleção pública de usuários
    const toSnap = await getDocs(query(collection(db,'user_profiles'), where('email','==',email), limit(1)));
    if (toSnap.empty) { showToast('Usuário não encontrado. Ele precisa ter uma conta.'); return; }
    const toUser = toSnap.docs[0].data();

    await addDoc(collection(db,'fc_inbox'), {
      front, back, subject: subject || '',
      fromId: user.uid,
      fromName: user.displayName || user.email?.split('@')[0] || 'Anônimo',
      toId: toUser.uid,
      toName: toUser.displayName || email,
      read: false,
      createdAt: serverTimestamp(),
    });
    closeModal();
    showToast('📤 Card enviado!');
  } catch(e) { console.error(e); showToast('Erro ao enviar card'); }
};

// ===== MATERIAIS (por matéria, com pasta local) =====

// Guarda handles de pastas por subjectId: { [subjectId]: FileSystemDirectoryHandle }
const _matFolders = {};
// Guarda arquivos listados por subjectId: { [subjectId]: FileSystemFileHandle[] }
const _matFiles = {};

function renderLinks() {
  const el = document.getElementById('links-list');
  if (!el) return;

  if (STATE.subjects.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
        <p>Adicione matérias para organizar seus materiais</p>
        <button onclick="openAddSubject()">Adicionar matéria</button>
      </div>`;
    return;
  }

  const hasFSA = 'showDirectoryPicker' in window;

  el.innerHTML = STATE.subjects.map((s, i) => {
    const links = s.links || [];
    const isOpen = i === 0; // primeira aberta por padrão
    return `
    <div class="mat-block" id="mat-block-${s.id}">
      <div class="mat-header" onclick="toggleMatBlock('${s.id}')">
        <div class="mat-header-left">
          <span class="mat-dot" style="background:${s.color}"></span>
          <span class="mat-name">${escapeHtml(s.name)}</span>
        </div>
        <div class="mat-header-right">
          <button class="mat-icon-btn" title="Editar links" onclick="event.stopPropagation();openEditSubjectLinks('${s.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <svg class="mat-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>

      <div class="mat-body ${isOpen ? 'mat-body--open' : ''}" id="mat-body-${s.id}">

        <!-- LINKS -->
        <div class="mat-section">
          <div class="mat-section-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
            Links úteis
          </div>
          <div class="mat-links-grid">
            ${links.length === 0
              ? `<span class="mat-empty-hint">Nenhum link — clique em ✏️ para adicionar</span>`
              : links.map(link => {
                  const domain = (() => { try { return new URL(link).hostname.replace('www.',''); } catch { return String(link); } })();
                  const icon = domain.includes('youtube') ? '▶️' : domain.includes('drive.google') ? '📁' : domain.includes('notion') ? '📝' : domain.includes('github') ? '💻' : '🔗';
                  const safeHref = isHttpUrl(link) ? link : '#';
                  return `<a class="mat-link-chip" href="${safeHref}" target="_blank" rel="noopener">
                    <span>${icon}</span>
                    <span class="mat-link-domain">${escapeHtml(domain)}</span>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </a>`;
                }).join('')
            }
          </div>
        </div>

        <!-- ARQUIVOS LOCAIS -->
        <div class="mat-section">
          <div class="mat-section-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
            Pasta de arquivos
          </div>
          ${hasFSA ? `
          <div class="mat-folder-zone" id="mat-folder-${s.id}">
            <div class="mat-folder-empty" id="mat-folder-empty-${s.id}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="28" height="28"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
              <span>Nenhuma pasta vinculada</span>
              <button class="mat-btn-folder" onclick="matOpenFolder('${s.id}')">
                📂 Vincular pasta local
              </button>
            </div>
            <div class="mat-folder-content" id="mat-folder-content-${s.id}" style="display:none">
              <div class="mat-folder-toolbar">
                <span class="mat-folder-path" id="mat-folder-path-${s.id}"></span>
                <div style="display:flex;gap:6px">
                  <button class="mat-btn-sm" onclick="matRefresh('${s.id}')">↻ Atualizar</button>
                  <button class="mat-btn-sm" onclick="matOpenFolder('${s.id}')">📂 Trocar pasta</button>
                </div>
              </div>
              <div class="mat-files-grid" id="mat-files-${s.id}"></div>
            </div>
          </div>
          ` : `<p class="mat-empty-hint">Seu navegador não suporta acesso a pastas locais. Use Chrome ou Edge.</p>`}
        </div>

      </div>
    </div>`;
  }).join('');
}

window.toggleMatBlock = function(id) {
  const body = document.getElementById(`mat-body-${id}`);
  if (!body) return;
  body.classList.toggle('mat-body--open');
  const chevron = document.querySelector(`#mat-block-${id} .mat-chevron`);
  if (chevron) chevron.style.transform = body.classList.contains('mat-body--open') ? 'rotate(180deg)' : '';
};

window.matOpenFolder = async function(subjectId) {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    _matFolders[subjectId] = handle;
    await matRefresh(subjectId);
  } catch (e) {
    if (e.name !== 'AbortError') showToast('Erro ao abrir pasta');
  }
};

window.matRefresh = async function(subjectId) {
  const handle = _matFolders[subjectId];
  if (!handle) return;

  const emptyEl   = document.getElementById(`mat-folder-empty-${subjectId}`);
  const contentEl = document.getElementById(`mat-folder-content-${subjectId}`);
  const pathEl    = document.getElementById(`mat-folder-path-${subjectId}`);
  const gridEl    = document.getElementById(`mat-files-${subjectId}`);
  if (!contentEl || !gridEl) return;

  emptyEl.style.display   = 'none';
  contentEl.style.display = 'block';
  if (pathEl) pathEl.textContent = `📂 ${handle.name}`;

  const files = [];
  try {
    for await (const entry of handle.values()) {
      if (entry.kind === 'file') files.push(entry);
    }
  } catch { showToast('Sem permissão para ler a pasta'); return; }

  _matFiles[subjectId] = files;

  if (files.length === 0) {
    gridEl.innerHTML = `<span class="mat-empty-hint">Pasta vazia</span>`;
    return;
  }

  const imgExts = ['jpg','jpeg','png','gif','webp','svg','bmp'];
  const docExts = ['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','md'];

  gridEl.innerHTML = files.map((f, idx) => {
    const ext = f.name.split('.').pop().toLowerCase();
    const isImg = imgExts.includes(ext);
    const isDoc = docExts.includes(ext);
    const icon = isImg ? '🖼️' : isDoc ? (ext === 'pdf' ? '📄' : ext.includes('xls') ? '📊' : ext.includes('ppt') ? '📑' : '📝') : '📎';
    return `
      <div class="mat-file-card" onclick="matOpenFile('${subjectId}',${idx})" title="${escapeHtml(f.name)}">
        <div class="mat-file-thumb" id="mat-thumb-${subjectId}-${idx}">
          <span class="mat-file-icon">${icon}</span>
        </div>
        <span class="mat-file-name">${escapeHtml(f.name)}</span>
      </div>`;
  }).join('');

  // Carrega previews de imagens de forma assíncrona
  for (let idx = 0; idx < files.length; idx++) {
    const ext = files[idx].name.split('.').pop().toLowerCase();
    if (!imgExts.includes(ext)) continue;
    try {
      const file = await files[idx].getFile();
      const url  = URL.createObjectURL(file);
      const thumb = document.getElementById(`mat-thumb-${subjectId}-${idx}`);
      if (thumb) thumb.innerHTML = `<img src="${url}" alt="${escapeHtml(files[idx].name)}" style="width:100%;height:100%;object-fit:cover;border-radius:8px">`;
    } catch {}
  }
};

window.matOpenFile = async function(subjectId, idx) {
  const files = _matFiles[subjectId];
  if (!files || !files[idx]) return;
  try {
    const file = await files[idx].getFile();
    const url  = URL.createObjectURL(file);
    window.open(url, '_blank');
  } catch { showToast('Não foi possível abrir o arquivo'); }
};

window.openEditSubjectLinks = function(id) {
  const subject = STATE.subjects.find(s => s.id === id);
  if (!subject) return;
  openModal(`Links — ${subject.name}`, `
    <div class="form-group">
      <label class="form-label">Links Úteis (um por linha)</label>
      <textarea id="edit-links" class="form-textarea" rows="5" placeholder="https://drive.google.com/...&#10;https://youtube.com/...">${(subject.links || []).join('\n')}</textarea>
    </div>
    <button class="btn-primary" onclick="saveSubjectLinks('${id}')">Salvar Links</button>
  `);
};

window.saveSubjectLinks = async function(id) {
  const subject = STATE.subjects.find(s => s.id === id);
  if (!subject) return;
  const raw = document.getElementById('edit-links')?.value || '';
  subject.links = raw
    .split('\n')
    .map(l => l.trim())
    .filter(isHttpUrl);
  await save();
  closeModal();
  renderLinks();
  showToast('✅ Links salvos!');
};

// ===== PUSH NOTIFICATIONS =====
window.requestNotificationPermission = async function() {
  if (!('Notification' in window)) { showToast('Notificações não suportadas'); return; }
  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    showToast('🔔 Notificações ativadas!');
    scheduleDueNotifications();
  } else {
    showToast('Permissão negada');
  }
};

function scheduleDueNotifications() {
  if (Notification.permission !== 'granted') return;
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = toLocalISODate(tomorrow);
  const todayStr = toLocalISODate();

  const due = STATE.tasks.filter(t => !t.done && (t.deadline === todayStr || t.deadline === tomorrowStr));
  due.forEach(task => {
    const label = task.deadline === todayStr ? 'hoje' : 'amanhã';
    new Notification(`⏰ ${task.title}`, {
      body: `Vence ${label}${task.subjectName ? ' · ' + task.subjectName : ''}`,
      icon: '/icons/icon-192.png',
      tag: `task-${task.id}`,
    });
  });
}

// Auto-schedule on load (if already granted)
window.addEventListener('DOMContentLoaded', () => {
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    setTimeout(scheduleDueNotifications, 3000);
  }
});

// ===== SERVICE WORKER =====
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.warn('SW registration failed:', err);
    });
  });
}
// ===== PWA INSTALL BANNER =====
let deferredInstallPrompt = null;
const INSTALL_DISMISSED_KEY = 'studyflow_install_dismissed';

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;

  // Não mostra se o usuário já dispensou antes
  if (!localStorage.getItem(INSTALL_DISMISSED_KEY)) {
    showInstallBanner();
  }
});

// Esconde o banner se o app já foi instalado
window.addEventListener('appinstalled', () => {
  hideInstallBanner();
  deferredInstallPrompt = null;
  showToast('✅ StudyFlow instalado com sucesso!');
});

function showInstallBanner() {
  const banner = document.getElementById('install-banner');
  if (banner) banner.style.display = 'block';
}

function hideInstallBanner() {
  const banner = document.getElementById('install-banner');
  if (banner) banner.style.display = 'none';
}

window.triggerInstall = async function() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  if (outcome === 'accepted') {
    deferredInstallPrompt = null;
    hideInstallBanner();
  }
};

window.dismissInstallBanner = function() {
  hideInstallBanner();
  // Lembra que o usuário dispensou (por 7 dias)
  const expiry = Date.now() + 7 * 24 * 60 * 60 * 1000;
  localStorage.setItem(INSTALL_DISMISSED_KEY, String(expiry));
};

// Verifica se o dismissal expirou (após 7 dias mostra de novo)
(function checkDismissalExpiry() {
  const expiry = parseInt(localStorage.getItem(INSTALL_DISMISSED_KEY) || '0');
  if (expiry && Date.now() > expiry) {
    localStorage.removeItem(INSTALL_DISMISSED_KEY);
  }
})();
// ── Tema ─────────────────────────────────────────────────────────────────────
const THEME_KEY = 'sf_theme';

window.setTheme = function(theme) {
  if (theme === 'default') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  localStorage.setItem(THEME_KEY, theme);
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
};

// Aplica o tema salvo ao carregar
(function applyStoredTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'default';
  if (saved !== 'default') {
    document.documentElement.setAttribute('data-theme', saved);
  }
  // Marca o botão ativo assim que o DOM estiver pronto
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.querySelector(`.theme-btn[data-theme="${saved}"]`);
    if (btn) btn.classList.add('active');
  });
})();
// ===== ACCOUNT SETTINGS PANEL =====
window.openAccountSettings = function() {
  const user = STATE.currentUser;
  if (!user) return;
  const name = user.displayName || user.email?.split('@')[0] || 'Usuário';
  const initials = name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0,2);

  // Update header info
  const avatarEl = document.getElementById('accs-avatar');
  if (avatarEl) {
    if (user.photoURL) {
      avatarEl.innerHTML = `<img src="${user.photoURL}" alt="avatar">`;
    } else {
      avatarEl.textContent = initials;
    }
  }
  const dn = document.getElementById('accs-display-name');
  if (dn) dn.textContent = name;
  const em = document.getElementById('accs-email-display');
  if (em) em.textContent = user.email || '';
  const ut = document.getElementById('accs-username-tag');
  if (ut) ut.textContent = '@' + name.toLowerCase().replace(/\s+/g, '').slice(0,16);

  document.getElementById('account-settings-overlay').classList.add('active');
  document.getElementById('account-settings-panel').classList.add('open');
};

window.closeAccountSettings = function() {
  document.getElementById('account-settings-overlay').classList.remove('active');
  document.getElementById('account-settings-panel').classList.remove('open');
  closeAccsSection();
};

window.openAccsSection = function(section) {
  const titles = {
    account: 'Conta',
    privacy: 'Privacidade e Segurança',
    notifications: 'Notificações',
    data: 'Dados e Armazenamento',
    appearance: 'Aparência',
    academic: 'Perfil Acadêmico',        // NOVO
  };
  const user = STATE.currentUser;
  const name = user?.displayName || user?.email?.split('@')[0] || 'Usuário';

  document.getElementById('accs-sub-title').textContent = titles[section] || section;

  // ===== NOVO: Perfil Acadêmico =====
  if (section === 'academic') {
    document.getElementById('accs-sub-panel').classList.add('open');
    import('./social/profile.js').then(({ renderAcademicProfileSection }) => {
      renderAcademicProfileSection(user?.uid);
    });
    return;
  }
  // ===================================

  let body = '';

  if (section === 'account') {
    body = `
      <div class="accs-field">
        <label>Nome de Exibição</label>
        <input id="accs-inp-name" type="text" value="${escapeHtml(name)}" placeholder="Seu nome">
      </div>
      <div class="accs-field">
        <label>E-mail</label>
        <input type="text" value="${escapeHtml(user?.email || '')}" disabled style="opacity:0.6;cursor:not-allowed">
      </div>
      <div class="accs-field">
        <label>Bio / Sobre mim</label>
        <textarea id="accs-inp-bio" placeholder="Conte um pouco sobre você...">${escapeHtml(localStorage.getItem('accs_bio') || '')}</textarea>
      </div>
      <button class="accs-save-btn" onclick="saveAccsAccount()">Salvar Alterações</button>
    `;
  } else if (section === 'privacy') {
    body = `
      <div class="accs-section-card">
        <div class="accs-info-row"><span>E-mail verificado</span><span>${user?.emailVerified ? '✅ Sim' : '⚠️ Não'}</span></div>
        <div class="accs-info-row"><span>UID da Conta</span><span style="font-size:11px;word-break:break-all">${user?.uid || '-'}</span></div>
        <div class="accs-info-row"><span>Provedor</span><span>${user?.providerData?.[0]?.providerId || 'email'}</span></div>
      </div>
      <div class="accs-field" style="margin-top:8px">
        <label>Nova Senha</label>
        <input id="accs-inp-pass" type="password" placeholder="Nova senha (mín. 6 caracteres)">
      </div>
      <button class="accs-save-btn" onclick="saveAccsPassword()">Alterar Senha</button>
      <button class="accs-danger-btn" onclick="confirmDeleteAccount()">Excluir Conta</button>
    `;
  } else if (section === 'notifications') {
    const notifOn = localStorage.getItem('accs_notif') !== 'off';
    body = `
      <div class="accs-section-card">
        <div class="accs-toggle-row">
          <span>Notificações de Tarefas</span>
          <div class="accs-toggle ${notifOn ? 'on' : ''}" id="accs-toggle-notif" onclick="toggleAccsNotif()"></div>
        </div>
        <div class="accs-toggle-row">
          <span>Alertas de Vencimento</span>
          <div class="accs-toggle on" id="accs-toggle-deadline" onclick="this.classList.toggle('on')"></div>
        </div>
        <div class="accs-toggle-row">
          <span>Som de Notificação</span>
          <div class="accs-toggle" id="accs-toggle-sound" onclick="this.classList.toggle('on')"></div>
        </div>
      </div>
      <p style="font-size:12px;color:var(--text2)">As notificações funcionam apenas quando o app está aberto ou instalado como PWA.</p>
    `;
  } else if (section === 'data') {
    const lsSize = new Blob([JSON.stringify(localStorage)]).size;
    body = `
      <div class="accs-section-card">
        <div class="accs-info-row"><span>Armazenamento Local</span><span>${(lsSize/1024).toFixed(1)} KB</span></div>
        <div class="accs-info-row"><span>Matérias</span><span>${STATE.subjects.length}</span></div>
        <div class="accs-info-row"><span>Tarefas</span><span>${STATE.tasks.length}</span></div>
        <div class="accs-info-row"><span>Flashcards</span><span>${STATE.flashcards.length}</span></div>
      </div>
      <button class="accs-save-btn" onclick="exportAccsData()">📤 Exportar Meus Dados</button>
      <button class="accs-danger-btn" onclick="clearAccsCache()">🗑️ Limpar Cache Local</button>
    `;
  } else if (section === 'appearance') {
    body = `
      <p style="font-size:14px;color:var(--text2);margin-bottom:4px">Tema do Aplicativo</p>
      <div class="accs-section-card">
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          ${[
            {key:'default',label:'Colorido',grad:'linear-gradient(135deg,#6c63ff,#ff6584)'},
            {key:'dark',label:'Dark',grad:'linear-gradient(135deg,#18181b,#a0a0b0)'},
            {key:'light',label:'Light',grad:'linear-gradient(135deg,#f5f5f4,#44403c)'},
          ].map(t => `
            <button onclick="setTheme('${t.key}');this.parentNode.querySelectorAll('button').forEach(b=>b.style.outline='none');this.style.outline='2px solid var(--accent)'"
              style="display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 14px;border-radius:12px;background:var(--bg);cursor:pointer;transition:background 0.2s">
              <span style="width:36px;height:36px;border-radius:50%;background:${t.grad};display:block"></span>
              <span style="font-size:12px;color:var(--text)">${t.label}</span>
            </button>
          `).join('')}
        </div>
      </div>
    `;
  }

  document.getElementById('accs-sub-body').innerHTML = body;
  document.getElementById('accs-sub-panel').classList.add('open');
};

window.closeAccsSection = function() {
  document.getElementById('accs-sub-panel')?.classList.remove('open');
};

window.saveAccsAccount = async function() {
  const newName = document.getElementById('accs-inp-name')?.value?.trim();
  const bio = document.getElementById('accs-inp-bio')?.value?.trim();
  const user = STATE.currentUser;
  if (!user) return;
  try {
    const { updateProfile } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
    if (newName) await updateProfile(user, { displayName: newName });
    if (bio !== undefined) localStorage.setItem('accs_bio', bio);
    // refresh sidebar
    const name = newName || user.displayName || user.email.split('@')[0];
    const initials = name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0,2);
    const sidebarAvatar = document.getElementById('sidebar-avatar');
    const sidebarName = document.getElementById('sidebar-name');
    if (sidebarAvatar) sidebarAvatar.textContent = initials;
    if (sidebarName) sidebarName.textContent = name;
    document.getElementById('accs-display-name').textContent = name;
    showToast('✅ Perfil atualizado!');
    closeAccsSection();
  } catch(e) {
    showToast('Erro ao salvar: ' + e.message);
  }
};

window.saveAccsPassword = async function() {
  const pass = document.getElementById('accs-inp-pass')?.value;
  if (!pass || pass.length < 6) { showToast('Senha deve ter no mínimo 6 caracteres'); return; }
  try {
    const { updatePassword } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
    await updatePassword(STATE.currentUser, pass);
    showToast('✅ Senha alterada com sucesso!');
  } catch(e) {
    showToast('Erro: ' + e.message);
  }
};

window.confirmDeleteAccount = function() {
  if (confirm('Tem certeza que deseja EXCLUIR sua conta? Esta ação não pode ser desfeita.')) {
    STATE.currentUser?.delete()
      .then(() => { showToast('Conta excluída.'); })
      .catch(e => showToast('Erro: ' + e.message));
  }
};

window.toggleAccsNotif = function() {
  const el = document.getElementById('accs-toggle-notif');
  el.classList.toggle('on');
  localStorage.setItem('accs_notif', el.classList.contains('on') ? 'on' : 'off');
};

window.exportAccsData = function() {
  const data = {
    exportDate: new Date().toISOString(),
    subjects: STATE.subjects,
    classes: STATE.classes,
    tasks: STATE.tasks,
    flashcards: STATE.flashcards,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `studyflow_backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  showToast('📤 Dados exportados!');
};

window.clearAccsCache = function() {
  if (confirm('Limpar cache local? Os dados na nuvem serão mantidos.')) {
    localStorage.removeItem('studyflow_v3');
    localStorage.removeItem('studyflow_v2');
    showToast('🗑️ Cache limpo! Recarregue para sincronizar.');
  }
};

window.handleAvatarUpload = async function(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const user = STATE.currentUser;
  if (!user) return;
  try {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const dataUrl = e.target.result;
      // Update UI immediately
      const accsAvatar = document.getElementById('accs-avatar');
      if (accsAvatar) accsAvatar.innerHTML = `<img src="${dataUrl}" alt="avatar">`;
      const sidebarAvatar = document.getElementById('sidebar-avatar');
      if (sidebarAvatar) { sidebarAvatar.innerHTML = `<img src="${dataUrl}" style="width:100%;height:100%;border-radius:50%;object-fit:cover" alt="avatar">`; }
      // Save to localStorage as fallback (Firebase Storage not available in all plans)
      localStorage.setItem('accs_avatar_' + user.uid, dataUrl);
      showToast('✅ Foto de perfil atualizada!');
    };
    reader.readAsDataURL(file);
  } catch(e) {
    showToast('Erro ao carregar foto: ' + e.message);
  }
};

// Restore avatar from localStorage on init
(function restoreAvatar() {
  document.addEventListener('DOMContentLoaded', () => {
    // done on initAppForUser after auth
  });
})();