/**
 * facape.js — Integração com o Portal do Aluno FACAPE
 *
 * Estratégia: usa Firebase Cloud Function (facapeProxy) como proxy server-side,
 * contornando o bloqueio de CORS do portal. As credenciais transitam de forma
 * segura (HTTPS + Firebase Auth token) e nunca ficam expostas no cliente.
 *
 * Fallback: entrada manual de dados quando o portal está indisponível.
 */

import { auth } from './firebase.js';

const STORAGE_KEY     = 'facape_data';
const CREDENTIALS_KEY = 'facape_credentials';

// URL da Cloud Function — ajuste para o seu projeto Firebase
const PROXY_URL = 'https://us-central1-studyflow-app.cloudfunctions.net/facapeProxy';

// ── Armazenamento local ───────────────────────────────────────────────────────

export function saveFacapeCredentials(matricula, senha) {
  try {
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

// ── Login via proxy seguro ────────────────────────────────────────────────────

/**
 * Faz login no portal via Cloud Function proxy.
 * Retorna { ok, data } em caso de sucesso,
 *         { ok: false, needsManual, error } quando o portal está inacessível.
 */
export async function loginFacape(matricula, senha) {
  try {
    // Obtém token do usuário autenticado para autorizar a Cloud Function
    const user = auth.currentUser;
    if (!user) return { ok: false, error: 'Usuário não autenticado.' };

    const idToken = await user.getIdToken();

    const resp = await fetch(PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({ matricula, senha }),
    });

    const result = await resp.json();

    if (resp.status === 401) {
      return { ok: false, error: result.error || 'Matrícula ou senha incorretos.' };
    }

    if (!resp.ok) {
      return { ok: false, needsManual: true, error: result.error || 'Erro no servidor proxy.' };
    }

    if (result.ok && result.data) {
      saveFacapeData(result.data);
      saveFacapeCredentials(matricula, senha);
      return { ok: true, data: result.data };
    }

    // Portal retornou mas sem dados (indisponível / estrutura mudou)
    return { ok: false, needsManual: !!result.needsManual, error: result.error || 'Erro desconhecido.' };

  } catch (err) {
    console.warn('[FACAPE] Erro ao chamar proxy:', err.message);
    return { ok: false, needsManual: true, error: 'Não foi possível conectar ao servidor proxy.' };
  }
}

// ── Importar dados para o StudyFlow ──────────────────────────────────────────

export function importFacapeToStudyFlow(facapeData, STATE, save) {
  const imported = { subjects: 0, classes: 0 };

  if (facapeData.materias?.length > 0) {
    const COLORS = ['#6c63ff','#ff6584','#ffa502','#2ed573','#1e90ff','#ff4757','#eccc68','#a29bfe','#fd79a8','#00cec9'];
    const existing = new Set(STATE.subjects.map(s => (s.nome || s.name || '').toLowerCase()));

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

      const timeMatch = h.horario?.match(/(\d{1,2})[h:](\d{2})?\s*[-–]\s*(\d{1,2})[h:](\d{2})?/);
      const startTime = timeMatch ? `${String(timeMatch[1]).padStart(2,'0')}:${timeMatch[2]||'00'}` : '08:00';
      const endTime   = timeMatch ? `${String(timeMatch[3]).padStart(2,'0')}:${timeMatch[4]||'00'}` : '10:00';

      const subject = STATE.subjects.find(s =>
        s.name?.toLowerCase().includes(h.aula?.toLowerCase().slice(0, 8))
      );

      STATE.classes.push({
        id: 'facape_cls_' + Date.now() + '_' + i,
        subjectId:    subject?.id || '',
        subjectName:  h.aula,
        subjectColor: subject?.color || '#6c63ff',
        day:   dayNum,
        start: startTime,
        end:   endTime,
        room:  '',
        fromFacape: true,
      });
      imported.classes++;
    });
  }

  if (imported.subjects > 0 || imported.classes > 0) save();
  return imported;
}

// ── Renderer do painel de configurações ──────────────────────────────────────

export function renderFacapeSettingsSection(uid, STATE, save, showToast, renderDashboard) {
  const panel = document.getElementById('accs-sub-body');
  if (!panel) return;

  const existingData = getFacapeData();
  if (existingData) {
    _renderFacapeConnected(panel, existingData, uid, STATE, save, showToast, renderDashboard);
  } else {
    _renderFacapeLogin(panel, uid, STATE, save, showToast, renderDashboard);
  }
}

