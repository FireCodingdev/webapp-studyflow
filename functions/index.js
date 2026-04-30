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