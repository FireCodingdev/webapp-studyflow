// ===== ia.js — StudyFlow AI Vision Module =====
// Integra Google Gemini Vision para ler cronogramas em foto
// e preencher automaticamente matérias, aulas e atividades no app.
//
// COMO USAR: importe este arquivo em app.js com:
//   import { initIA } from './ia.js';
//   initIA(STATE, { save, renderSidebar, renderSchedule, renderDashboard, renderTasks, showToast, COLORS, DAYS });

// ─── CONFIG ─────────────────────────────────────────────────────────────────
// A chave NÃO fica aqui. Ela está protegida na Firebase Cloud Function.
// Troque pela URL da sua função após o deploy:
//   firebase deploy --only functions
//   A URL aparece no terminal: https://REGIÃO-PROJETO.cloudfunctions.net/geminiProxy
const PROXY_URL = 'https://geminiproxy-xesxvi757a-uc.a.run.app';

// ─── PROMPT ──────────────────────────────────────────────────────────────────
// O prompt de extração fica na Firebase Function (functions/index.js),
// não aqui no cliente. Isso evita que alguém o manipule pelo browser.

// ─── FUNÇÃO PRINCIPAL: ANALISAR IMAGEM ───────────────────────────────────────
/**
 * Converte um File/Blob de imagem para base64 e envia ao Gemini.
 * Retorna o JSON extraído ou lança um erro.
 */
async function analisarImagemCronograma(imageFile) {
  // Converte imagem para base64
  const base64    = await fileToBase64(imageFile);
  const mimeType  = imageFile.type || 'image/jpeg';

  // Pega o token de autenticação do usuário logado no Firebase
  // Isso prova ao servidor que é um usuário válido do app
  const { auth } = await import('./firebase.js');
  const user = auth.currentUser;
  if (!user) throw new Error('Você precisa estar logado para usar a IA.');
  const idToken = await user.getIdToken();

  // Chama a Firebase Function (proxy seguro) — a chave nunca fica no cliente
  const response = await fetch(PROXY_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${idToken}`,  // autenticação do usuário
    },
    body: JSON.stringify({ imageBase64: base64, mimeType }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error || `Erro no servidor: HTTP ${response.status}`);
  }

  if (data.erro) throw new Error(data.erro);

  return data;
}

// ─── CONVERTER FILE PARA BASE64 ───────────────────────────────────────────────
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('Falha ao ler imagem'));
    reader.readAsDataURL(file);
  });
}

// ─── APLICAR DADOS NO APP ────────────────────────────────────────────────────
/**
 * Recebe o JSON extraído pelo Gemini e injeta os dados no STATE do app,
 * criando matérias e aulas sem duplicatas.
 */
async function aplicarDadosNoApp(dadosIA, STATE, hooks) {
  const { save, renderSidebar, renderSchedule, renderDashboard, COLORS, DAYS } = hooks;

  if (dadosIA.erro) throw new Error(dadosIA.erro);

  const materias  = dadosIA.materias || [];
  const aulas     = dadosIA.aulas    || [];
  let   novasM    = 0;
  let   novasA    = 0;
  let   duplicM   = 0;
  let   duplicA   = 0;

  // 1. Criar matérias (evita duplicatas por nome)
  const mapaMateria = {}; // nome → id interno no STATE

  // Indexa as já existentes
  STATE.subjects.forEach(s => {
    mapaMateria[s.name.toLowerCase().trim()] = s.id;
  });

  materias.forEach((m, idx) => {
    const chave = m.nome.toLowerCase().trim();
    if (mapaMateria[chave]) {
      duplicM++;
      return; // já existe
    }
    const cor = COLORS[STATE.subjects.length % COLORS.length];
    const novaId = `ia_${Date.now()}_${idx}`;
    STATE.subjects.push({
      id:    novaId,
      name:  m.nome.trim(),
      color: cor,
      links: [],
    });
    mapaMateria[chave] = novaId;
    novasM++;
  });

  // 2. Criar aulas (evita duplicatas por matéria+dia+horário)
  const aulaExistente = (subjectId, dia, inicio) =>
    STATE.classes.some(c => c.subjectId === subjectId && c.day === dia && c.start === inicio);

  aulas.forEach((a, idx) => {
    if (a.materia == null || a.dia == null || a.inicio == null) return;

    const chave    = a.materia.toLowerCase().trim();
    const subId    = mapaMateria[chave];
    if (!subId) return; // matéria não encontrada

    if (aulaExistente(subId, a.dia, a.inicio)) {
      duplicA++;
      return;
    }

    // Calcula fim automaticamente se não informado (padrão +1h)
    let fim = a.fim;
    if (!fim || fim <= a.inicio) {
      const [h, min] = a.inicio.split(':').map(Number);
      fim = `${String(h + 1).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    }

    const subject = STATE.subjects.find(s => s.id === subId);
    STATE.classes.push({
      id:           `ia_cls_${Date.now()}_${idx}`,
      subjectId:    subId,
      subjectName:  subject?.name  || a.materia,
      subjectColor: subject?.color || '#6c63ff',
      day:          a.dia,
      start:        a.inicio,
      end:          fim,
      room:         a.sala || '',
    });
    novasA++;
  });

  // 3. Salva e atualiza a UI
  await save();
  renderSidebar();
  renderSchedule();
  renderDashboard();

  return { novasM, novasA, duplicM, duplicA, obs: dadosIA.observacoes };
}

