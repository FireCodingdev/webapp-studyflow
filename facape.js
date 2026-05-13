/**
 * facape.js — Integração com o Portal do Aluno FACAPE
 * Estratégia: abre um iframe/webview invisível para login,
 * depois faz scraping via proxy CORS ou via fetch com credenciais.
 *
 * Como o portal está em HTTPS com porta :8443, usamos a abordagem
 * de abrir uma janela popup gerenciada para login e, após sucesso,
 * armazenamos os dados coletados localmente + Firestore.
 */

const FACAPE_BASE = 'https://sistemas.facape.br:8443/portalaluno';
const FACAPE_LOGIN_URL = `${FACAPE_BASE}/login.do`;
const STORAGE_KEY = 'facape_data';
const CREDENTIALS_KEY = 'facape_credentials';

// ── Armazenamento local seguro ────────────────────────────────────────────────

export function saveFacapeCredentials(matricula, senha) {
  try {
    // Salva em sessionStorage (memória da sessão apenas, mais seguro)
    sessionStorage.setItem(CREDENTIALS_KEY, JSON.stringify({ matricula, senha }));
  } catch (e) { /* ignore */ }
}

export function getFacapeCredentials() {
  try {
    const raw = sessionStorage.getItem(CREDENTIALS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function saveFacapeData(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...data, syncedAt: new Date().toISOString() }));
  } catch (e) { /* ignore */ }
}

export function getFacapeData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clearFacapeData() {
  localStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(CREDENTIALS_KEY);
}

// ── Login e coleta de dados via fetch ────────────────────────────────────────

/**
 * Tenta login no portal e coleta dados do aluno.
 * Retorna { ok, data, error }
 */
