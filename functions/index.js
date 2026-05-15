// functions/index.js
// Firebase Cloud Functions — proxy seguro para Gemini e Google Classroom OAuth.
// As chaves ficam APENAS aqui no servidor — nunca no código do cliente.
//
// Deploy: firebase deploy --only functions

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { initializeApp } = require('firebase-admin/app');

initializeApp();

// Secrets armazenadas no Firebase (criptografadas, nunca expostas)
const geminiKey        = defineSecret('GEMINI_API_KEY');
const classroomSecret  = defineSecret('CLASSROOM_CLIENT_SECRET');

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const CLASSROOM_CLIENT_ID = '92968084905-1ete8rjlfs6e3uo3pj4h351bdm8ak947.apps.googleusercontent.com';

// ─────────────────────────────────────────────────────────────────────────────
// classroomToken — troca o authorization code por access_token + refresh_token
// e renova o access_token quando expirado.
// ─────────────────────────────────────────────────────────────────────────────
exports.classroomToken = onRequest(
  {
    secrets: [classroomSecret],
    cors: true,
    maxInstances: 10,
  },
  async (req, res) => {

    // 1. Só aceita POST
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Método não permitido' });
    }

    // 2. Valida autenticação Firebase
    const authHeader = req.headers.authorization || '';
    const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'Token de autenticação ausente' });

    let uid;
    try {
      const decoded = await getAuth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch {
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }

    const { action, code, code_verifier, redirect_uri, refresh_token } = req.body;
    const secret = classroomSecret.value();

    // ── Ação: trocar code por token (primeiro login) ───────────────────────
    if (action === 'exchange') {
      if (!code || !code_verifier || !redirect_uri) {
        return res.status(400).json({ error: 'code, code_verifier e redirect_uri são obrigatórios' });
      }

      let tokenData;
      try {
        const resp = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id:     CLASSROOM_CLIENT_ID,
            client_secret: secret,
            redirect_uri,
            grant_type:    'authorization_code',
            code_verifier,
          }),
        });
        tokenData = await resp.json();
        if (!resp.ok || !tokenData.access_token) {
          console.error('[classroomToken] exchange falhou:', tokenData);
          return res.status(400).json({ error: tokenData.error_description || tokenData.error || 'Falha na troca de token' });
        }
      } catch (err) {
        return res.status(502).json({ error: `Erro de rede: ${err.message}` });
      }

      // Salva no Firestore
      const expiresAt = Date.now() + (tokenData.expires_in * 1000);
      const db = getFirestore();
      await db.collection('users').doc(uid).set({
        classroom: {
          access_token:  tokenData.access_token,
          refresh_token: tokenData.refresh_token || null,
          expiresAt,
          connectedAt: new Date().toISOString(),
        }
      }, { merge: true });

      return res.status(200).json({ access_token: tokenData.access_token, expiresAt });
    }

    // ── Ação: renovar token com refresh_token ─────────────────────────────
    if (action === 'refresh') {
      if (!refresh_token) {
        return res.status(400).json({ error: 'refresh_token é obrigatório' });
      }

      let tokenData;
      try {
        const resp = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id:     CLASSROOM_CLIENT_ID,
            client_secret: secret,
            refresh_token,
            grant_type:    'refresh_token',
          }),
        });
        tokenData = await resp.json();
        if (!resp.ok || !tokenData.access_token) {
          return res.status(400).json({ error: tokenData.error_description || 'Falha ao renovar token' });
        }
      } catch (err) {
        return res.status(502).json({ error: `Erro de rede: ${err.message}` });
      }

      const expiresAt = Date.now() + (tokenData.expires_in * 1000);
      const db = getFirestore();
      await db.collection('users').doc(uid).update({
        'classroom.access_token': tokenData.access_token,
        'classroom.expiresAt':    expiresAt,
      });

      return res.status(200).json({ access_token: tokenData.access_token, expiresAt });
    }

    return res.status(400).json({ error: 'action deve ser "exchange" ou "refresh"' });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// geminiProxy — proxy seguro para a API Gemini (existente, sem alterações)
