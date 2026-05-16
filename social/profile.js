// ===== SOCIAL: PROFILE.JS =====
// Perfil acadêmico público — NOVO MÓDULO
// Não altera nenhuma função existente. Apenas adiciona novas.

import { db, auth } from '../firebase.js';
import { getFacapeData } from '../facape.js';
import { FACAPE_COURSES } from './turmas.js';

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

    // Espelha dados acadêmicos em user_profiles/{uid} para queries de descoberta
    const courseMatch = FACAPE_COURSES.find(c =>
      c.name === profileData.course || c.id === profileData.course
    );
    const courseId   = courseMatch?.id   || profileData.courseId   || '';
    const courseSigla = courseMatch?.sigla || profileData.courseSigla || '';
    const displayName = auth.currentUser?.displayName || auth.currentUser?.email?.split('@')[0] || '';

    await setDoc(doc(db, 'user_profiles', uid), {
      institution:  profileData.institution || '',
      course:       profileData.course      || '',
      courseId,
      courseSigla,
      semester:     profileData.semester    || 1,
      period:       profileData.period      || '',
      displayName,
      updatedAt:    new Date().toISOString(),
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

// ---- Inferir dados acadêmicos do app (FACAPE + STATE) ----
function _inferAcademicData(profile) {
  const facape = getFacapeData();
  const stateSubjects = window._STATE_subjects?.() || [];
  const filled = { ...profile };

  if (!filled.institution && facape) filled.institution = 'FACAPE – Faculdade de Petrolina';

  if (!filled.course && facape?.curso) filled.course = facape.curso;

  if (!filled.semester && facape?.periodo) {
    const m = facape.periodo.match(/(\d+)/);
    if (m) filled.semester = parseInt(m[1]);
  }

  if (!filled.period && facape?.periodo) {
    const p = facape.periodo.toLowerCase();
    if (p.includes('noturno'))      filled.period = 'noturno';
    else if (p.includes('matutin')) filled.period = 'matutino';
    else if (p.includes('vespert')) filled.period = 'vespertino';
    else if (p.includes('integral')) filled.period = 'integral';
  }

  filled._fromFacape = !!(facape);
  filled._facapeNome = facape?.nome || '';
  filled._stateSubjectNames = stateSubjects.map(s => s.name || s.nome || '').filter(Boolean);

  return filled;
}

// ---- Renderizar página de perfil no painel de conta (accs-sub-body) ----
export async function renderAcademicProfileSection(uid) {
  const panel = document.getElementById('accs-sub-body');
  if (!panel) return;

  panel.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:40px 20px;color:rgba(255,255,255,0.4)">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="animation:spin 1s linear infinite">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
      </svg>
      <span style="font-size:13px">Carregando perfil...</span>
    </div>
    <style>@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}</style>
  `;

  const saved = await loadAcademicProfile(uid) || {};
  const profile = _inferAcademicData(saved);
  const socialStats = await loadSocialStats(uid);

  const skillsList = (profile.skills || []).join(', ');
  const autoSrc = profile._fromFacape ? 'Portal do Aluno FACAPE' : null;
  const readonlyAttr = autoSrc ? 'readonly' : '';
  const readonlyStyle = autoSrc
    ? 'opacity:0.65;cursor:not-allowed;background:rgba(255,255,255,0.04);'
    : '';

  const periodLabel = { matutino:'Matutino', vespertino:'Vespertino', noturno:'Noturno', integral:'Integral', ead:'EaD' };

  panel.innerHTML = `
    <!-- Banner do perfil -->
    <div class="accs-academic-banner">
      <div class="accs-academic-banner-icon">🎓</div>
      <div class="accs-academic-banner-info">
        <div class="accs-academic-banner-title">${escapeHtmlContent(profile.institution || 'Perfil Acadêmico')}</div>
        <div class="accs-academic-banner-sub">${escapeHtmlContent(profile.course || 'Configure sua instituição e curso abaixo')}</div>
      </div>
    </div>

    <!-- Stats rápidas -->
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
      <div style="background:#2c2c2e;border-radius:12px;padding:12px;text-align:center">
        <div style="font-size:20px;font-weight:800;color:#6c63ff">${socialStats.followers || 0}</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.45);margin-top:2px">Seguidores</div>
      </div>
      <div style="background:#2c2c2e;border-radius:12px;padding:12px;text-align:center">
        <div style="font-size:20px;font-weight:800;color:#2ed573">${profile.semester || '—'}</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.45);margin-top:2px">Semestre</div>
      </div>
      <div style="background:#2c2c2e;border-radius:12px;padding:12px;text-align:center">
        <div style="font-size:20px;font-weight:800;color:#ffa502">${(profile.skills || []).length}</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.45);margin-top:2px">Habilidades</div>
      </div>
    </div>

    <!-- Formulário -->
    <div class="social-profile-form">

      ${autoSrc ? `
        <div style="background:rgba(108,99,255,0.12);border:1px solid rgba(108,99,255,0.3);border-radius:10px;padding:10px 12px;font-size:12px;color:rgba(255,255,255,0.6);margin-bottom:4px">
          🔗 Instituição, curso e semestre preenchidos automaticamente via <strong style="color:#a89dff">${escapeHtmlContent(autoSrc)}</strong>. Preencha apenas suas habilidades e bio.
        </div>
      ` : ''}

      <div class="accs-form-group">
        <label class="accs-label">Instituição</label>
        <input id="sp-institution" class="accs-input" type="text"
          placeholder="Ex: UFPE, USP, IFPE..."
          value="${escapeForAttr(profile.institution || '')}"
          ${readonlyAttr} style="${readonlyStyle}">
      </div>

      <div class="accs-form-group">
        <label class="accs-label">Curso</label>
        <input id="sp-course" class="accs-input" type="text"
          placeholder="Ex: Engenharia de Software"
          value="${escapeForAttr(profile.course || '')}"
          ${readonlyAttr} style="${readonlyStyle}">
      </div>

      <div style="display:flex;gap:10px">
        <div class="accs-form-group" style="flex:1">
          <label class="accs-label">Semestre</label>
          <input id="sp-semester" class="accs-input" type="number"
            min="1" max="20" placeholder="1"
            value="${profile.semester || 1}"
            ${readonlyAttr} style="${readonlyStyle}max-width:100px">
        </div>
        ${profile.period ? `
        <div class="accs-form-group" style="flex:1">
          <label class="accs-label">Período</label>
          <input class="accs-input" type="text"
            value="${escapeForAttr(periodLabel[profile.period] || profile.period)}"
            readonly style="${readonlyStyle}">
        </div>` : ''}
      </div>

      ${profile._stateSubjectNames?.length ? `
        <div class="accs-form-group">
          <label class="accs-label">Matérias detectadas</label>
          <div style="display:flex;flex-wrap:wrap;gap:6px;padding:8px 0">
            ${profile._stateSubjectNames.map(n => `<span class="accs-skill-tag" style="background:rgba(46,213,115,0.12);border-color:rgba(46,213,115,0.25);color:#2ed573">${escapeHtmlContent(n)}</span>`).join('')}
          </div>
        </div>
      ` : ''}

      <div class="accs-form-group">
        <label class="accs-label">Habilidades / Matérias destaque</label>
        <input id="sp-skills" class="accs-input" type="text"
          placeholder="Ex: Python, Cálculo, UX (separado por vírgula)"
          value="${escapeForAttr(skillsList)}">
        <div class="accs-skills-preview" id="sp-skills-preview">
          ${(profile.skills || []).map(s => `<span class="accs-skill-tag">${escapeHtmlContent(s)}</span>`).join('')}
        </div>
      </div>

      <div class="accs-form-group">
        <label class="accs-label">Bio Acadêmica</label>
        <textarea id="sp-bio" class="accs-input" rows="3"
          placeholder="Conte sobre seus interesses e objetivos acadêmicos...">${escapeHtmlContent(profile.bio || '')}</textarea>
      </div>

      <button class="accs-save-btn" onclick="window.saveAcademicProfileUI()" style="background:linear-gradient(135deg,#6c63ff,#a89dff)">
        💾 Salvar Perfil Acadêmico
      </button>

      <div id="sp-feedback"></div>
    </div>
  `;

  const skillsInput = document.getElementById('sp-skills');
  if (skillsInput) {
    skillsInput.addEventListener('input', () => {
      const tags = skillsInput.value.split(',').map(s => s.trim()).filter(Boolean);
      const preview = document.getElementById('sp-skills-preview');
      if (preview) {
        preview.innerHTML = tags.map(s => `<span class="accs-skill-tag">${escapeHtmlContent(s)}</span>`).join('');
      }
    });
  }
}

// ---- Handler chamado pelo onclick do botão salvar ----
window.saveAcademicProfileUI = async function() {
  const user = auth.currentUser;
  if (!user) return;

  const btn = document.querySelector('.accs-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Salvando...'; }

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

  if (btn) {
    btn.disabled = false;
    btn.textContent = '💾 Salvar Perfil Acadêmico';
  }

  if (fb) {
    if (ok) {
      fb.innerHTML = `
        <div class="accs-save-feedback">✅ Perfil salvo com sucesso!</div>
        <button
          onclick="window.navigateTo('social')"
          style="display:block;margin-top:10px;padding:10px 24px;background:var(--accent,#7c5cfc);color:#fff;border:none;border-radius:20px;font-size:14px;font-weight:700;cursor:pointer;width:100%">
          Ver minha turma →
        </button>
      `;
      setTimeout(() => { if (fb) fb.innerHTML = ''; }, 5000);
    } else {
      fb.innerHTML = `<div class="accs-save-feedback" style="background:rgba(224,82,82,0.12);border-color:rgba(224,82,82,0.25);color:#e05252">❌ Erro ao salvar. Tente novamente.</div>`;
    }
  }
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