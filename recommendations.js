// ===== FUNCTIONS/RECOMMENDATIONS.JS =====
// IA sugere colegas e grupos — NOVO Cloud Function
// Usa Gemini via já existente (geminiProxy padrão do projeto)

const { onCall } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const db = getFirestore();

// Gemini já está configurado no projeto
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ---- Sugerir colegas baseado no perfil acadêmico ----
exports.suggestPeers = onCall({ maxInstances: 10 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new Error('Não autenticado');

  try {
    // Carrega perfil do usuário
    const profileSnap = await db.doc(`users/${uid}/profile/academic`).get();
    const profile = profileSnap.exists ? profileSnap.data() : {};

    if (!profile.institution && !profile.course) {
      return { suggestions: [], reason: 'Perfil acadêmico incompleto. Preencha instituição e curso.' };
    }

    // Busca candidatos com mesma instituição/curso
    let candidates = [];
    if (profile.institution) {
      const snap = await db.collection('user_profiles')
        .where('institution', '==', profile.institution)
        .limit(50)
        .get();
      candidates = snap.docs.filter(d => d.id !== uid).map(d => ({ uid: d.id, ...d.data() }));
    }

    if (candidates.length < 5 && profile.course) {
      const snap2 = await db.collection('user_profiles')
        .where('course', '==', profile.course)
        .limit(20)
        .get();
      const extra = snap2.docs
        .filter(d => d.id !== uid && !candidates.find(c => c.uid === d.id))
        .map(d => ({ uid: d.id, ...d.data() }));
      candidates = [...candidates, ...extra];
    }

    if (!candidates.length) {
      return { suggestions: [], reason: 'Nenhum colega encontrado com perfil similar ainda.' };
    }

    // Usa Gemini para ranquear/filtrar (máximo 10 candidatos para não estourar tokens)
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const prompt = `Você é um sistema de recomendação acadêmica.
Perfil do usuário:
- Instituição: ${profile.institution || 'N/A'}
- Curso: ${profile.course || 'N/A'}
- Semestre: ${profile.semester || 'N/A'}
- Habilidades: ${(profile.skills || []).join(', ') || 'N/A'}

Candidatos (JSON):
${JSON.stringify(candidates.slice(0, 10).map(c => ({
  uid: c.uid,
  name: c.displayName,
  institution: c.institution,
  course: c.course,
})))}

Retorne APENAS um JSON com os UIDs dos TOP 5 candidatos mais compatíveis, no formato:
{"uids": ["uid1", "uid2", ...]}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);
    const topUids = parsed.uids || [];

    const suggestions = candidates
      .filter(c => topUids.includes(c.uid))
      .slice(0, 5);

    return { suggestions };
  } catch (err) {
    console.error('[recommendations] Erro ao sugerir colegas:', err);
    return { suggestions: [], error: err.message };
  }
});

// ---- Sugerir grupos baseado na matéria/curso ----
exports.suggestGroups = onCall({ maxInstances: 10 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new Error('Não autenticado');

  try {
    const profileSnap = await db.doc(`users/${uid}/profile/academic`).get();
    const profile = profileSnap.exists ? profileSnap.data() : {};
    const subjects = (profile.skills || []).concat(profile.course ? [profile.course] : []);

    if (!subjects.length) {
      return { suggestions: [], reason: 'Preencha o perfil acadêmico para receber sugestões.' };
    }

    // Busca grupos existentes
    const snap = await db.collection('groups').limit(50).get();
    const groups = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (!groups.length) return { suggestions: [] };

    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const prompt = `Recomende grupos acadêmicos para um usuário.
Interesses do usuário: ${subjects.join(', ')}
Grupos disponíveis:
${JSON.stringify(groups.slice(0, 20).map(g => ({ id: g.id, name: g.name, subject: g.subject })))}

Retorne APENAS JSON no formato:
{"ids": ["id1", "id2", "id3"]}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);
    const topIds = parsed.ids || [];

    const suggestions = groups
      .filter(g => topIds.includes(g.id))
      .slice(0, 5);

    return { suggestions };
  } catch (err) {
    console.error('[recommendations] Erro ao sugerir grupos:', err);
    return { suggestions: [], error: err.message };
  }
});