// ─────────────────────────────────────────────────────────────────────────────
exports.geminiProxy = onRequest(
  {
    secrets: [geminiKey],
    cors: true,
    maxInstances: 10,
  },
  async (req, res) => {

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Método não permitido' });
    }

    const authHeader = req.headers.authorization || '';
    const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'Token de autenticação ausente' });

    try {
      await getAuth().verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }

    const { imageBase64, mimeType, mode = 'schedule' } = req.body;

    // ── Modo de resumo de publicações do Classroom ────────────────────────────
    if (mode === 'summarize') {
      const { text, driveFileId, classroomAccessToken, fileBase64: uploadedBase64, fileMimeType: uploadedMimeType } = req.body;
      if (!text && !driveFileId && !uploadedBase64) return res.status(400).json({ error: 'text, driveFileId ou fileBase64 são obrigatórios para mode=summarize' });

      // Arquivo enviado diretamente pelo browser (upload manual) tem prioridade
      let fileBase64 = uploadedBase64 || null;
      let fileMimeType = uploadedMimeType || null;

      if (!fileBase64 && driveFileId && classroomAccessToken) {
        try {
          // 1. Tenta exportar como PDF (Google Docs, Slides, Sheets)
          const exportRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${driveFileId}/export?mimeType=application/pdf`,
            { headers: { Authorization: `Bearer ${classroomAccessToken}` } }
          );
          if (exportRes.ok) {
            const buf = await exportRes.arrayBuffer();
            fileBase64 = Buffer.from(buf).toString('base64');
            fileMimeType = 'application/pdf';
          } else {
            // 2. Fallback: download direto (PDF nativo, imagens)
            const dlRes = await fetch(
              `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
              { headers: { Authorization: `Bearer ${classroomAccessToken}` } }
            );
            if (dlRes.ok) {
              const ct = dlRes.headers.get('content-type') || '';
              const supported = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'];
              if (supported.some(t => ct.includes(t))) {
                const buf = await dlRes.arrayBuffer();
                fileBase64 = Buffer.from(buf).toString('base64');
                fileMimeType = ct.split(';')[0].trim();
              }
            }
          }
        } catch (e) {
          console.warn('[summarize] Falha ao baixar arquivo Drive:', e.message);
        }
      }

      const SUMMARIZE_PROMPT = `Você é um assistente acadêmico universitário. Analise o conteúdo abaixo (publicação do Google Classroom) e produza um relatório completo em português brasileiro usando markdown.

Estruture SEMPRE assim (use os títulos exatos):

## Resumo
O que foi publicado — explique com suas próprias palavras (2–3 parágrafos).

## Pontos Principais
- Liste os conceitos, tópicos ou informações mais importantes em bullet points.

## Exercícios e Questões
Se houver exercícios, atividades ou perguntas no material, resolva cada um passo a passo com a resposta completa. Se não houver, escreva "Nenhum exercício encontrado neste material."

## Dicas de Estudo
Sugira 3–4 dicas práticas de como estudar este conteúdo.

---
CONTEÚDO DA PUBLICAÇÃO:
`;

      // Rejeita arquivos grandes demais antes de bater na API
      if (uploadedBase64 && uploadedBase64.length > 20_000_000) {
        return res.status(413).json({ error: 'PDF muito grande para ser analisado. Tente um arquivo menor (máx. ~15 MB).' });
      }

      const parts = [{ text: SUMMARIZE_PROMPT + (text || '') }];
      if (fileBase64 && fileMimeType) {
        parts.push({ inlineData: { mimeType: fileMimeType, data: fileBase64 } });
        parts[0].text += '\n\n(O arquivo PDF foi enviado junto — analise TODO o conteúdo do arquivo e priorize-o sobre o texto acima.)';
      }

      try {
        const apiKey  = geminiKey.value();
        const apiResp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
          }),
        });
        const result = await apiResp.json();
        if (!apiResp.ok) {
          const msg = result?.error?.message || `Gemini retornou status ${apiResp.status}`;
          console.error('[summarize] Gemini API error:', msg);
          if (apiResp.status === 400 && msg.includes('size')) {
            return res.status(413).json({ error: 'PDF muito grande para a IA processar. Tente um arquivo menor.' });
          }
          return res.status(502).json({ error: `Erro na IA: ${msg}` });
        }
        const resumo = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (!resumo) {
          const reason = result.candidates?.[0]?.finishReason || 'desconhecido';
          console.error('[summarize] Gemini sem conteúdo, finishReason:', reason);
          return res.status(500).json({ error: `IA não retornou conteúdo (${reason}). Tente novamente.` });
        }
        const usedFile = !!fileBase64;
        return res.status(200).json({ resumo, usedFile });
      } catch (err) {
        return res.status(502).json({ error: `Erro ao chamar Gemini: ${err.message}` });
      }
    }

    // ── Modo de resposta com IA ───────────────────────────────────────────────
    if (mode === 'answer') {
      const { titulo = '', descricao = '' } = req.body;
      const ANSWER_PROMPT = `Você é um estudante universitário respondendo uma atividade do Google Classroom. Escreva uma resposta curta e natural, exatamente como um aluno digitaria.

Regras obrigatórias:
- Escreva em primeira pessoa, como um aluno real
- Máximo 4 a 6 frases curtas, sem parágrafos longos
- Sem bullet points, sem tópicos, sem markdown
- Sem introduções formais como "Com base no exposto..." ou "Podemos concluir que..."
- Linguagem simples e direta, como alguém digitando no celular
- Responda especificamente à atividade, não de forma genérica
- Português brasileiro natural

Atividade: ${titulo}
${descricao ? `Descrição: ${descricao}` : ''}

Escreva apenas a resposta, sem nenhuma explicação extra:`;

      try {
        const apiKey = geminiKey.value();
        const apiResp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: ANSWER_PROMPT }] }],
            generationConfig: { temperature: 0.8, maxOutputTokens: 512 },
          }),
        });
        const result = await apiResp.json();
        if (!apiResp.ok) {
          const msg = result?.error?.message || `Gemini retornou status ${apiResp.status}`;
          return res.status(502).json({ error: `Erro na IA: ${msg}` });
        }
        const resposta = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        if (!resposta) return res.status(500).json({ error: 'IA não retornou conteúdo. Tente novamente.' });
        return res.status(200).json({ resposta });
      } catch (err) {
        return res.status(502).json({ error: `Erro ao chamar Gemini: ${err.message}` });
      }
    }

    if (!imageBase64 || !mimeType) {
      return res.status(400).json({ error: 'imageBase64 e mimeType são obrigatórios' });
    }

    if (imageBase64.length > 7_000_000) {
      return res.status(413).json({ error: 'Imagem muito grande. Use uma foto menor.' });
    }

    const SCHEDULE_PROMPT = `
Você é um assistente especializado em ler cronogramas acadêmicos em imagens.
Analise esta imagem de cronograma/grade horária e extraia TODAS as informações.

Retorne APENAS um JSON válido (sem markdown, sem explicações) com este formato:
{
  "materias": [
    { "nome": "Nome da Matéria", "professor": "Nome Opcional" }
  ],
  "aulas": [
    {
      "materia": "Nome exato igual ao campo nome em materias",
      "dia": 0,
      "inicio": "08:00",
      "fim": "09:00",
      "sala": "Sala opcional ou null"
    }
  ],
  "observacoes": "Qualquer observação relevante encontrada na imagem, ou null"
}

Regras:
- "dia" deve ser número: 0=Domingo, 1=Segunda, 2=Terça, 3=Quarta, 4=Quinta, 5=Sexta, 6=Sábado
- "inicio" e "fim" no formato HH:MM (24h)
- Se não conseguir ler alguma informação, use null
- Se a imagem não for um cronograma acadêmico, retorne: {"erro": "Imagem não reconhecida como cronograma"}
- Não invente informações que não estejam claramente visíveis na imagem
`;

    const EXAMS_PROMPT = `
Você é um assistente especializado em ler calendários acadêmicos com datas de provas.
Analise esta imagem e extraia TODAS as provas/avaliações listadas.

Retorne APENAS um JSON válido (sem markdown, sem explicações) com este formato:
{
  "provas": [
    {
      "materia": "Nome da disciplina/matéria",
      "tipo": "Prova 1",
      "data": "2026-06-09"
    }
  ],
  "observacoes": "Qualquer observação relevante, ou null"
}

Regras:
- "data" SEMPRE no formato ISO: YYYY-MM-DD
- "tipo" deve ser o nome da avaliação como aparece na imagem (ex: "Prova 1", "Prova 2", "Final", "Substitutiva")
- Extraia TODAS as colunas de prova para CADA matéria — não pule nenhuma
- Se uma célula estiver vazia ou com traço, ignore aquela entrada
- Se a imagem não for um calendário de provas, retorne: {"erro": "Imagem não reconhecida como calendário de provas"}
- Não invente datas — use apenas o que estiver claramente visível
`;

    const SYLLABI_PROMPT = `
Você é um assistente especializado em ler cronogramas de aulas detalhados de faculdades/universidades.
Analise esta imagem de cronograma de aulas (plano de ensino / programa de disciplina) e extraia TODAS as informações de cada aula.

Retorne APENAS um JSON válido (sem markdown, sem explicações) com este formato:
{
  "disciplina": "Nome completo da disciplina",
  "professor": "Nome do professor ou null",
  "turno": "Noturno ou Diurno ou null",
  "periodo": "Período/semestre ou null",
  "aulas": [
    {
      "numeros": "1-2",
      "data": "2026-02-04",
      "tipo": "Aula",
      "conteudo": "Descrição do conteúdo programado da aula",
      "referencia": "Referência bibliográfica indicada ou null",
      "horario_inicio": "20:30",
      "horario_fim": "22:10"
    }
  ],
  "avaliacoes": [
    {
      "nome": "1ª Avaliação",
      "data": "2026-04-08",
      "tipo": "Prova",
      "descricao": "Descrição adicional ou null"
    }
  ],
  "observacoes": "Observações gerais ou null"
}

Regras:
- "data" SEMPRE no formato ISO: YYYY-MM-DD
- "tipo" de aula pode ser: "Aula", "Exercício", "Revisão", "Apresentação", "Outro"
- "tipo" de avaliação pode ser: "Prova", "Trabalho", "Apresentação", "Avaliação Final", "Substitutiva"
- Se uma célula estiver vazia, traço ou não visível, use null
- Extraia TODAS as aulas sem exceção, mesmo repetidas
- Se a imagem não for um cronograma de aulas de faculdade, retorne: {"erro": "Imagem não reconhecida como cronograma de aulas"}
- Não invente datas ou conteúdos — use APENAS o que estiver claramente visível
`;

    const prompt = mode === 'exams' ? EXAMS_PROMPT : mode === 'syllabi' ? SYLLABI_PROMPT : SCHEDULE_PROMPT;

    const geminiBody = {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
        ],
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
      },
    };

    let apiResp;
    try {
      const apiKey = geminiKey.value();
      apiResp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(geminiBody),
      });
    } catch (networkErr) {
      return res.status(502).json({ error: `Erro de rede ao chamar Gemini: ${networkErr.message}` });
    }

    if (!apiResp.ok) {
      const errData = await apiResp.json().catch(() => ({}));
      const msg     = errData?.error?.message || `HTTP ${apiResp.status}`;
      return res.status(apiResp.status).json({ error: `Gemini: ${msg}` });
    }

    const data = await apiResp.json();

    const parts   = data?.candidates?.[0]?.content?.parts || [];
    const rawText = (
      parts.find(p => !p.thought && p.text)?.text
      ?? parts[parts.length - 1]?.text
      ?? ''
    );

    const cleaned = rawText
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/gi, '')
      .trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[geminiProxy] rawText sem JSON:', rawText.slice(0, 300));
      return res.status(500).json({ error: 'IA retornou formato inesperado. Tente novamente.' });
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return res.status(200).json(parsed);
    } catch (parseErr) {
      console.error('[geminiProxy] JSON.parse falhou:', parseErr.message, jsonMatch[0].slice(0, 300));
      return res.status(500).json({ error: 'IA retornou formato inesperado. Tente novamente.' });
    }
  }
);
// ===== FUNCTIONS/INDEX.JS — ADIÇÕES =====
// Cole este bloco ao FINAL do functions/index.js existente.
// Não altera nenhuma export existente.
//
// Pré-requisito: npm install @google/generative-ai --save
// no diretório /functions/