// ─── MODAL DE UPLOAD ──────────────────────────────────────────────────────────
/**
 * Abre o modal de "Importar Cronograma por Foto".
 * Chamado pelo botão que você adicionar no index.html.
 */
export function abrirModalImportarCronograma(STATE, hooks) {
  const { openModal, closeModal, showToast } = hooks;

  openModal('📸 Importar Cronograma por Foto', `
    <div class="ia-upload-area" id="ia-drop-zone">
      <div class="ia-upload-icon">📷</div>
      <p class="ia-upload-title">Tire uma foto do seu cronograma</p>
      <p class="ia-upload-sub">A IA vai ler as matérias, dias e horários automaticamente</p>
      <input
        type="file"
        id="ia-file-input"
        accept="image/*"
        capture="environment"
        style="display:none"
      />
      <button class="btn-primary ia-upload-btn" onclick="document.getElementById('ia-file-input').click()">
        Escolher foto / câmera
      </button>
    </div>

    <div id="ia-preview-area" style="display:none">
      <img id="ia-preview-img" class="ia-preview-img" alt="Preview" />
      <div id="ia-status" class="ia-status"></div>
      <div id="ia-result-area" style="display:none"></div>
    </div>
  `);

  // Listener de seleção de arquivo
  setTimeout(() => {
    const input   = document.getElementById('ia-file-input');
    const dropZone = document.getElementById('ia-drop-zone');

    if (!input) return;

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) processarArquivo(file, STATE, hooks);
    });

    // Suporte a drag & drop no desktop
    dropZone?.addEventListener('dragover', e => {
      e.preventDefault();
      dropZone.classList.add('ia-drag-over');
    });
    dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('ia-drag-over'));
    dropZone?.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('ia-drag-over');
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith('image/')) {
        processarArquivo(file, STATE, hooks);
      }
    });
  }, 0);
}

