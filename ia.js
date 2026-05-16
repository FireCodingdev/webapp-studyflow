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
  const { auth, getAppCheckToken } = await import('./firebase.js');
  const user = auth.currentUser;
  if (!user) throw new Error('Você precisa estar logado para usar a IA.');
  const [idToken, appCheckToken] = await Promise.all([
    user.getIdToken(),
    getAppCheckToken(),
  ]);

  // Chama a Firebase Function (proxy seguro) — a chave nunca fica no cliente
  const response = await fetch(PROXY_URL, {
    method: 'POST',
    headers: {
      'Content-Type':        'application/json',
      'Authorization':       `Bearer ${idToken}`,
      'X-Firebase-AppCheck': appCheckToken,
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
        id="ia-file-input-camera"
        accept="image/*"
        capture="environment"
        style="display:none"
      />
      <input
        type="file"
        id="ia-file-input-gallery"
        accept="image/*"
        style="display:none"
      />
      <div class="ia-upload-btns">
        <button class="btn-primary ia-upload-btn" onclick="document.getElementById('ia-file-input-camera').click()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
          Tirar foto
        </button>
        <button class="btn-secondary ia-upload-btn ia-upload-btn-gallery" onclick="document.getElementById('ia-file-input-gallery').click()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          Escolher da galeria
        </button>
      </div>
    </div>

    <div id="ia-preview-area" style="display:none">
      <img id="ia-preview-img" class="ia-preview-img" alt="Preview" />
      <div id="ia-status" class="ia-status"></div>
      <div id="ia-result-area" style="display:none"></div>
    </div>
  `);

  // Listener de seleção de arquivo
  setTimeout(() => {
    const inputCamera  = document.getElementById('ia-file-input-camera');
    const inputGallery = document.getElementById('ia-file-input-gallery');
    const dropZone     = document.getElementById('ia-drop-zone');

    if (!inputCamera && !inputGallery) return;

    [inputCamera, inputGallery].forEach(input => {
      input?.addEventListener('change', () => {
        const file = input.files?.[0];
        if (file) processarArquivo(file, STATE, hooks);
      });
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
  window.abrirImportarSillabus   = () => abrirModalImportarSillabus(STATE, hooks);

  // Adiciona o botão "Importar por foto" na página de cronograma
  // (injetado dinamicamente para não exigir alteração no HTML)
  function injetarBotaoIA() {
    // Evita duplicatas
    if (document.getElementById('ia-import-btn')) return;

    const scheduleHeader = document.getElementById('schedule-calendar');
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
      <span>Importar Horário de Aulas</span>
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

  // ── Botão de provas na aba Atividades ──────────────────────────────────────
  function injetarBotaoProvas() {
    if (document.getElementById('ia-exams-btn')) return;

    // Botão agora fica na aba Cronograma, abaixo do botão de sillabus
    const scheduleHeader = document.getElementById('schedule-calendar');
    if (!scheduleHeader) return;

    const btn = document.createElement('button');
    btn.id        = 'ia-exams-btn';
    btn.className = 'ia-fab-btn ia-fab-btn--provas';
    btn.title     = 'Importar calendário de provas por foto';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
        <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>
        <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>
      </svg>
      <span>Importar Calendário de Provas</span>
    `;
    btn.addEventListener('click', () => abrirModalImportarProvas(STATE, hooks));
    // Insere abaixo do botão de sillabus (ou do de foto se sillabus não existir)
    const sillabusBtn = document.getElementById('ia-sillabus-btn');
    const fotoBtn = document.getElementById('ia-import-btn');
    const anchor = sillabusBtn || fotoBtn;
    if (anchor) {
      anchor.insertAdjacentElement('afterend', btn);
    } else {
      scheduleHeader.insertAdjacentElement('afterend', btn);
    }
  }

  // Observa mudanças de página de cronograma para injetar o botão de provas
  const observerProvas = new MutationObserver(() => {
    const schedulePage = document.getElementById('page-schedule');
    if (schedulePage?.classList.contains('active')) injetarBotaoProvas();
  });
  observerProvas.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
  injetarBotaoProvas();

  // ── Botão de cronograma detalhado (sillabus) na aba Cronograma ─────────────
  function injetarBotaoSillabus() {
    if (document.getElementById('ia-sillabus-btn')) return;
    const scheduleHeader = document.getElementById('schedule-calendar');
    if (!scheduleHeader) return;

    const btn = document.createElement('button');
    btn.id        = 'ia-sillabus-btn';
    btn.className = 'ia-fab-btn ia-fab-btn--sillabus';
    btn.title     = 'Importar cronograma de conteúdo (plano de ensino)';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
        <polyline points="10 9 9 9 8 9"/>
      </svg>
      <span>Importar Cronograma de Aulas</span>
    `;
    btn.addEventListener('click', () => abrirModalImportarSillabus(STATE, hooks));
    // Insere abaixo do botão de foto de cronograma
    const existingBtn = document.getElementById('ia-import-btn');
    if (existingBtn) {
      existingBtn.insertAdjacentElement('afterend', btn);
    } else {
      scheduleHeader.insertAdjacentElement('afterend', btn);
    }
  }

  const observerSillabus = new MutationObserver(() => {
    const schedulePage = document.getElementById('page-schedule');
    if (schedulePage?.classList.contains('active')) injetarBotaoSillabus();
  });
  observerSillabus.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
  injetarBotaoSillabus();
}

// ─── MODAL DE PROVAS ─────────────────────────────────────────────────────────
export function abrirModalImportarProvas(STATE, hooks) {
  const { openModal } = hooks;

  openModal('📅 Importar Calendário de Provas', `
    <div class="ia-upload-area" id="ia-exams-drop-zone">
      <div class="ia-upload-icon">📋</div>
      <p class="ia-upload-title">Foto do calendário de provas</p>
      <p class="ia-upload-sub">A IA vai extrair todas as datas e criar as atividades automaticamente</p>
      <input type="file" id="ia-exams-input-camera"  accept="image/*" capture="environment" style="display:none" />
      <input type="file" id="ia-exams-input-gallery" accept="image/*" style="display:none" />
      <div class="ia-upload-btns">
        <button class="btn-primary ia-upload-btn" onclick="document.getElementById('ia-exams-input-camera').click()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
          Tirar foto
        </button>
        <button class="btn-secondary ia-upload-btn ia-upload-btn-gallery" onclick="document.getElementById('ia-exams-input-gallery').click()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          Escolher da galeria
        </button>
      </div>
    </div>

    <div id="ia-exams-preview-area" style="display:none">
      <img id="ia-exams-preview-img" class="ia-preview-img" alt="Preview" />
      <div id="ia-exams-status" class="ia-status"></div>
      <div id="ia-exams-result-area" style="display:none"></div>
    </div>
  `);

  setTimeout(() => {
    const cam = document.getElementById('ia-exams-input-camera');
    const gal = document.getElementById('ia-exams-input-gallery');
    const drop = document.getElementById('ia-exams-drop-zone');

    [cam, gal].forEach(input => {
      input?.addEventListener('change', () => {
        const file = input.files?.[0];
        if (file) processarArquivoProvas(file, STATE, hooks);
      });
    });

    drop?.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('ia-drag-over'); });
    drop?.addEventListener('dragleave', () => drop.classList.remove('ia-drag-over'));
    drop?.addEventListener('drop', e => {
      e.preventDefault();
      drop.classList.remove('ia-drag-over');
      const file = e.dataTransfer?.files?.[0];
      if (file?.type.startsWith('image/')) processarArquivoProvas(file, STATE, hooks);
    });
  }, 0);
}

async function processarArquivoProvas(file, STATE, hooks) {
  const { closeModal, showToast } = hooks;

  const dropZone    = document.getElementById('ia-exams-drop-zone');
  const previewArea = document.getElementById('ia-exams-preview-area');
  const previewImg  = document.getElementById('ia-exams-preview-img');
  const statusEl    = document.getElementById('ia-exams-status');
  const resultArea  = document.getElementById('ia-exams-result-area');
  if (!previewArea || !statusEl) return;

  previewImg.src            = URL.createObjectURL(file);
  dropZone.style.display    = 'none';
  previewArea.style.display = 'block';
  setStatus(statusEl, 'analyzing', '🔍 Analisando calendário com IA...');

  try {
    // Chama o proxy com mode=exams
    const base64   = await fileToBase64(file);
    const mimeType = file.type || 'image/jpeg';
    const { auth } = await import('./firebase.js');
    const idToken  = await auth.currentUser?.getIdToken();
    if (!idToken) throw new Error('Você precisa estar logado.');

    const response = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
      body: JSON.stringify({ imageBase64: base64, mimeType, mode: 'exams' }),
    });
    const dadosIA = await response.json();
    if (!response.ok) throw new Error(dadosIA?.error || `Erro HTTP ${response.status}`);
    if (dadosIA.erro) throw new Error(dadosIA.erro);

    const provas = dadosIA.provas || [];
    if (provas.length === 0) {
      setStatus(statusEl, 'error', '❌ Nenhuma prova encontrada na imagem.');
      return;
    }

    setStatus(statusEl, 'success', `✅ ${provas.length} prova(s) encontrada(s)`);

    resultArea.style.display = 'block';
    resultArea.innerHTML = `
      <div class="ia-extracted">
        <h4 class="ia-section-title">Provas encontradas</h4>
        <div class="ia-aulas-list">
          ${provas.map(p => `
            <div class="ia-aula-item">
              <span class="ia-aula-nome">${p.materia}</span>
              <span class="ia-aula-meta">${p.tipo} · ${formatarDataProva(p.data)}</span>
            </div>
          `).join('')}
        </div>
        ${dadosIA.observacoes ? `<p class="ia-obs">💡 ${dadosIA.observacoes}</p>` : ''}
        <div class="ia-action-row">
          <button class="btn-primary" id="ia-exams-confirm-btn">✅ Importar provas</button>
        </div>
      </div>
    `;

    document.getElementById('ia-exams-confirm-btn')?.addEventListener('click', async () => {
      setStatus(statusEl, 'analyzing', '💾 Criando atividades...');
      resultArea.style.display = 'none';
      try {
        const { novas, duplicadas } = await aplicarProvasNoApp(provas, STATE, hooks);
        closeModal();
        const msg = [
          novas > 0      ? `${novas} prova(s) criada(s)` : '',
          duplicadas > 0 ? `${duplicadas} já existiam` : '',
        ].filter(Boolean).join(' · ');
        showToast(`🎉 Importado! ${msg}`);
        hooks.navigateTo?.('tasks');
      } catch (err) {
        setStatus(statusEl, 'error', `❌ Erro ao salvar: ${err.message}`);
        resultArea.style.display = 'block';
      }
    });

  } catch (err) {
    setStatus(statusEl, 'error', `❌ ${err.message}`);
    resultArea.style.display = 'block';
    resultArea.innerHTML = `
      <div class="ia-action-row" style="margin-top:8px">
        <button class="btn-primary" onclick="document.getElementById('ia-exams-input-gallery').click()">Tentar novamente</button>
      </div>`;
  }
}

async function aplicarProvasNoApp(provas, STATE, hooks) {
  const { save, renderTasks, renderDashboard } = hooks;
  let novas = 0, duplicadas = 0;

  for (const p of provas) {
    if (!p.materia || !p.data) continue;

    // Verifica duplicata: mesma matéria + mesmo tipo + mesma data
    const jáExiste = STATE.tasks.some(t =>
      t.source === 'ia-exams' &&
      t.title === `${p.tipo} — ${p.materia}` &&
      t.deadline === p.data
    );
    if (jáExiste) { duplicadas++; continue; }

    // Tenta associar a uma matéria existente
    const subject = STATE.subjects.find(s =>
      p.materia.toLowerCase().includes(s.name.toLowerCase()) ||
      s.name.toLowerCase().includes(p.materia.toLowerCase())
    );

    STATE.tasks.push({
      id:           `ia_exam_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      title:        `${p.tipo} — ${p.materia}`,
      subjectId:    subject?.id    || null,
      subjectName:  subject?.name  || p.materia,
      subjectColor: subject?.color || '#ff6584',
      type:         'exam',
      deadline:     p.data,
      notes:        null,
      done:         false,
      createdAt:    new Date().toISOString(),
      source:       'ia-exams',
    });
    novas++;
  }

  await save();
  renderTasks();
  renderDashboard();
  return { novas, duplicadas };
}