const { onPostCreated, onPostReportCountUpdated } = require('./feed');
const { suggestPeers, suggestGroups } = require('./recommendations');
const { moderatePost, escalateReport } = require('./moderation');

// ---- Exports novos — Feed ----
exports.onPostCreated = onPostCreated;
exports.onPostReportCountUpdated = onPostReportCountUpdated;

// ---- Exports novos — Recomendações IA ----
exports.suggestPeers = suggestPeers;
exports.suggestGroups = suggestGroups;

// ---- Exports novos — Moderação ----
exports.moderatePost = moderatePost;
exports.escalateReport = escalateReport;

// ─────────────────────────────────────────────────────────────────────────────
// facapeProxy — proxy server-side para contornar CORS do Portal do Aluno FACAPE
// O Node.js no servidor não tem restrição CORS, então pode fazer requests
// diretamente para sistemas.facape.br:8443
// ─────────────────────────────────────────────────────────────────────────────
exports.facapeProxy = onRequest(
  {
    cors: true,
    maxInstances: 10,
    timeoutSeconds: 60,
  },
  async (req, res) => {

    // 1. Só aceita POST
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Método não permitido' });
    }

    // 2. Valida autenticação Firebase
    const authHeader = req.headers.authorization || '';
    const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'Token de autenticação ausente' });

    try {
      await getAuth().verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }

    const { matricula, senha } = req.body;
    if (!matricula || !senha) {
      return res.status(400).json({ error: 'matricula e senha são obrigatórios' });
    }

    const FACAPE_BASE       = 'https://sistemas.facape.br:8443/portalaluno';
    const FACAPE_LOGIN_URL  = `${FACAPE_BASE}/login.do`;
    const FACAPE_ACTION_URL = `${FACAPE_BASE}/actEntidade.do`;

    const BASE_HEADERS = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    };

    try {
      // ── Passo 1: GET da página de login para obter JSESSIONID ──
      const loginPageResp = await fetch(FACAPE_LOGIN_URL, {
        method: 'GET',
        headers: BASE_HEADERS,
        redirect: 'follow',
      });

      console.log('[facapeProxy] GET login status:', loginPageResp.status, 'url:', loginPageResp.url);

      // Captura correta de cookies: getAll() retorna array individual por cookie,
      // evitando o bug de split por vírgula em datas de expiração
      let sessionCookies = '';
      const rawSetCookie = loginPageResp.headers.get('set-cookie');
      if (rawSetCookie) {
        // Node fetch junta todos set-cookie com ", " — separamos apenas pelo padrão
        // "Nome=Valor; atributos, Nome2=Valor2" usando regex que respeita datas
        const cookieParts = rawSetCookie.split(/,\s*(?=[A-Za-z0-9_\-]+=)/);
        sessionCookies = cookieParts
          .map(c => c.split(';')[0].trim())
          .filter(Boolean)
          .join('; ');
      }

      console.log('[facapeProxy] Cookies capturados:', sessionCookies || '(nenhum)');

      const loginHtml = new TextDecoder('iso-8859-1').decode(await loginPageResp.arrayBuffer());

      // LOG DIAGNÓSTICO — nomes reais dos campos do formulário
      const allInputs = [...loginHtml.matchAll(/<input[^>]*>/gi)].map(m => m[0]);
      console.log("[facapeProxy] INPUTS:", JSON.stringify(allInputs));
      const allForms = [...loginHtml.matchAll(/<form[^>]*>/gi)].map(m => m[0]);
      console.log("[facapeProxy] FORMS:", JSON.stringify(allForms));

      // Extrai todos os campos hidden do formulário de login (CSRF, tokens, etc.)
      const hiddenFields = {};
      const hiddenRegex = /<input[^>]*type=["']hidden["'][^>]*>/gi;
      let hiddenMatch;
      while ((hiddenMatch = hiddenRegex.exec(loginHtml)) !== null) {
        const tag = hiddenMatch[0];
        const nameM  = tag.match(/name=["']([^"']+)["']/i);
        const valueM = tag.match(/value=["']([^"']*?)["']/i);
        if (nameM && valueM) hiddenFields[nameM[1]] = valueM[1];
      }
      console.log('[facapeProxy] Hidden fields encontrados:', Object.keys(hiddenFields));

      // ── Passo 2: POST de login ──
      const formData = new URLSearchParams();
      // Inclui todos os campos hidden primeiro (tokens CSRF, viewstate, etc.)
      for (const [k, v] of Object.entries(hiddenFields)) {
        formData.append(k, v);
      }
      formData.append('enclogn', matricula);
      formData.append('encpswd', senha);

      const postHeaders = {
        ...BASE_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': FACAPE_LOGIN_URL,
        'Origin': 'https://sistemas.facape.br:8443',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      };
      if (sessionCookies) postHeaders['Cookie'] = sessionCookies;

      const postResp = await fetch(FACAPE_ACTION_URL, {
        method: 'POST',
        headers: postHeaders,
        body: formData.toString(),
        redirect: 'follow',
      });

      const postText = new TextDecoder('iso-8859-1').decode(await postResp.arrayBuffer());
      const finalUrl = postResp.url || '';

      console.log('[facapeProxy] POST status:', postResp.status, 'finalUrl:', finalUrl);
      console.log('[facapeProxy] HTML snippet (300 chars):', postText.slice(0, 300).replace(/\s+/g, ' '));

      // ── Verifica falha de login (só strings inequívocas) ──
      const loginFailed =
        postText.includes('Senha incorreta') ||
        postText.includes('Login inválido') ||
        postText.includes('Matrícula não encontrada') ||
        postText.includes('senha inválida') ||
        postText.includes('loginErro') ||
        postText.includes('usuario_nao_encontrado') ||
        /class=["'][^"']*erro[^"']*["'][^>]*>[^<]*matr[íi]cula/i.test(postText) ||
        /class=["'][^"']*erro[^"']*["'][^>]*>[^<]*senha/i.test(postText);

      if (loginFailed) {
        console.log('[facapeProxy] Login falhou por credenciais');
        return res.status(401).json({ ok: false, error: 'Matrícula ou senha incorretos.' });
      }

      // ── Verifica sucesso: saiu da página de login ──
      const stillOnLogin = finalUrl.includes('login.do') || postResp.url.includes('login.do');
      const hasPortalContent =
        postText.includes('dadosAluno') ||
        postText.includes('actLogoff') ||
        postText.includes('actNotas') ||
        postText.includes('Notas do Semestre');

      if (stillOnLogin && !hasPortalContent) {
        console.log('[facapeProxy] Portal não redirecionou — possível bloqueio ou estrutura mudou');
        return res.status(200).json({
          ok: false,
          needsManual: true,
          error: 'Portal indisponível ou com estrutura alterada. Use entrada manual.',
        });
      }

      // ── Captura cookies da resposta POST (sessão autenticada) ──
      const rawPostSetCookie = postResp.headers.get('set-cookie');
      if (rawPostSetCookie) {
        const cookieMap = {};
        sessionCookies.split('; ').forEach(c => {
          const i = c.indexOf('=');
          if (i > 0) cookieMap[c.slice(0, i).trim()] = c.slice(i + 1);
        });
        rawPostSetCookie.split(/,\s*(?=[A-Za-z0-9_\-]+=)/).forEach(c => {
          const nv = c.split(';')[0].trim();
          const i = nv.indexOf('=');
          if (i > 0) cookieMap[nv.slice(0, i).trim()] = nv.slice(i + 1);
        });
        sessionCookies = Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join('; ');
      }
      console.log('[facapeProxy] Cookies autenticados:', sessionCookies.slice(0, 80) || '(nenhum)');

      // ── Extrai semestre atual do HTML da home ──
      const semMatch = postText.match(/<option\s[^>]*value=["']([^"']+)["']/i);
      const currentSemester = semMatch ? semMatch[1] : '1/2026';
      console.log('[facapeProxy] Semestre atual:', currentSemester);

      // ── Requisições autenticadas para notas e horário ──
      const authHeaders = { ...BASE_HEADERS, 'Referer': `${FACAPE_BASE}/home.do` };
      if (sessionCookies) authHeaders['Cookie'] = sessionCookies;

      const decode = r => r.arrayBuffer().then(b => new TextDecoder('iso-8859-1').decode(b));
      const [notasHtml, horarioHtml, calendarioHtml] = await Promise.all([
        fetch(`${FACAPE_BASE}/actNotas.do`, {
          method: 'GET',
          headers: authHeaders,
          redirect: 'follow',
        }).then(decode).catch(() => ''),
        fetch(`${FACAPE_BASE}/actTurma.do`, {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `m=horario&tmddtan=${encodeURIComponent(currentSemester)}`,
          redirect: 'follow',
        }).then(decode).catch(() => ''),
        fetch(`${FACAPE_BASE}/actTurma.do?m=calendario`, {
          method: 'GET',
          headers: authHeaders,
          redirect: 'follow',
        }).then(decode).catch(() => ''),
      ]);

      // ── Passo 3: extrair dados do HTML ──
      const data = scrapeAll(postText, notasHtml, horarioHtml, calendarioHtml, matricula);
      console.log('[facapeProxy] Sucesso! Dados extraídos:', JSON.stringify(data).slice(0, 200));
      return res.status(200).json({ ok: true, data });

    } catch (err) {
      console.error('[facapeProxy] Erro de conexão:', err.message);
      return res.status(200).json({
        ok: false,
        needsManual: true,
        error: `Erro de conexão com o portal: ${err.message}`,
      });
    }
  }
);

// ── Helpers de scraping (server-side, sem DOMParser) ────────────────────────

// O portal FACAPE usa ISO-8859-1; decoda corretamente para não quebrar acentos
async function fetchFacapeHtml(url, options) {
  const resp = await fetch(url, options);
  const buf = await resp.arrayBuffer();
  return { html: new TextDecoder('iso-8859-1').decode(buf), resp };
}

function scrapeAll(homeHtml, notasHtml, horarioHtml, calendarioHtml, matricula) {
  // Nome: "27805 - DANIEL MATOS OITAVEN" no div#dadosAluno
  const nomeMatch = homeHtml.match(/id=["']dadosAluno["'][\s\S]*?\d{4,6}\s*-\s*([^\n\r<]{3,80})/i);
  const nome = nomeMatch ? cleanText(nomeMatch[1]) : `Aluno ${matricula}`;

  // Curso: "CIENCIA DA COMPUTACAO - Noturno"
  const cursoMatch = homeHtml.match(/id=["']dadosAluno["'][\s\S]*?([A-Z][A-Za-zÀ-ɏ\s]{5,60})\s*-\s*(?:Noturno|Diurno|Matutino|Vespertino)/i);
  const curso = cursoMatch ? cleanText(cursoMatch[1]) : '';

  const materias  = extractMaterias(notasHtml || homeHtml);
  const notas     = extractNotas(notasHtml || homeHtml);
  const horarios  = extractHorarios(horarioHtml || homeHtml);
  const calendario = extractCalendario(calendarioHtml || '');

  // Período do aluno: usa o valor da coluna "Período" da primeira nota (ex: "2°")
  // Fallback: código de grade do HTML da home (ex: "20191")
  const periodoNota = notas[0]?.periodo || '';
  const gradeMatch  = homeHtml.match(/Grade\s*-\s*(\d{4,6})/i);
  const periodo     = periodoNota || (gradeMatch ? gradeMatch[1] : '');

  return {
    nome:     cleanText(nome),
    matricula,
    curso:    cleanText(curso),
    periodo:  cleanText(periodo),
    materias,
    notas,
    horarios,
    calendario,
  };
}

function extractByPatterns(html, patterns) {
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return '';
}

function extractMaterias(html) {
  const materias = [];
  const seen = new Set();
  // FACAPE: tabela de notas tem 15 colunas — cells[0]=Código, cells[2]=Disciplina
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
      .map(c => c.replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ').trim());
    if (cells.length >= 14 && cells[2] && cells[2].length > 3) {
      const nome = cleanText(cells[2]);
      if (!seen.has(nome.toLowerCase())) {
        seen.add(nome.toLowerCase());
        materias.push({ nome, codigo: cleanText(cells[0]) });
      }
    }
  }
  return materias.slice(0, 20);
}

function extractNotas(html) {
  const notas = [];
  // FACAPE: cells índices da tabela de notas (15 colunas):
  // [0]=Código [1]=Curso [2]=Disciplina [3]=Turma [4]=Período [5]=Turno [6]=Letra
  // [7]=Nota1  [8]=Nota2 [9]=Nota3      [10]=Final [11]=Média [12]=Faltas [13]=Limite [14]=Resultado
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
      .map(c => c.replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ').trim());
    if (cells.length < 14 || !cells[2] || cells[2].length <= 3) continue;

    const parseNota = v => {
      const n = parseFloat(cleanText(v));
      return isNaN(n) ? null : n;
    };

    notas.push({
      disciplina: cleanText(cells[2]),
      codigo:     cleanText(cells[0]),
      turma:      cleanText(cells[3]),
      periodo:    cleanText(cells[4]),
      turno:      cleanText(cells[5]),
      nota1:      parseNota(cells[7]),
      nota2:      parseNota(cells[8]),
      nota3:      parseNota(cells[9]),
      final:      parseNota(cells[10]),
      faltas:     parseNota(cells[12]),
      limite:     parseNota(cells[13]),
      resultado:  cleanText(cells[14]),
    });
  }
  return notas.slice(0, 20);
}

function extractHorarios(html) {
  const horarios = [];
  const dias = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];

  const toMinutes = t => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };
  const fromMinutes = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  // Primeira passagem: coleta apenas as linhas de horário válidas
  const timeRows = [];
  for (const row of rows) {
    const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
      .map(c =>
        c.replace(/<[^>]+>/g, '')
         .replace(/&nbsp;/gi, ' ')
         .replace(/&[^;]+;/g, ' ')
         .replace(/\s+/g, ' ')
         .trim()
      );
    if (cells.length !== 7) continue;
    const horario = cleanText(cells[0]);
    if (!horario || !/^\d{1,2}:\d{2}/.test(horario)) continue;
    timeRows.push({ horario, cells });
  }

  timeRows.forEach(({ horario, cells }, idx) => {
    const startMin = toMinutes(horario);
    const nextHorario = timeRows[idx + 1]?.horario;
    // Usa o próximo slot como fim; se o intervalo for > 2h (ex: transição manhã→tarde) usa +2h
    const endMin = nextHorario && (toMinutes(nextHorario) - startMin) <= 120
      ? toMinutes(nextHorario)
      : startMin + 120;
    const startFmt = fromMinutes(startMin);
    const endFmt   = fromMinutes(endMin);
    const horarioFmt = `${startFmt} - ${endFmt}`;

    dias.forEach((dia, i) => {
      const celula = cleanText(cells[i + 1]);
      if (!celula || celula.length < 5) return;

      const partes = celula.split(/\s*-\s*/);

      const discParte = partes.find(p => /^Disciplina\s+/i.test(p)) || '';
      const aula = cleanText(discParte.replace(/^Disciplina\s+/i, ''));
      if (!aula) return;

      const profIdx = partes.findIndex(p => /^Prof\(a\)/i.test(p));
      const professor = profIdx >= 0
        ? cleanText(partes[profIdx].replace(/^Prof\(a\)\s*/i, ''))
        : '';

      const salaRaw = profIdx >= 0 ? (partes[profIdx + 1] || '').trim() : '';
      const sala = salaRaw.length > 1 ? cleanText(salaRaw) : '';

      const mTurno = celula.match(/\b(Matutino|Noturno|Diurno|Vespertino)\b/i);
      const turno = mTurno ? mTurno[1] : '';

      horarios.push({ dia, horario: horarioFmt, aula, professor, turno, sala });
    });
  });

  return horarios;
}

function extractCalendario(html) {
  // FACAPE: tabela "Calendário" — colunas: Código, Disciplina, Prova 1, Prova 2, Prova 3, Final
  // Formato de data: DD/MM/AAAA — convertido para ISO AAAA-MM-DD
  const calendario = [];
  if (!html) return calendario;

  const parseDate = v => {
    const s = cleanText(v);
    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  };

  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
      .map(c => c.replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ').trim());

    // Tabela do calendário tem 6 colunas: Código, Disciplina, Prova1, Prova2, Prova3, Final
    if (cells.length !== 6) continue;
    if (!cells[0] || !cells[1] || cells[1].length < 3) continue;
    // Filtra linhas de cabeçalho
    if (/código|disciplina|prova|final/i.test(cells[0])) continue;

    calendario.push({
      codigo:     cleanText(cells[0]),
      disciplina: cleanText(cells[1]),
      prova1:     parseDate(cells[2]),
      prova2:     parseDate(cells[3]),
      prova3:     parseDate(cells[4]),
      final:      parseDate(cells[5]),
    });
  }

  return calendario;
}

function cleanText(t) {
  return (t || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}