// ── Tela de login ─────────────────────────────────────────────────────────────

function _renderFacapeLogin(panel, uid, STATE, save, showToast, renderDashboard) {
  panel.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:16px">

      <!-- Header -->
      <div style="display:flex;align-items:center;gap:12px;padding:18px;background:linear-gradient(135deg,#1a3a6e,#2d5fb8);border-radius:16px">
        <div style="width:50px;height:50px;border-radius:50%;background:rgba(255,255,255,0.15);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:22px">🎓</div>
        <div>
          <div style="font-weight:700;color:#fff;font-size:15px">Portal do Aluno FACAPE</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.7);margin-top:2px;line-height:1.4">Importe horários e notas automaticamente</div>
        </div>
      </div>

      <!-- O que será importado -->
      <div style="background:#2c2c2e;border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:8px">
        <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:2px">O que será importado</div>
        ${['📛 Nome e matrícula', '🎓 Curso e período', '📚 Matérias do semestre', '📅 Horário das aulas', '📊 Últimas notas'].map(item => `
          <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:rgba(255,255,255,0.85)">${item}</div>
        `).join('')}
      </div>

      <!-- Formulário -->
      <div style="display:flex;flex-direction:column;gap:10px">
        <div class="accs-form-group">
          <label class="accs-label">Matrícula</label>
          <input id="facape-matricula" class="accs-input" type="text" inputmode="numeric"
            placeholder="Ex: 27805" autocomplete="username">
        </div>
        <div class="accs-form-group">
          <label class="accs-label">Senha do Portal</label>
          <div style="position:relative">
            <input id="facape-senha" class="accs-input" type="password"
              placeholder="Sua senha do portal" autocomplete="current-password"
              style="padding-right:46px">
            <button id="facape-toggle-pwd"
              style="position:absolute;right:12px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.4);padding:4px;display:flex;align-items:center">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      <!-- Status -->
      <div id="facape-status" style="display:none;padding:12px 14px;border-radius:12px;font-size:13px;line-height:1.5"></div>

      <!-- Botão principal -->
      <button class="accs-save-btn" id="facape-login-btn" style="background:linear-gradient(135deg,#1a3a6e,#2d5fb8)">
        🔗 Conectar Portal FACAPE
      </button>

      <p style="font-size:11px;color:rgba(255,255,255,0.35);line-height:1.6;text-align:center;margin:0">
        Suas credenciais são usadas apenas para acessar o portal e não são armazenadas permanentemente.
      </p>
    </div>
  `;

  // Toggle senha
  document.getElementById('facape-toggle-pwd')?.addEventListener('click', () => {
    const inp = document.getElementById('facape-senha');
    if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  // Enter para submeter
  document.getElementById('facape-senha')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') _doLogin();
  });

  // Botão login
  document.getElementById('facape-login-btn')?.addEventListener('click', _doLogin);

  async function _doLogin() {
    const matricula = document.getElementById('facape-matricula')?.value?.trim();
    const senha     = document.getElementById('facape-senha')?.value;
    const btn       = document.getElementById('facape-login-btn');

    if (!matricula || !senha) {
      _setStatus('⚠️ Preencha matrícula e senha.', 'warning');
      return;
    }

    btn.disabled = true;
    btn.textContent = '⏳ Conectando...';
    _setStatus('Acessando o Portal do Aluno via servidor seguro...', 'info');

    try {
      const result = await loginFacape(matricula, senha);

      if (result.ok) {
        const imported = importFacapeToStudyFlow(result.data, STATE, save);
        renderDashboard?.();
        _updateAcademicProfile(result.data, uid);
        showToast(`✅ FACAPE conectado! ${imported.subjects} matérias e ${imported.classes} aulas importadas.`);
        _renderFacapeConnected(panel, result.data, uid, STATE, save, showToast, renderDashboard);

      } else if (result.needsManual) {
        // Portal inacessível — modo manual com feedback claro
        _setStatus('', '');
        _renderFacapeManual(panel, matricula, uid, STATE, save, showToast, renderDashboard);

      } else {
        _setStatus('❌ ' + (result.error || 'Credenciais incorretas. Tente novamente.'), 'error');
        btn.disabled = false;
        btn.textContent = '🔗 Conectar Portal FACAPE';
      }
    } catch (e) {
      _setStatus('❌ Erro inesperado: ' + e.message, 'error');
      btn.disabled = false;
      btn.textContent = '🔗 Conectar Portal FACAPE';
    }
  }

  function _setStatus(msg, type) {
    const el = document.getElementById('facape-status');
    if (!el) return;
    if (!msg) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    const styles = {
      info:    'background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.7)',
      warning: 'background:rgba(255,165,2,0.12);color:#ffa502;border:1px solid rgba(255,165,2,0.25)',
      error:   'background:rgba(224,82,82,0.12);color:#e05252;border:1px solid rgba(224,82,82,0.25)',
      success: 'background:rgba(46,213,115,0.12);color:#2ed573;border:1px solid rgba(46,213,115,0.25)',
    };
    el.style.cssText += ';border-radius:12px;padding:12px 14px;font-size:13px;' + (styles[type] || '');
    el.textContent = msg;
  }
}

// ── Tela de entrada manual (fallback quando portal inacessível) ───────────────

function _renderFacapeManual(panel, matricula, uid, STATE, save, showToast, renderDashboard) {
  panel.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:14px">

      <!-- Aviso explicativo com contexto claro -->
      <div style="padding:14px 16px;background:rgba(255,165,2,0.1);border:1px solid rgba(255,165,2,0.25);border-radius:14px">
        <div style="font-weight:700;color:#ffa502;font-size:13px;margin-bottom:4px">⚠️ Portal temporariamente inacessível</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.65);line-height:1.6">
          O portal da FACAPE está fora do ar ou bloqueando o acesso automático agora. Preencha seus dados abaixo manualmente para continuar usando o StudyFlow.
        </div>
      </div>

      <!-- Botão para abrir o portal -->
      <button onclick="window.open('https://sistemas.facape.br:8443/portalaluno/login.do','_blank')"
        style="background:#2c2c2e;border:1px solid rgba(255,255,255,0.12);color:#fff;border-radius:12px;padding:12px;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px">
        🌐 Abrir Portal FACAPE para consultar
      </button>

      <!-- Formulário manual com estilos corretos -->
      <div class="accs-form-group">
        <label class="accs-label">Nome Completo</label>
        <input id="facape-m-nome" class="accs-input" type="text"
          placeholder="Seu nome como aparece no portal">
      </div>
      <div class="accs-form-group">
        <label class="accs-label">Curso</label>
        <input id="facape-m-curso" class="accs-input" type="text"
          placeholder="Ex: Ciência da Computação">
      </div>
      <div class="accs-form-group">
        <label class="accs-label">Período / Semestre</label>
        <input id="facape-m-periodo" class="accs-input" type="text"
          placeholder="Ex: 5º Período">
      </div>
      <div class="accs-form-group">
        <label class="accs-label">Matérias do Semestre <span style="color:rgba(255,255,255,0.3);font-weight:400;text-transform:none;letter-spacing:0">(uma por linha)</span></label>
        <textarea id="facape-m-materias" class="accs-input"
          placeholder="Tecnologia da Informação e Sociedade&#10;Engenharia de Software&#10;Banco de Dados"
          style="min-height:110px"></textarea>
      </div>

      <button class="accs-save-btn" id="facape-m-save">
        💾 Salvar e Continuar
      </button>
      <button id="facape-m-cancel"
        style="background:none;border:none;color:rgba(255,255,255,0.35);font-size:13px;cursor:pointer;padding:8px;text-align:center">
        ← Voltar ao login
      </button>
    </div>
  `;

  document.getElementById('facape-m-save')?.addEventListener('click', () => {
    const nome     = document.getElementById('facape-m-nome')?.value?.trim() || `Aluno ${matricula}`;
    const curso    = document.getElementById('facape-m-curso')?.value?.trim() || '';
    const periodo  = document.getElementById('facape-m-periodo')?.value?.trim() || '';
    const raw      = document.getElementById('facape-m-materias')?.value?.trim() || '';
    const materias = raw.split('\n').map(m => m.trim()).filter(Boolean).map(n => ({ nome: n, codigo: '' }));

    const data = { nome, matricula, curso, periodo, materias, notas: [], horarios: [], manualEntry: true };
    saveFacapeData(data);

    const imported = importFacapeToStudyFlow(data, STATE, save);
    renderDashboard?.();
    _updateAcademicProfile(data, uid);
    showToast(`✅ Dados salvos! ${imported.subjects} matérias importadas.`);
    _renderFacapeConnected(panel, data, uid, STATE, save, showToast, renderDashboard);
  });

  document.getElementById('facape-m-cancel')?.addEventListener('click', () => {
    _renderFacapeLogin(panel, uid, STATE, save, showToast, renderDashboard);
  });
}

