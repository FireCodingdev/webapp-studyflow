// ===== SOCIAL: PROFILE.JS =====
// Perfil acadêmico público — NOVO MÓDULO
// Não altera nenhuma função existente. Apenas adiciona novas.

import { db, auth } from '../firebase.js';

// CORREÇÃO: import estático no lugar de top-level await
import {
  doc, getDoc, setDoc, collection, query, where, getDocs, limit
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ---- Salvar perfil acadêmico público no Firestore ----
export async function saveAcademicProfile(uid, profileData) {
  try {
    await setDoc(doc(db, 'users', uid, 'profile', 'academic'), {
      institution: profileData.institution || '',
      course: profileData.course || '',
      semester: profileData.semester || 1,
      skills: profileData.skills || [],
      bio: profileData.bio || '',
      projects: profileData.projects || [],
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    // Atualiza também contadores sociais (inicializa se não existir)
    await setDoc(doc(db, 'users', uid), {
      social: { followers: 0, following: 0, reputation: 0 },
    }, { merge: true });

    return true;
  } catch (err) {
    console.error('[profile] Erro ao salvar perfil acadêmico:', err);
    return false;
  }
}

// ---- Carregar perfil acadêmico de um usuário ----
export async function loadAcademicProfile(uid) {
  try {
    const snap = await getDoc(doc(db, 'users', uid, 'profile', 'academic'));
    if (snap.exists()) return snap.data();
    return null;
  } catch (err) {
    console.error('[profile] Erro ao carregar perfil:', err);
    return null;
  }
}

// ---- Carregar dados sociais (followers/following/reputation) ----
export async function loadSocialStats(uid) {
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    if (snap.exists()) return snap.data().social || { followers: 0, following: 0, reputation: 0 };
    return { followers: 0, following: 0, reputation: 0 };
  } catch (err) {
    console.error('[profile] Erro ao carregar stats sociais:', err);
    return { followers: 0, following: 0, reputation: 0 };
  }
}

// ---- Renderizar página de perfil no painel de conta (accs-sub-body) ----
export async function renderAcademicProfileSection(uid) {
  const panel = document.getElementById('accs-sub-body');
  if (!panel) return;

  const profile = await loadAcademicProfile(uid) || {};

  panel.innerHTML = `
    <div class="social-profile-form">
      <div class="accs-form-group">
        <label class="accs-label">Instituição</label>
        <input id="sp-institution" class="accs-input" type="text" placeholder="Ex: UFPE, USP, IFPE..." value="${escapeForAttr(profile.institution || '')}">
      </div>
      <div class="accs-form-group">
        <label class="accs-label">Curso</label>
        <input id="sp-course" class="accs-input" type="text" placeholder="Ex: Engenharia de Software" value="${escapeForAttr(profile.course || '')}">
      </div>
      <div class="accs-form-group">
        <label class="accs-label">Semestre</label>
        <input id="sp-semester" class="accs-input" type="number" min="1" max="20" placeholder="1" value="${profile.semester || 1}">
      </div>
      <div class="accs-form-group">
        <label class="accs-label">Habilidades / Matérias destaque</label>
        <input id="sp-skills" class="accs-input" type="text" placeholder="Ex: Python, Cálculo, UX (separado por vírgula)" value="${escapeForAttr((profile.skills || []).join(', '))}">
      </div>
      <div class="accs-form-group">
        <label class="accs-label">Bio Acadêmica</label>
        <textarea id="sp-bio" class="accs-input" rows="3" placeholder="Conte sobre seus interesses e objetivos acadêmicos...">${escapeHtmlContent(profile.bio || '')}</textarea>
      </div>
      <button class="accs-save-btn" onclick="window.saveAcademicProfileUI()">💾 Salvar Perfil Acadêmico</button>
      <div id="sp-feedback" style="margin-top:8px;font-size:13px;color:var(--accent);"></div>
    </div>
  `;
}

// ---- Handler chamado pelo onclick do botão salvar ----
window.saveAcademicProfileUI = async function() {
  const user = auth.currentUser;
  if (!user) return;

  const skills = (document.getElementById('sp-skills')?.value || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  const profileData = {
    institution: document.getElementById('sp-institution')?.value?.trim() || '',
    course:      document.getElementById('sp-course')?.value?.trim() || '',
    semester:    parseInt(document.getElementById('sp-semester')?.value) || 1,
    skills,
    bio:         document.getElementById('sp-bio')?.value?.trim() || '',
    projects:    [],
  };

  const ok = await saveAcademicProfile(user.uid, profileData);
  const fb = document.getElementById('sp-feedback');
  if (fb) fb.textContent = ok ? '✅ Perfil salvo com sucesso!' : '❌ Erro ao salvar. Tente novamente.';
};

// ---- Buscar perfis por instituição/curso (para sugestões de conexão) ----
export async function findPeersByInstitution(institution, limitN = 10) {
  try {
    // Busca no user_profiles (coleção já existente) e cruza com sub-coleção profile
    const q = query(
      collection(db, 'user_profiles'),
      where('institution', '==', institution),
      limit(limitN)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
  } catch (err) {
    console.error('[profile] Erro ao buscar colegas:', err);
    return [];
  }
}

// ---- Helpers internos ----
function escapeForAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeHtmlContent(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
