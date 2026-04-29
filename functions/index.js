// functions/index.js
// Firebase Cloud Function que serve como proxy seguro para a API Gemini.
// A chave fica APENAS aqui no servidor — nunca no código do cliente.
//
// Deploy: firebase deploy --only functions

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getAuth } = require('firebase-admin/auth');
const { initializeApp } = require('firebase-admin/app');

initializeApp();

// A chave é armazenada como secret do Firebase (criptografada, nunca exposta)
const geminiKey = defineSecret('GEMINI_API_KEY');

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent`;

exports.geminiProxy = onRequest(
  {
    secrets: [geminiKey],   // injeta o secret no ambiente da função
    cors: true,             // permite chamadas do PWA
    maxInstances: 10,       // limite de instâncias simultâneas
  },
  async (req, res) => {

    // ── 1. Só aceita POST ──────────────────────────────────────────────────
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Método não permitido' });
    }

    // ── 2. Valida autenticação Firebase do usuário ─────────────────────────
    // Garante que só usuários logados no seu app podem usar a IA
    const authHeader = req.headers.authorization || '';
    const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!idToken) {
      return res.status(401).json({ error: 'Token de autenticação ausente' });
    }

    try {
      await getAuth().verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }

    // ── 3. Valida o body da requisição ─────────────────────────────────────
    const { imageBase64, mimeType } = req.body;

    if (!imageBase64 || !mimeType) {
      return res.status(400).json({ error: 'imageBase64 e mimeType são obrigatórios' });
    }

    // Limita tamanho da imagem (evita abuso: ~5MB em base64 ≈ 6.8MB string)
    if (imageBase64.length > 7_000_000) {
      return res.status(413).json({ error: 'Imagem muito grande. Use uma foto menor.' });
    }

    // ── 4. Monta e envia a requisição ao Gemini ────────────────────────────
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

    const geminiBody = {
      contents: [{
        parts: [
          { text: SCHEDULE_PROMPT },
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
        ],
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
    };

    const apiKey  = geminiKey.value();
    const apiResp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(geminiBody),
    });

    if (!apiResp.ok) {
      const errData = await apiResp.json().catch(() => ({}));
      const msg     = errData?.error?.message || `HTTP ${apiResp.status}`;
      return res.status(apiResp.status).json({ error: `Gemini: ${msg}` });
    }

    const data    = await apiResp.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = rawText
      .replace(/```json\n?/gi, '')
      .replace(/```\n?/gi, '')
      .trim();

    // Tenta extrair JSON mesmo que venha com texto ao redor
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'IA retornou formato inesperado. Tente novamente.' });
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return res.status(200).json(parsed);
    } catch {
      return res.status(500).json({ error: 'IA retornou formato inesperado. Tente novamente.' });
    }
  }
);