export async function loginFacape(matricula, senha) {
  try {
    // Passo 1: obter JSESSIONID / token CSRF da página de login
    const loginPageResp = await fetch(FACAPE_LOGIN_URL, {
      method: 'GET',
      credentials: 'include',
      mode: 'cors',
    });

    if (!loginPageResp.ok && loginPageResp.status !== 0) {
      // CORS bloqueado — fallback para popup
      return { ok: false, needsPopup: true };
    }

    const loginHtml = await loginPageResp.text();

    // Extrai token CSRF se existir
    const csrfMatch = loginHtml.match(/name=['"_]?csrf['"_]?\s+(?:type=['"]hidden['"])?[^>]*value=['"]([^'"]+)['"]/i)
      || loginHtml.match(/name=['"]_token['"]\s+value=['"]([^'"]+)['"]/i);
    const csrf = csrfMatch?.[1] || '';

    // Passo 2: enviar formulário de login
    const formData = new URLSearchParams();
    formData.append('matricula', matricula);
    formData.append('senha', senha);
    if (csrf) formData.append('_csrf', csrf);

    const postResp = await fetch(FACAPE_LOGIN_URL, {
      method: 'POST',
      credentials: 'include',
      mode: 'cors',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    });

    const postText = await postResp.text();

    // Verifica se login foi bem-sucedido
    if (postText.includes('Senha incorreta') || postText.includes('Login inválido')
        || postText.includes('login.do') && postText.includes('alert')) {
      return { ok: false, error: 'Matrícula ou senha incorretos.' };
    }

    // Passo 3: coletar dados do perfil
    const data = await scrapeFacapeData(postText, matricula);
    saveFacapeData(data);
    saveFacapeCredentials(matricula, senha);
    return { ok: true, data };

  } catch (e) {
    console.warn('[FACAPE] Erro de fetch (CORS provável):', e.message);
    // Se CORS bloquear, precisamos da abordagem popup
    return { ok: false, needsPopup: true, error: e.message };
  }
}

/**
 * Extrai dados do HTML do portal após login bem-sucedido.
 */
async function scrapeFacapeData(homeHtml, matricula) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(homeHtml, 'text/html');

  // Nome do aluno
  const nome = extractText(doc, [
    '.nome-aluno', '#nomeAluno', '.aluno-nome',
    'h2', 'h3', '.welcome strong', '.user-name',
    '[class*="nome"]', '[class*="aluno"]',
  ]) || `Aluno ${matricula}`;

  // Curso e período
  const curso = extractText(doc, [
    '.curso', '#curso', '[class*="curso"]', 'td:contains("Curso")',
  ]) || '';

  const periodo = extractText(doc, [
    '.periodo', '#periodo', '[class*="periodo"]', '[class*="semestre"]',
  ]) || '';

  // Matérias — tenta encontrar tabela de horários ou lista de disciplinas
  const materias = extractMaterias(doc);

  // Notas
  const notas = extractNotas(doc);

  // Horários
  const horarios = extractHorarios(doc);

  return {
    nome: cleanText(nome),
    matricula,
    curso: cleanText(curso),
    periodo: cleanText(periodo),
    materias,
    notas,
    horarios,
    rawHtml: homeHtml.length > 50000 ? homeHtml.slice(0, 50000) : homeHtml,
  };
}

function extractText(doc, selectors) {
  for (const sel of selectors) {
    try {
      const el = doc.querySelector(sel);
      if (el?.textContent?.trim()) return el.textContent.trim();
    } catch { /* invalid selector */ }
  }
  return '';
}

function extractMaterias(doc) {
  const materias = [];
  // Busca por tabelas que contenham disciplinas
  const tables = doc.querySelectorAll('table');
  for (const table of tables) {
    const headers = [...table.querySelectorAll('th')].map(th => th.textContent.toLowerCase().trim());
    const hasDisciplina = headers.some(h => h.includes('disciplina') || h.includes('matéria') || h.includes('materia'));
    if (hasDisciplina) {
      const rows = table.querySelectorAll('tbody tr');
      for (const row of rows) {
        const cells = [...row.querySelectorAll('td')];
        if (cells.length >= 1) {
          const nome = cells[0]?.textContent?.trim();
          if (nome && nome.length > 2) materias.push({ nome, codigo: cells[1]?.textContent?.trim() || '' });
        }
      }
    }
  }
  // Fallback: busca por listas
  if (materias.length === 0) {
    const items = doc.querySelectorAll('[class*="disciplina"], [class*="materia"], [class*="matéria"]');
    items.forEach(el => {
      const nome = el.textContent?.trim();
      if (nome && nome.length > 2) materias.push({ nome, codigo: '' });
    });
  }
  return materias.slice(0, 20);
}

function extractNotas(doc) {
  const notas = [];
  const tables = doc.querySelectorAll('table');
  for (const table of tables) {
    const headers = [...table.querySelectorAll('th')].map(th => th.textContent.toLowerCase().trim());
    const hasNota = headers.some(h => h.includes('nota') || h.includes('grade') || h.includes('média') || h.includes('media'));
    if (hasNota) {
      const rows = table.querySelectorAll('tbody tr');
      for (const row of rows) {
        const cells = [...row.querySelectorAll('td')];
        if (cells.length >= 2) {
          notas.push({
            disciplina: cells[0]?.textContent?.trim() || '',
            nota: cells[1]?.textContent?.trim() || '',
            situacao: cells[cells.length - 1]?.textContent?.trim() || '',
          });
        }
      }
    }
  }
  return notas.slice(0, 20);
}

function extractHorarios(doc) {
  const horarios = [];
  // Busca tabela de horários (dias da semana como colunas)
  const tables = doc.querySelectorAll('table');
  for (const table of tables) {
    const headers = [...table.querySelectorAll('th')].map(th => th.textContent.toLowerCase().trim());
    const hasDia = headers.some(h => ['seg','ter','qua','qui','sex','sab','dom','segunda','terça','quarta','quinta','sexta'].includes(h));
    if (hasDia) {
      const rows = table.querySelectorAll('tbody tr');
      for (const row of rows) {
        const cells = [...row.querySelectorAll('td')];
        const horario = cells[0]?.textContent?.trim();
        if (horario) {
          headers.forEach((dia, i) => {
            const aula = cells[i]?.textContent?.trim();
            if (aula && aula.length > 2 && aula !== horario) {
              horarios.push({ dia, horario, aula });
            }
          });
        }
      }
    }
  }
  return horarios;
}

function cleanText(text) {
  return text?.replace(/\s+/g, ' ').trim() || '';
}

// ── Importar dados para o StudyFlow ──────────────────────────────────────────

/**
 * Converte dados do FACAPE para o formato do StudyFlow e importa.
 * @param {object} facapeData - dados coletados do portal
 * @param {object} STATE - estado global do app
 * @param {function} save - função de salvar estado
 */
export function importFacapeToStudyFlow(facapeData, STATE, save) {
  const imported = { subjects: 0, classes: 0 };

  // Importa matérias como subjects
  if (facapeData.materias?.length > 0) {
    const COLORS = ['#6c63ff','#ff6584','#ffa502','#2ed573','#1e90ff','#ff4757','#eccc68','#a29bfe','#fd79a8','#00cec9'];
    const existing = new Set(STATE.subjects.map(s => s.nome?.toLowerCase() || s.name?.toLowerCase()));

    facapeData.materias.forEach((m, i) => {
      if (!existing.has(m.nome.toLowerCase())) {
        STATE.subjects.push({
          id: 'facape_' + Date.now() + '_' + i,
          name: m.nome,
          color: COLORS[i % COLORS.length],
          fromFacape: true,
        });
        imported.subjects++;
      }
    });
  }

  // Importa horários como classes
  if (facapeData.horarios?.length > 0) {
    const DAY_MAP = {
      'seg': 1, 'segunda': 1, 'segunda-feira': 1,
      'ter': 2, 'terça': 2, 'terca': 2, 'terça-feira': 2,
      'qua': 3, 'quarta': 3, 'quarta-feira': 3,
      'qui': 4, 'quinta': 4, 'quinta-feira': 4,
      'sex': 5, 'sexta': 5, 'sexta-feira': 5,
      'sab': 6, 'sábado': 6, 'sabado': 6,
      'dom': 0, 'domingo': 0,
    };

    facapeData.horarios.forEach((h, i) => {
      const dayKey = h.dia?.toLowerCase().trim();
      const dayNum = DAY_MAP[dayKey];
      if (dayNum === undefined) return;

      // Extrai horário HH:MM-HH:MM
      const timeMatch = h.horario?.match(/(\d{1,2})[h:](\d{2})?\s*[-–]\s*(\d{1,2})[h:](\d{2})?/);
      const startTime = timeMatch ? `${String(timeMatch[1]).padStart(2,'0')}:${timeMatch[2]||'00'}` : '08:00';
      const endTime = timeMatch ? `${String(timeMatch[3]).padStart(2,'0')}:${timeMatch[4]||'00'}` : '10:00';

      // Encontra subject correspondente
      const subject = STATE.subjects.find(s => s.name?.toLowerCase().includes(h.aula?.toLowerCase().slice(0, 8)));

      STATE.classes.push({
        id: 'facape_cls_' + Date.now() + '_' + i,
        subjectId: subject?.id || '',
        subjectName: h.aula,
        subjectColor: subject?.color || '#6c63ff',
        day: dayNum,
        start: startTime,
        end: endTime,
        room: '',
        fromFacape: true,
      });
      imported.classes++;
    });
  }

  if (imported.subjects > 0 || imported.classes > 0) {
    save();
  }
  return imported;
}

// ── Renderer do painel de configurações ──────────────────────────────────────

export function renderFacapeSettingsSection(uid, STATE, save, showToast, renderDashboard) {
  const panel = document.getElementById('accs-sub-body');
  if (!panel) return;

  const existingData = getFacapeData();
  const isConnected = !!existingData;

  if (isConnected) {
    _renderFacapeConnected(panel, existingData, uid, STATE, save, showToast, renderDashboard);
  } else {
    _renderFacapeLogin(panel, uid, STATE, save, showToast, renderDashboard);
  }
}

function _renderFacapeLogin(panel, uid, STATE, save, showToast, renderDashboard) {
  panel.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:16px">
      <!-- Logo / header FACAPE -->
      <div style="display:flex;align-items:center;gap:12px;padding:16px;background:#1a3a6e;border-radius:14px">
        <div style="width:48px;height:48px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#1a3a6e" stroke-width="2">
            <path d="M22 10v6M2 10l10-5 10 5-10 5z"/>
            <path d="M6 12v5c3 3 9 3 12 0v-5"/>
          </svg>
        </div>
        <div>
          <div style="font-weight:700;color:#fff;font-size:15px">Portal do Aluno FACAPE</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.7)">Conecte para importar horários e notas automaticamente</div>
        </div>
      </div>

      <!-- O que será importado -->
      <div class="accs-section-card">
        <div style="font-size:12px;font-weight:700;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">O que será importado</div>
        ${['📛 Nome e matrícula', '🎓 Curso e período', '📚 Matérias do semestre', '📅 Horário das aulas', '📊 Últimas notas'].map(item => `
          <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:#fff">${item}</div>
        `).join('')}
      </div>

      <!-- Formulário de login -->
      <div class="accs-field">
        <label>Matrícula</label>
        <input id="facape-matricula" type="text" inputmode="numeric" pattern="[0-9]*"
          placeholder="Ex: 27805" autocomplete="username"
          style="font-size:16px;letter-spacing:2px">
      </div>
      <div class="accs-field">
        <label>Senha do Portal</label>
        <div style="position:relative">
          <input id="facape-senha" type="password" placeholder="Sua senha do portal"
            autocomplete="current-password"
            style="width:100%;box-sizing:border-box;padding-right:44px">
          <button onclick="document.getElementById('facape-senha').type==='password'?document.getElementById('facape-senha').type='text':document.getElementById('facape-senha').type='password'"
            style="position:absolute;right:12px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.5);padding:0">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
        </div>
      </div>

      <div id="facape-status" style="display:none;padding:12px;border-radius:10px;font-size:13px;text-align:center"></div>

      <button class="accs-save-btn" id="facape-login-btn" onclick="window._facapeDoLogin()">
        🔗 Conectar Portal FACAPE
      </button>

      <p style="font-size:11px;color:rgba(255,255,255,0.4);line-height:1.6;text-align:center">
        Suas credenciais são usadas apenas para acessar o portal e <strong>não são armazenadas permanentemente</strong>.
        Os dados coletados ficam salvos localmente no seu dispositivo.
      </p>
    </div>
  `;

  window._facapeDoLogin = async function() {
    const matricula = document.getElementById('facape-matricula')?.value?.trim();
    const senha = document.getElementById('facape-senha')?.value;
    const statusEl = document.getElementById('facape-status');
    const btn = document.getElementById('facape-login-btn');

    if (!matricula || !senha) {
      _facapeStatus('⚠️ Preencha matrícula e senha.', '#ffa502');
      return;
    }

    btn.disabled = true;
    btn.textContent = '⏳ Conectando...';
    _facapeStatus('Acessando o Portal do Aluno...', 'rgba(255,255,255,0.6)');

    try {
      const result = await loginFacape(matricula, senha);

      if (result.ok) {
        // Importa dados para o StudyFlow
        const imported = importFacapeToStudyFlow(result.data, STATE, save);
        renderDashboard?.();
        showToast(`✅ FACAPE conectado! ${imported.subjects} matérias e ${imported.classes} aulas importadas.`);
        // Atualiza perfil acadêmico se disponível
        _updateAcademicProfile(result.data, uid);
        // Re-renderiza painel como conectado
        _renderFacapeConnected(panel, result.data, uid, STATE, save, showToast, renderDashboard);

      } else if (result.needsPopup) {
        // CORS bloqueou — oferece abrir o portal manualmente
        _facapeStatus('', '');
        _renderFacapePopupFallback(panel, matricula, senha, uid, STATE, save, showToast, renderDashboard);

      } else {
        _facapeStatus('❌ ' + (result.error || 'Erro desconhecido. Tente novamente.'), '#e05252');
        btn.disabled = false;
        btn.textContent = '🔗 Conectar Portal FACAPE';
      }
    } catch (e) {
      _facapeStatus('❌ Erro: ' + e.message, '#e05252');
      btn.disabled = false;
      btn.textContent = '🔗 Conectar Portal FACAPE';
    }
  };

  // Enter para login
  panel.querySelector('#facape-senha')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') window._facapeDoLogin?.();
  });

  function _facapeStatus(msg, color) {
    const el = document.getElementById('facape-status');
    if (!el) return;
    if (!msg) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.color = color;
    el.style.background = 'rgba(255,255,255,0.05)';
    el.textContent = msg;
  }
}

/**
 * Fallback quando CORS bloqueia: abre popup do portal e aguarda dados
 * sendo inseridos manualmente pelo usuário (modo degradado).
 */
function _renderFacapePopupFallback(panel, matricula, senha, uid, STATE, save, showToast, renderDashboard) {
  // Salva credenciais para uso posterior
  saveFacapeCredentials(matricula, senha);

  // Cria dados mínimos com o que já sabemos (matrícula)
  const minimalData = {
    nome: `Aluno ${matricula}`,
    matricula,
    curso: '',
    periodo: '',
    materias: [],
    notas: [],
    horarios: [],
    manualEntry: true,
  };
  saveFacapeData(minimalData);

  panel.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:16px">
      <div style="padding:16px;background:rgba(255,165,2,0.15);border:1px solid rgba(255,165,2,0.3);border-radius:14px;font-size:13px;color:#ffa502;line-height:1.6">
        <strong>⚠️ Restrição de conexão direta</strong><br>
        O portal da FACAPE restringe o acesso direto por segurança. Para contornar isso, você pode <strong>abrir o portal</strong> e adicionar seus dados manualmente abaixo.
      </div>

      <button class="accs-save-btn" onclick="window.open('https://sistemas.facape.br:8443/portalaluno/login.do','_blank')" style="background:linear-gradient(135deg,#1a3a6e,#2d5fb8)">
        🌐 Abrir Portal FACAPE
      </button>

      <!-- Entrada manual de dados -->
      <div style="font-size:13px;font-weight:600;color:rgba(255,255,255,0.7);margin-top:4px">Insira seus dados manualmente:</div>

      <div class="accs-field">
        <label>Nome Completo</label>
        <input id="facape-manual-nome" type="text" placeholder="Seu nome como no portal">
      </div>
      <div class="accs-field">
        <label>Curso</label>
        <input id="facape-manual-curso" type="text" placeholder="Ex: Ciência da Computação">
      </div>
      <div class="accs-field">
        <label>Período / Semestre</label>
        <input id="facape-manual-periodo" type="text" placeholder="Ex: 5º Período">
      </div>
      <div class="accs-field">
        <label>Matérias do Semestre (uma por linha)</label>
        <textarea id="facape-manual-materias" placeholder="Tecnologia da Informação e Sociedade\nEngenharia de Software\nBanco de Dados" style="min-height:100px"></textarea>
      </div>

      <button class="accs-save-btn" onclick="window._facapeSaveManual()">
        💾 Salvar Dados
      </button>
      <button style="background:none;border:none;color:rgba(255,255,255,0.4);font-size:13px;cursor:pointer;padding:8px" onclick="window._facapeCancelManual()">
        Cancelar
      </button>
    </div>
  `;

  window._facapeSaveManual = function() {
    const nome = document.getElementById('facape-manual-nome')?.value?.trim() || `Aluno ${matricula}`;
    const curso = document.getElementById('facape-manual-curso')?.value?.trim() || '';
    const periodo = document.getElementById('facape-manual-periodo')?.value?.trim() || '';
    const materiasRaw = document.getElementById('facape-manual-materias')?.value?.trim() || '';
    const materias = materiasRaw.split('\n').map(m => m.trim()).filter(Boolean).map(nome => ({ nome, codigo: '' }));

    const data = { nome, matricula, curso, periodo, materias, notas: [], horarios: [], manualEntry: true };
    saveFacapeData(data);

    const imported = importFacapeToStudyFlow(data, STATE, save);
    renderDashboard?.();
    _updateAcademicProfile(data, uid);
    showToast(`✅ Dados salvos! ${imported.subjects} matérias importadas.`);
    _renderFacapeConnected(panel, data, uid, STATE, save, showToast, renderDashboard);
  };

  window._facapeCancelManual = function() {
    clearFacapeData();
    _renderFacapeLogin(panel, uid, STATE, save, showToast, renderDashboard);
  };
}

function _renderFacapeConnected(panel, data, uid, STATE, save, showToast, renderDashboard) {
  const syncedAt = data.syncedAt ? new Date(data.syncedAt).toLocaleDateString('pt-BR', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }) : '—';

  panel.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:14px">
      <!-- Status conectado -->
      <div style="display:flex;align-items:center;gap:12px;padding:16px;background:#1a3a6e;border-radius:14px">
        <div style="width:44px;height:44px;border-radius:50%;background:#2ed573;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:20px">✓</div>
        <div>
          <div style="font-weight:700;color:#fff;font-size:14px">${data.nome || 'Aluno FACAPE'}</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.7)">Matrícula: ${data.matricula || '—'}</div>
        </div>
      </div>

      <!-- Dados coletados -->
      <div class="accs-section-card">
        <div class="accs-info-row">
          <span>Curso</span>
          <span>${data.curso || 'Não informado'}</span>
        </div>
        <div class="accs-info-row">
          <span>Período</span>
          <span>${data.periodo || 'Não informado'}</span>
        </div>
        <div class="accs-info-row">
          <span>Matérias importadas</span>
          <span>${data.materias?.length || 0}</span>
        </div>
        <div class="accs-info-row">
          <span>Horários importados</span>
          <span>${data.horarios?.length || 0}</span>
        </div>
        <div class="accs-info-row">
          <span>Última sincronização</span>
          <span style="font-size:11px">${syncedAt}</span>
        </div>
      </div>

      ${data.notas?.length > 0 ? `
      <!-- Últimas notas -->
      <div style="font-size:12px;font-weight:700;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.5px">Últimas Notas</div>
      <div class="accs-section-card">
        ${data.notas.slice(0, 5).map(n => `
          <div class="accs-info-row">
            <span style="font-size:12px;max-width:60%">${n.disciplina}</span>
            <span style="font-weight:700;color:${parseFloat(n.nota) >= 5 ? '#2ed573' : '#e05252'}">${n.nota}</span>
          </div>
        `).join('')}
      </div>
      ` : ''}

      <!-- Ações -->
      <button class="accs-save-btn" id="facape-resync-btn" onclick="window._facapeResync()">
        🔄 Sincronizar Novamente
      </button>
      <button class="accs-danger-btn" onclick="window._facapeDisconnect()">
        🔌 Desconectar Portal FACAPE
      </button>
    </div>
  `;

  window._facapeResync = async function() {
    const btn = document.getElementById('facape-resync-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Sincronizando...'; }
    const creds = getFacapeCredentials();
    if (!creds) {
      showToast('⚠️ Faça login novamente para sincronizar.');
      _renderFacapeLogin(panel, uid, STATE, save, showToast, renderDashboard);
      return;
    }
    const result = await loginFacape(creds.matricula, creds.senha);
    if (result.ok) {
      const imported = importFacapeToStudyFlow(result.data, STATE, save);
      renderDashboard?.();
      showToast(`✅ Sincronizado! ${imported.subjects} matérias, ${imported.classes} aulas.`);
      _renderFacapeConnected(panel, result.data, uid, STATE, save, showToast, renderDashboard);
    } else {
      showToast('❌ Erro ao sincronizar. Reconecte o portal.');
      if (btn) { btn.disabled = false; btn.textContent = '🔄 Sincronizar Novamente'; }
    }
  };

  window._facapeDisconnect = function() {
    if (!confirm('Desconectar o Portal FACAPE? As matérias importadas serão mantidas.')) return;
    clearFacapeData();
    showToast('🔌 Portal FACAPE desconectado.');
    _renderFacapeLogin(panel, uid, STATE, save, showToast, renderDashboard);
  };
}

// Atualiza o perfil acadêmico do StudyFlow com dados do FACAPE
async function _updateAcademicProfile(data, uid) {
  if (!uid || !data) return;
  try {
    const { updateDoc, doc, getFirestore } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const { db } = await import('./firebase.js');
    const update = {};
    if (data.curso) update['academicProfile.institution'] = 'FACAPE';
    if (data.curso) update['academicProfile.course'] = data.curso;
    if (data.periodo) update['academicProfile.period'] = data.periodo;
    if (data.nome) update['academicProfile.facapeNome'] = data.nome;
    if (Object.keys(update).length > 0) {
      await updateDoc(doc(db, 'users', uid), update);
    }
  } catch (e) {
    console.warn('[FACAPE] Erro ao atualizar perfil no Firestore:', e.message);
  }
}