// ── Tela de conectado ─────────────────────────────────────────────────────────

function _renderFacapeConnected(panel, data, uid, STATE, save, showToast, renderDashboard) {
  const syncedAt = data.syncedAt
    ? new Date(data.syncedAt).toLocaleDateString('pt-BR', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })
    : '—';

  panel.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:14px">

      <!-- Status conectado -->
      <div style="display:flex;align-items:center;gap:14px;padding:18px;background:linear-gradient(135deg,#1a3a6e,#2d5fb8);border-radius:16px">
        <div style="width:48px;height:48px;border-radius:50%;background:#2ed573;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0">✓</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;color:#fff;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(data.nome || 'Aluno FACAPE')}</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.7);margin-top:2px">Matrícula: ${_esc(data.matricula || '—')}</div>
        </div>
        ${data.manualEntry ? '<span style="font-size:10px;background:rgba(255,165,2,0.2);color:#ffa502;border-radius:6px;padding:3px 8px;flex-shrink:0">Manual</span>' : '<span style="font-size:10px;background:rgba(46,213,115,0.2);color:#2ed573;border-radius:6px;padding:3px 8px;flex-shrink:0">Auto</span>'}
      </div>

      <!-- Info card -->
      <div style="background:#2c2c2e;border-radius:14px;padding:4px 0">
        ${_infoRow('Curso', data.curso || 'Não informado')}
        ${_infoRow('Período', data.periodo || 'Não informado')}
        ${_infoRow('Matérias importadas', String(data.materias?.length || 0))}
        ${_infoRow('Horários importados', String(data.horarios?.length || 0))}
        ${_infoRow('Última sincronização', syncedAt, true)}
      </div>

      ${data.notas?.length > 0 ? `
        <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:0.6px">Últimas Notas</div>
        <div style="background:#2c2c2e;border-radius:14px;padding:4px 0">
          ${data.notas.slice(0, 5).map(n => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.05)">
              <span style="font-size:13px;color:rgba(255,255,255,0.7);max-width:65%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(n.disciplina)}</span>
              <span style="font-weight:700;font-size:15px;color:${parseFloat(n.nota) >= 5 ? '#2ed573' : '#e05252'}">${_esc(n.nota)}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}

      <button class="accs-save-btn" id="facape-resync-btn" style="background:linear-gradient(135deg,#1a3a6e,#2d5fb8)">
        🔄 Sincronizar Novamente
      </button>
      <button id="facape-disconnect-btn"
        style="background:transparent;border:1.5px solid #e05252;color:#e05252;border-radius:12px;padding:12px;font-size:14px;font-weight:600;cursor:pointer">
        🔌 Desconectar Portal FACAPE
      </button>
    </div>
  `;

  document.getElementById('facape-resync-btn')?.addEventListener('click', async () => {
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
    } else if (result.needsManual) {
      showToast('⚠️ Portal inacessível. Seus dados locais estão preservados.');
      if (btn) { btn.disabled = false; btn.textContent = '🔄 Sincronizar Novamente'; }
    } else {
      showToast('❌ Erro ao sincronizar. Reconecte o portal.');
      if (btn) { btn.disabled = false; btn.textContent = '🔄 Sincronizar Novamente'; }
    }
  });

  document.getElementById('facape-disconnect-btn')?.addEventListener('click', () => {
    if (!confirm('Desconectar o Portal FACAPE? As matérias importadas serão mantidas.')) return;
    clearFacapeData();
    showToast('🔌 Portal FACAPE desconectado.');
    _renderFacapeLogin(panel, uid, STATE, save, showToast, renderDashboard);
  });
}

// ── Helpers internos ──────────────────────────────────────────────────────────

function _esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function _infoRow(label, value, small = false) {
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.05)">
      <span style="font-size:13px;color:rgba(255,255,255,0.5)">${label}</span>
      <span style="font-size:${small ? '11px' : '14px'};color:#fff;font-weight:500;max-width:55%;text-align:right">${value}</span>
    </div>
  `;
}

async function _updateAcademicProfile(data, uid) {
  if (!uid || !data) return;
  try {
    const { updateDoc, doc } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
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