// ─── PROCESSAR ARQUIVO SELECIONADO ───────────────────────────────────────────
async function processarArquivo(file, STATE, hooks) {
  const { closeModal, showToast } = hooks;

  const dropZone    = document.getElementById('ia-drop-zone');
  const previewArea = document.getElementById('ia-preview-area');
  const previewImg  = document.getElementById('ia-preview-img');
  const statusEl    = document.getElementById('ia-status');
  const resultArea  = document.getElementById('ia-result-area');

  if (!previewArea || !statusEl) return;

  // Mostra preview
  previewImg.src    = URL.createObjectURL(file);
  dropZone.style.display    = 'none';
  previewArea.style.display = 'block';

  setStatus(statusEl, 'analyzing', '🔍 Analisando imagem com IA...');

  try {
    // Chama o Gemini Vision
    const dadosIA = await analisarImagemCronograma(file);

    // Mostra resumo antes de confirmar
    const { materias = [], aulas = [], observacoes } = dadosIA;

    if (dadosIA.erro) {
      setStatus(statusEl, 'error', `❌ ${dadosIA.erro}`);
      return;
    }

    setStatus(statusEl, 'success', `✅ Encontradas ${materias.length} matérias e ${aulas.length} aulas`);

    // Monta preview dos dados extraídos
    resultArea.style.display = 'block';
    resultArea.innerHTML = `
      <div class="ia-extracted">
        <h4 class="ia-section-title">Matérias encontradas</h4>
        <div class="ia-chips">
          ${materias.map(m => `<span class="ia-chip">${m.nome}</span>`).join('') || '<em style="color:var(--text2)">Nenhuma</em>'}
        </div>

        <h4 class="ia-section-title">Aulas encontradas</h4>
        <div class="ia-aulas-list">
          ${aulas.map(a => `
            <div class="ia-aula-item">
              <span class="ia-aula-nome">${a.materia}</span>
              <span class="ia-aula-meta">${['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'][a.dia] ?? '?'} · ${a.inicio}–${a.fim || '?'}${a.sala ? ' · ' + a.sala : ''}</span>
            </div>
          `).join('') || '<em style="color:var(--text2)">Nenhuma</em>'}
        </div>

        ${observacoes ? `<p class="ia-obs">💡 ${observacoes}</p>` : ''}

        <div class="ia-action-row">
          <button class="btn-secondary" onclick="document.getElementById('ia-file-input').click()">
            Tentar outra foto
          </button>
          <button class="btn-primary" id="ia-confirm-btn">
            ✅ Importar tudo
          </button>
        </div>
      </div>
    `;

    // Botão de confirmação
    document.getElementById('ia-confirm-btn')?.addEventListener('click', async () => {
      setStatus(statusEl, 'analyzing', '💾 Salvando dados no app...');
      resultArea.style.display = 'none';

      try {
        const resultado = await aplicarDadosNoApp(dadosIA, STATE, hooks);
        closeModal();

        const msg = [
          resultado.novasM > 0 ? `${resultado.novasM} matéria(s) criada(s)` : '',
          resultado.novasA > 0 ? `${resultado.novasA} aula(s) adicionada(s)` : '',
          resultado.duplicM > 0 || resultado.duplicA > 0
            ? `(${resultado.duplicM + resultado.duplicA} ignorados por já existirem)`
            : '',
        ].filter(Boolean).join(' · ');

        showToast(`🎉 Importado! ${msg}`);
        hooks.navigateTo?.('schedule');
      } catch (err) {
        setStatus(statusEl, 'error', `❌ Erro ao salvar: ${err.message}`);
        resultArea.style.display = 'block';
      }
    });

  } catch (err) {
    setStatus(statusEl, 'error', `❌ ${err.message}`);
    // Botão de retry
    resultArea.style.display = 'block';
    resultArea.innerHTML = `
      <div class="ia-action-row" style="margin-top:8px">
        <button class="btn-primary" onclick="document.getElementById('ia-file-input').click()">
          Tentar novamente
        </button>
      </div>
    `;
  }
}

// ─── HELPER DE STATUS ─────────────────────────────────────────────────────────
function setStatus(el, type, text) {
  el.className = `ia-status ia-status--${type}`;
  el.textContent = text;
}

// ─── INIT: registra o módulo no app ──────────────────────────────────────────
/**
 * Chame initIA() no final do app.js após o app estar carregado.
 * Isso adiciona o botão de importar IA no cronograma e no dashboard.
 */
