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
import { initClassroom } from './classroom.js';

// ===== STATE =====
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
  const titles = { dashboard: 'Dashboard', schedule: 'Cronograma', tasks: 'Atividades', flashcards: 'Flashcards', links: 'Materiais & Links' };
  document.getElementById('page-title').textContent = titles[page] || page;
  STATE.currentPage = page;
  
  if (page === 'dashboard') renderDashboard();
  if (page === 'schedule') renderSchedule();
  if (page === 'tasks') renderTasks();
  if (page === 'flashcards') renderFlashcards();
  if (page === 'links') renderLinks();
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
  const today = new Date().getDay();
  const todayClasses = STATE.classes.filter(c => c.day === today)
    .sort((a, b) => a.start.localeCompare(b.start));
  const pendingTasks = STATE.tasks.filter(t => !t.done);
  const doneTasks = STATE.tasks.filter(t => t.done);
  const exams = pendingTasks.filter(t => t.type === 'exam');
  const upcomingTasks = pendingTasks
    .sort((a, b) => (a.deadline || '9999-12-31') < (b.deadline || '9999-12-31') ? -1 : 1)
    .slice(0, 3);

  document.getElementById('stat-classes').textContent = todayClasses.length;
  document.getElementById('stat-tasks').textContent = pendingTasks.length;
  document.getElementById('stat-exams').textContent = exams.length;

  // --- Pie Chart ---
  const total = STATE.tasks.length;
  const doneCount = doneTasks.length;
  const pendingCount = pendingTasks.length;
  const pieEl = document.getElementById('dashboard-pie');
  if (pieEl) {
    if (total === 0) {
      pieEl.innerHTML = `<div class="pie-empty">Nenhuma atividade ainda</div>`;
    } else {
      const pct = Math.round((doneCount / total) * 100);
      const angle = (doneCount / total) * 360;
      const r = 38, cx = 50, cy = 50;
      const rad = (angle - 90) * Math.PI / 180;
      const x = cx + r * Math.cos(rad);
      const y = cy + r * Math.sin(rad);
      const largeArc = angle > 180 ? 1 : 0;
      const slicePath = angle >= 360
        ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--accent)"/>`
        : angle === 0
          ? ''
          : `<path d="M${cx},${cy-r} A${r},${r} 0 ${largeArc},1 ${x.toFixed(2)},${y.toFixed(2)} Z" fill="var(--accent)"/>`;
      pieEl.innerHTML = `
        <div class="pie-chart-wrap">
          <svg viewBox="0 0 100 100" width="90" height="90">
            <circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--surface2)"/>
            ${slicePath}
            <circle cx="${cx}" cy="${cy}" r="24" fill="var(--surface)"/>
            <text x="${cx}" y="${cy+1}" text-anchor="middle" dominant-baseline="middle" font-size="14" font-weight="700" fill="var(--text)">${pct}%</text>
          </svg>
          <div class="pie-legend">
            <div class="pie-leg-item"><span class="pie-dot" style="background:var(--accent)"></span><span>${doneCount} concluída${doneCount !== 1 ? 's' : ''}</span></div>
            <div class="pie-leg-item"><span class="pie-dot" style="background:var(--surface2)"></span><span>${pendingCount} pendente${pendingCount !== 1 ? 's' : ''}</span></div>
          </div>
        </div>`;
    }
  }

  // --- Next Exam Countdown ---
  const nextExamEl = document.getElementById('dashboard-next-exam');
  if (nextExamEl) {
    const upcoming = exams
      .filter(e => e.deadline)
      .sort((a, b) => a.deadline.localeCompare(b.deadline));
    if (upcoming.length === 0) {
      nextExamEl.innerHTML = `<div class="next-exam-empty">📅 Nenhuma prova agendada</div>`;
    } else {
      const exam = upcoming[0];
      const d = new Date(exam.deadline + 'T00:00:00');
      const todayD = new Date(); todayD.setHours(0,0,0,0);
      const diff = Math.round((d - todayD) / (1000*60*60*24));
      const diffLabel = diff === 0 ? 'HOJE!' : diff === 1 ? 'Amanhã' : `Em ${diff} dias`;
      const urgentClass = diff <= 2 ? 'urgent' : diff <= 7 ? 'soon' : '';
      nextExamEl.innerHTML = `
        <div class="next-exam-card ${urgentClass}">
          <div class="next-exam-icon">📝</div>
          <div class="next-exam-info">
            <div class="next-exam-label">Próxima Prova</div>
            <div class="next-exam-title">${exam.title}</div>
            ${exam.subjectName ? `<div class="next-exam-sub" style="color:${exam.subjectColor}">${exam.subjectName}</div>` : ''}
          </div>
          <div class="next-exam-countdown ${urgentClass}">${diffLabel}</div>
        </div>`;
    }
  }

  const classesEl = document.getElementById('today-classes');
  classesEl.innerHTML = todayClasses.length === 0 ? `
    <div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
      <p>Nenhuma aula hoje</p>
      <button onclick="navigateTo('schedule')">Adicionar aulas</button>
    </div>` : todayClasses.map(cls => renderClassCard(cls)).join('');

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

  return `
    <div class="cls-card ${isLive ? 'cls-card--live' : ''}">
      <div class="cls-card-bar" style="background:${cls.subjectColor}"></div>
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
        ${isLive ? `<div class="cls-progress"><div class="cls-progress-fill" style="width:${progress}%;background:${cls.subjectColor}"></div></div>` : ''}
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
            ${task.subjectName ? `<span class="tag tag-subject" style="background:${task.subjectColor}22;color:${task.subjectColor}">${escapeHtml(task.subjectName)}</span>` : ''}
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

  el.innerHTML = cards.map(c => {
    const isDue = c.nextReview <= today;
    return `
    <div class="fc-card ${isDue ? 'fc-due' : ''}" id="fc-${c.id}">
      <div class="fc-card-inner" onclick="flipCard('${c.id}')">
        <div class="fc-front">
          ${c.subjectName ? `<span class="fc-subject-tag" style="background:${c.subjectColor}22;color:${c.subjectColor}">${escapeHtml(c.subjectName)}</span>` : ''}
          ${isDue ? '<span class="fc-due-badge">Revisar</span>' : ''}
          <p class="fc-text">${escapeHtml(c.front)}</p>
          <span class="fc-hint">Toque para revelar</span>
        </div>
        <div class="fc-back" style="display:none">
          <p class="fc-text">${escapeHtml(c.back)}</p>
          <div class="fc-rating">
            <span class="fc-rating-label">Como foi?</span>
            <div class="fc-rating-btns">
              <button class="fc-btn fc-btn-fail" onclick="rateCard(event,'${c.id}',1)">Errei</button>
              <button class="fc-btn fc-btn-hard" onclick="rateCard(event,'${c.id}',3)">Difícil</button>
              <button class="fc-btn fc-btn-ok" onclick="rateCard(event,'${c.id}',4)">Bom</button>
              <button class="fc-btn fc-btn-easy" onclick="rateCard(event,'${c.id}',5)">Fácil</button>
            </div>
          </div>
        </div>
      </div>
      <button class="fc-delete" onclick="deleteFlashcard('${c.id}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
      </button>
    </div>`;
  }).join('');
}

window.flipCard = function(id) {
  const el = document.getElementById(`fc-${id}`);
  if (!el) return;
  const front = el.querySelector('.fc-front');
  const back = el.querySelector('.fc-back');
  const isFlipped = back.style.display !== 'none';
  front.style.display = isFlipped ? 'block' : 'none';
  back.style.display = isFlipped ? 'none' : 'block';
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

// ===== LINKS (Central de Materiais) =====
function renderLinks() {
  const el = document.getElementById('links-list');
  if (!el) return;
  if (STATE.subjects.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
        <p>Adicione matérias com links para vê-los aqui</p>
        <button onclick="openAddSubject()">Adicionar matéria</button>
      </div>`;
    return;
  }
  el.innerHTML = STATE.subjects.map(s => {
    const links = s.links || [];
    return `
    <div class="links-subject-block">
      <div class="links-subject-header">
        <span class="links-dot" style="background:${s.color}"></span>
        <span class="links-subject-name">${escapeHtml(s.name)}</span>
        <button class="links-edit-btn" onclick="openEditSubjectLinks('${s.id}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
      </div>
      ${links.length === 0
        ? `<p class="links-empty-sub">Nenhum link adicionado</p>`
        : links.map(link => {
            const domain = (() => { try { return new URL(link).hostname.replace('www.',''); } catch { return String(link); } })();
            const icon = domain.includes('youtube') ? '▶️' : domain.includes('drive.google') ? '📁' : domain.includes('notion') ? '📝' : domain.includes('github') ? '💻' : '🔗';
            const safeHref = isHttpUrl(link) ? link : '#';
            return `<a class="link-item" href="${safeHref}" target="_blank" rel="noopener">
              <span class="link-icon">${icon}</span>
              <span class="link-domain">${escapeHtml(domain)}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="link-arrow"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </a>`;
          }).join('')
      }
    </div>`;
  }).join('');
}

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