function formatarDataProva(isoDate) {
  if (!isoDate) return '?';
  try {
    return new Date(isoDate + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return isoDate; }
}

// ─── MODAL CRONOGRAMA DETALHADO (SILLABUS) ───────────────────────────────────
export function abrirModalImportarSillabus(STATE, hooks) {
  const { openModal } = hooks;

  openModal('📚 Importar Plano de Aulas', `
    <div class="ia-upload-area" id="ia-sil-drop-zone">
      <div class="ia-upload-icon">📄</div>
      <p class="ia-upload-title">Foto do cronograma de conteúdo</p>
      <p class="ia-upload-sub">A IA vai extrair cada aula com data, conteúdo e referências bibliográficas</p>
      <input type="file" id="ia-sil-input-camera"  accept="image/*" capture="environment" style="display:none" />
      <input type="file" id="ia-sil-input-gallery" accept="image/*" style="display:none" />
      <div class="ia-upload-btns">
        <button class="btn-primary ia-upload-btn" onclick="document.getElementById('ia-sil-input-camera').click()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
          Tirar foto
        </button>
        <button class="btn-secondary ia-upload-btn" onclick="document.getElementById('ia-sil-input-gallery').click()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          Galeria
        </button>
      </div>
    </div>
    <div id="ia-sil-preview-area" style="display:none">
      <img id="ia-sil-preview-img" class="ia-preview-img" alt="Preview" />
      <div id="ia-sil-status" class="ia-status"></div>
      <div id="ia-sil-result-area" style="display:none"></div>
    </div>
  `);

  setTimeout(() => {
    const cam  = document.getElementById('ia-sil-input-camera');
    const gal  = document.getElementById('ia-sil-input-gallery');
    const drop = document.getElementById('ia-sil-drop-zone');

    [cam, gal].forEach(inp => {
      inp?.addEventListener('change', () => {
        const file = inp.files?.[0];
        if (file) processarArquivoSillabus(file, STATE, hooks);
      });
    });

    drop?.addEventListener('dragover',  e => { e.preventDefault(); drop.classList.add('ia-drag-over'); });
    drop?.addEventListener('dragleave', () => drop.classList.remove('ia-drag-over'));
    drop?.addEventListener('drop', e => {
      e.preventDefault();
      drop.classList.remove('ia-drag-over');
      const file = e.dataTransfer?.files?.[0];
      if (file?.type.startsWith('image/')) processarArquivoSillabus(file, STATE, hooks);
    });
  }, 0);
}

async function processarArquivoSillabus(file, STATE, hooks) {
  const { closeModal, showToast } = hooks;

  const dropZone    = document.getElementById('ia-sil-drop-zone');
  const previewArea = document.getElementById('ia-sil-preview-area');
  const previewImg  = document.getElementById('ia-sil-preview-img');
  const statusEl    = document.getElementById('ia-sil-status');
  const resultArea  = document.getElementById('ia-sil-result-area');
  if (!previewArea || !statusEl) return;

  previewImg.src            = URL.createObjectURL(file);
  dropZone.style.display    = 'none';
  previewArea.style.display = 'block';
  setStatus(statusEl, 'analyzing', '🔍 Lendo plano de aulas com IA...');

  try {
    const base64   = await fileToBase64(file);
    const mimeType = file.type || 'image/jpeg';
    const { auth } = await import('./firebase.js');
    const idToken  = await auth.currentUser?.getIdToken();
    if (!idToken) throw new Error('Você precisa estar logado.');

    const response = await fetch(PROXY_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
      body:    JSON.stringify({ imageBase64: base64, mimeType, mode: 'syllabi' }),
    });
    const dadosIA = await response.json();
    if (!response.ok) throw new Error(dadosIA?.error || `Erro HTTP ${response.status}`);
    if (dadosIA.erro) throw new Error(dadosIA.erro);

    const aulas      = dadosIA.aulas      || [];
    const avaliacoes = dadosIA.avaliacoes || [];
    const disciplina = dadosIA.disciplina || 'Disciplina';

    if (aulas.length === 0 && avaliacoes.length === 0) {
      setStatus(statusEl, 'error', '❌ Nenhuma aula encontrada na imagem.');
      return;
    }

    setStatus(statusEl, 'success',
      `✅ ${aulas.length} aula(s) e ${avaliacoes.length} avaliação(ões) encontradas`);

    // Matéria correspondente
    const subjectMatch = STATE.subjects.find(s =>
      disciplina.toLowerCase().includes(s.name.toLowerCase()) ||
      s.name.toLowerCase().includes(disciplina.toLowerCase())
    );

    resultArea.style.display = 'block';
    resultArea.innerHTML = `
      <div class="ia-extracted">
        <div class="ia-sil-header">
          <span class="ia-chip ia-chip--purple">📚 ${disciplina}</span>
          ${dadosIA.professor ? `<span class="ia-chip">👤 ${dadosIA.professor}</span>` : ''}
          ${dadosIA.turno     ? `<span class="ia-chip">🌙 ${dadosIA.turno}</span>`    : ''}
        </div>

        ${!subjectMatch ? `
          <div class="ia-sil-warning">
            ⚠️ Matéria "<strong>${disciplina}</strong>" não encontrada no app.
            Ela será criada automaticamente.
          </div>
        ` : ''}

        ${aulas.length > 0 ? `
          <h4 class="ia-section-title">Aulas (${aulas.length})</h4>
          <div class="ia-sil-list">
            ${aulas.slice(0, 5).map(a => `
              <div class="ia-sil-item">
                <span class="ia-sil-date">${formatarDataProva(a.data)}</span>
                <span class="ia-sil-content">${a.conteudo || '—'}</span>
                ${a.referencia ? `<span class="ia-sil-ref">📖 ${a.referencia.slice(0,60)}${a.referencia.length>60?'…':''}</span>` : ''}
              </div>
            `).join('')}
            ${aulas.length > 5 ? `<p class="ia-obs">+ ${aulas.length - 5} aulas a mais...</p>` : ''}
          </div>
        ` : ''}

        ${avaliacoes.length > 0 ? `
          <h4 class="ia-section-title">Avaliações (${avaliacoes.length})</h4>
          <div class="ia-aulas-list">
            ${avaliacoes.map(av => `
              <div class="ia-aula-item">
                <span class="ia-aula-nome">${av.nome}</span>
                <span class="ia-aula-meta">${av.tipo} · ${formatarDataProva(av.data)}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}

        ${dadosIA.observacoes ? `<p class="ia-obs">💡 ${dadosIA.observacoes}</p>` : ''}

        <h4 class="ia-section-title">O que deseja importar?</h4>
        <div class="ia-sil-destinos">
          ${aulas.length > 0 ? `
            <label class="ia-sil-check">
              <input type="checkbox" id="sil-chk-tasks" checked>
              <span>📝 Criar tarefas com o conteúdo de cada aula</span>
            </label>
          ` : ''}
          ${avaliacoes.length > 0 ? `
            <label class="ia-sil-check">
              <input type="checkbox" id="sil-chk-provas" checked>
              <span>📅 Criar provas/avaliações nas Atividades</span>
            </label>
          ` : ''}
        </div>

        <div class="ia-action-row">
          <button class="btn-secondary" onclick="document.getElementById('ia-sil-input-gallery').click()">
            Outra foto
          </button>
          <button class="btn-primary" id="ia-sil-confirm-btn">
            ✅ Importar
          </button>
        </div>
      </div>
    `;

    document.getElementById('ia-sil-confirm-btn')?.addEventListener('click', async () => {
      const importTasks  = document.getElementById('sil-chk-tasks')?.checked  ?? false;
      const importProvas = document.getElementById('sil-chk-provas')?.checked ?? false;

      if (!importTasks && !importProvas) {
        showToast('Selecione pelo menos uma opção'); return;
      }

      setStatus(statusEl, 'analyzing', '💾 Salvando dados...');
      resultArea.style.display = 'none';

      try {
        const resultado = await aplicarSillabusNoApp(
          dadosIA, STATE, hooks,
          { importTasks, importProvas }
        );
        closeModal();

        const partes = [
          resultado.tarefas  > 0 ? `${resultado.tarefas} tarefa(s) criada(s)` : '',
          resultado.provas   > 0 ? `${resultado.provas} prova(s) criada(s)` : '',
          resultado.dupl     > 0 ? `${resultado.dupl} já existiam` : '',
        ].filter(Boolean).join(' · ');

        showToast(`🎉 Importado! ${partes}`);
        if (importProvas) hooks.navigateTo?.('tasks');
      } catch (err) {
        setStatus(statusEl, 'error', `❌ Erro ao salvar: ${err.message}`);
        resultArea.style.display = 'block';
      }
    });

  } catch (err) {
    setStatus(statusEl, 'error', `❌ ${err.message}`);
    resultArea.style.display = 'block';
    resultArea.innerHTML = `
      <div class="ia-action-row" style="margin-top:8px">
        <button class="btn-primary" onclick="document.getElementById('ia-sil-input-gallery').click()">Tentar novamente</button>
      </div>`;
  }
}

async function aplicarSillabusNoApp(dadosIA, STATE, hooks, opcoes) {
  const { save, renderTasks, renderDashboard, COLORS } = hooks;
  const { importTasks, importProvas } = opcoes;
  let tarefas = 0, provas = 0, dupl = 0;

  const disciplina = dadosIA.disciplina || 'Disciplina Importada';
  const aulasIA    = dadosIA.aulas      || [];
  const avalIA     = dadosIA.avaliacoes || [];

  // Garante que a matéria existe
  let subject = STATE.subjects.find(s =>
    disciplina.toLowerCase().includes(s.name.toLowerCase()) ||
    s.name.toLowerCase().includes(disciplina.toLowerCase())
  );

  if (!subject) {
    const cor    = COLORS[STATE.subjects.length % COLORS.length];
    const novoId = `ia_sil_${Date.now()}`;
    subject = { id: novoId, name: disciplina, color: cor, links: [] };
    STATE.subjects.push(subject);
  }

  // Importa aulas como tarefas de "estudo"
  if (importTasks) {
    for (const aula of aulasIA) {
      if (!aula.conteudo || !aula.data) continue;

      const titulo = `Aula ${aula.numeros ? `${aula.numeros} — ` : ''}${aula.conteudo.slice(0, 60)}${aula.conteudo.length > 60 ? '…' : ''}`;

      const jaExiste = STATE.tasks.some(t =>
        t.source === 'ia-sillabus' &&
        t.deadline === aula.data &&
        t.subjectId === subject.id
      );
      if (jaExiste) { dupl++; continue; }

      STATE.tasks.push({
        id:           `ia_sil_task_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
        title:        titulo,
        subjectId:    subject.id,
        subjectName:  subject.name,
        subjectColor: subject.color,
        type:         'study',
        deadline:     aula.data,
        notes:        [
          aula.conteudo,
          aula.referencia ? `📖 ${aula.referencia}` : null,
          aula.horario_inicio ? `⏰ ${aula.horario_inicio}–${aula.horario_fim || '?'}` : null,
        ].filter(Boolean).join('\n'),
        done:      false,
        createdAt: new Date().toISOString(),
        source:    'ia-sillabus',
      });
      tarefas++;
    }
  }

  // Importa avaliações
  if (importProvas) {
    for (const av of avalIA) {
      if (!av.data) continue;

      const jaExiste = STATE.tasks.some(t =>
        t.source === 'ia-sillabus' &&
        t.title === `${av.nome} — ${disciplina}` &&
        t.deadline === av.data
      );
      if (jaExiste) { dupl++; continue; }

      STATE.tasks.push({
        id:           `ia_sil_av_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
        title:        `${av.nome} — ${disciplina}`,
        subjectId:    subject.id,
        subjectName:  subject.name,
        subjectColor: subject.color,
        type:         'exam',
        deadline:     av.data,
        notes:        av.descricao || null,
        done:         false,
        createdAt:    new Date().toISOString(),
        source:       'ia-sillabus',
      });
      provas++;
    }
  }

  await save();
  renderTasks();
  renderDashboard();
  return { tarefas, provas, dupl };
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

    /* Botão sillabus (plano de aulas) */
    #ia-sillabus-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 8px 0 4px;
      padding: 10px 18px;
      background: rgba(46, 213, 115, 0.1);
      border: 1px dashed rgba(46, 213, 115, 0.5);
      border-radius: 12px;
      color: rgba(46, 213, 115, 0.95);
      font-weight: 700;
      font-size: 14px;
      cursor: pointer;
      width: 100%;
      transition: background 0.2s, border-color 0.2s;
    }
    #ia-sillabus-btn:hover {
      background: rgba(46, 213, 115, 0.18);
      border-color: rgba(46, 213, 115, 0.8);
    }

    /* Botão importar calendário de provas (na aba Cronograma) */
    #ia-exams-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 8px 0 4px;
      padding: 10px 18px;
      background: rgba(255, 107, 107, 0.1);
      border: 1px dashed rgba(255, 107, 107, 0.5);
      border-radius: 12px;
      color: rgba(255, 107, 107, 0.95);
      font-weight: 700;
      font-size: 14px;
      cursor: pointer;
      width: 100%;
      transition: background 0.2s, border-color 0.2s;
    }
    #ia-exams-btn:hover {
      background: rgba(255, 107, 107, 0.18);
      border-color: rgba(255, 107, 107, 0.8);
    }

    /* Sillabus result UI */
    .ia-sil-header {
      display: flex; flex-wrap: wrap; gap: 6px;
      margin-bottom: 4px;
    }
    .ia-chip--purple {
      background: rgba(108, 99, 255, 0.15);
      color: #7c75ff;
      border: 1px solid rgba(108, 99, 255, 0.3);
    }
    .ia-sil-warning {
      background: rgba(255, 165, 2, 0.1);
      border: 1px solid rgba(255, 165, 2, 0.3);
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 13px;
      color: var(--text);
    }
    .ia-sil-list {
      display: flex; flex-direction: column; gap: 8px;
      margin-bottom: 4px;
    }
    .ia-sil-item {
      background: var(--bg);
      border-radius: 10px;
      padding: 10px 12px;
      display: flex; flex-direction: column; gap: 3px;
    }
    .ia-sil-date {
      font-size: 11px; font-weight: 700;
      color: #6c63ff; text-transform: uppercase; letter-spacing: 0.4px;
    }
    .ia-sil-content {
      font-size: 13px; color: var(--text); font-weight: 500;
    }
    .ia-sil-ref {
      font-size: 11px; color: var(--text2);
    }
    .ia-sil-destinos {
      display: flex; flex-direction: column; gap: 10px;
      margin: 4px 0 8px;
    }
    .ia-sil-check {
      display: flex; align-items: center; gap: 10px;
      font-size: 14px; color: var(--text);
      cursor: pointer;
    }
    .ia-sil-check input[type="checkbox"] {
      width: 18px; height: 18px;
      accent-color: #6c63ff; cursor: pointer;
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
    .ia-upload-btns {
      display: flex;
      gap: 10px;
      margin-top: 12px;
      width: 100%;
    }
    .ia-upload-btn {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 12px 16px;
      font-size: 14px;
      font-weight: 600;
    }
    .ia-upload-btn-gallery {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.15);
      color: var(--text1, #fff);
      border-radius: 12px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .ia-upload-btn-gallery:hover {
      background: rgba(255,255,255,0.12);
    }

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