export function initIA(STATE, hooks) {
  // Expõe globalmente para os onclick no HTML
  window.abrirImportarCronograma = () => abrirModalImportarCronograma(STATE, hooks);

  // Adiciona o botão "Importar por foto" na página de cronograma
  // (injetado dinamicamente para não exigir alteração no HTML)
  function injetarBotaoIA() {
    // Evita duplicatas
    if (document.getElementById('ia-import-btn')) return;

    const scheduleHeader = document.querySelector('#page-schedule .days-scroll');
    if (!scheduleHeader) return;

    const btn = document.createElement('button');
    btn.id        = 'ia-import-btn';
    btn.className = 'ia-fab-btn';
    btn.title     = 'Importar cronograma por foto';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
        <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/>
        <circle cx="12" cy="13" r="4"/>
      </svg>
      <span>Importar foto</span>
    `;
    btn.addEventListener('click', () => abrirModalImportarCronograma(STATE, hooks));
    scheduleHeader.insertAdjacentElement('afterend', btn);
  }

  // Observa mudanças de página para injetar o botão
  const observer = new MutationObserver(() => {
    const schedulePage = document.getElementById('page-schedule');
    if (schedulePage?.classList.contains('active')) injetarBotaoIA();
  });

  observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });

  // Injeta imediatamente se já estiver na página de cronograma
  injetarBotaoIA();
}

// ─── CSS INJETADO DINAMICAMENTE ───────────────────────────────────────────────
// Evita a necessidade de editar o styles.css
(function injetarEstilosIA() {
  if (document.getElementById('ia-styles')) return;
  const style = document.createElement('style');
  style.id = 'ia-styles';
  style.textContent = `
    /* Botão de importar foto no cronograma */
    #ia-import-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 12px 0 4px;
      padding: 10px 18px;
      background: rgba(108, 99, 255, 0.12);
      border: 1px dashed rgba(108, 99, 255, 0.5);
      border-radius: 12px;
      color: rgba(108, 99, 255, 0.95);
      font-weight: 700;
      font-size: 14px;
      cursor: pointer;
      width: 100%;
      transition: background 0.2s, border-color 0.2s;
    }
    #ia-import-btn:hover {
      background: rgba(108, 99, 255, 0.2);
      border-color: rgba(108, 99, 255, 0.8);
    }

    /* Área de drop/upload */
    .ia-upload-area {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      padding: 28px 16px;
      border: 2px dashed rgba(108, 99, 255, 0.4);
      border-radius: 14px;
      text-align: center;
      transition: border-color 0.2s, background 0.2s;
    }
    .ia-upload-area.ia-drag-over {
      border-color: rgba(108, 99, 255, 0.9);
      background: rgba(108, 99, 255, 0.07);
    }
    .ia-upload-icon { font-size: 42px; line-height: 1; }
    .ia-upload-title {
      font-weight: 700;
      font-size: 15px;
      color: var(--text);
      margin: 0;
    }
    .ia-upload-sub {
      font-size: 12px;
      color: var(--text2);
      margin: 0;
    }
    .ia-upload-btn { margin-top: 6px; padding: 12px 24px; }

    /* Preview da imagem */
    .ia-preview-img {
      width: 100%;
      max-height: 200px;
      object-fit: cover;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.08);
      margin-bottom: 10px;
    }

    /* Status de processamento */
    .ia-status {
      font-size: 13px;
      font-weight: 700;
      padding: 8px 14px;
      border-radius: 8px;
      text-align: center;
      margin: 6px 0;
    }
    .ia-status--analyzing {
      background: rgba(108, 99, 255, 0.1);
      color: rgba(108, 99, 255, 0.95);
      animation: ia-pulse 1.2s ease-in-out infinite;
    }
    .ia-status--success {
      background: rgba(46, 213, 115, 0.1);
      color: #2ed573;
    }
    .ia-status--error {
      background: rgba(255, 71, 87, 0.1);
      color: #ff4757;
    }
    @keyframes ia-pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.65; }
    }

    /* Dados extraídos */
    .ia-extracted { display: flex; flex-direction: column; gap: 10px; margin-top: 8px; }
    .ia-section-title {
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text2);
      margin: 4px 0 2px;
    }
    .ia-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .ia-chip {
      background: rgba(108,99,255,0.12);
      color: rgba(108,99,255,0.95);
      border: 1px solid rgba(108,99,255,0.25);
      border-radius: 999px;
      padding: 4px 12px;
      font-size: 12px;
      font-weight: 700;
    }
    .ia-aulas-list { display: flex; flex-direction: column; gap: 6px; }
    .ia-aula-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px;
      padding: 8px 12px;
      gap: 8px;
    }
    .ia-aula-nome { font-weight: 700; font-size: 13px; color: var(--text); }
    .ia-aula-meta { font-size: 12px; color: var(--text2); white-space: nowrap; }
    .ia-obs {
      font-size: 12px;
      color: var(--text2);
      background: rgba(255,165,2,0.08);
      border: 1px solid rgba(255,165,2,0.2);
      border-radius: 8px;
      padding: 8px 12px;
    }
    .ia-action-row {
      display: flex;
      gap: 10px;
      margin-top: 6px;
    }
    .ia-action-row .btn-secondary {
      flex: 1;
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm, 8px);
      background: var(--bg3);
      color: var(--text2);
      font-weight: 700;
      cursor: pointer;
    }
    .ia-action-row .btn-primary { flex: 1.5; }
  `;
  document.head.appendChild(style);
})();