// ===== SOCIAL: PROFILE.JS =====
// Perfil acadêmico público — NOVO MÓDULO
// Não altera nenhuma função existente. Apenas adiciona novas.

import { db, auth } from '../firebase.js';
import { getFacapeData } from '../facape.js';

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
    const { FACAPE_COURSES } = await import('./turmas.js');
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

  const PERIOD_LABELS = { matutino:'Matutino', vespertino:'Vespertino', noturno:'Noturno', integral:'Integral', ead:'EaD' };
  const hasFacape   = profile._fromFacape;
  const institution = 'FACAPE – Faculdade de Petrolina';
  const course      = profile.course    || '';
  const semester    = profile.semester  || '';
  const period      = profile.period    || '';
  const periodStr   = PERIOD_LABELS[period] || period;
  const subjects    = profile._stateSubjectNames || [];

  const roStyle = 'opacity:0.6;cursor:not-allowed;background:rgba(255,255,255,0.04);border-color:rgba(255,255,255,0.08);';

  panel.innerHTML = `
    <div class="accs-academic-banner">
      <div class="accs-academic-banner-icon">🎓</div>
      <div class="accs-academic-banner-info">
        <div class="accs-academic-banner-title">${institution}</div>
        <div class="accs-academic-banner-sub">${escapeHtmlContent(course || 'Conecte-se ao Portal do Aluno')}</div>
      </div>
    </div>

    <div class="social-profile-form">

      ${hasFacape ? `
        <div style="background:rgba(46,213,115,0.08);border:1px solid rgba(46,213,115,0.25);border-radius:10px;padding:10px 14px;font-size:12px;color:rgba(255,255,255,0.6);display:flex;align-items:center;gap:8px">
          ✅ <span>Dados preenchidos via <strong style="color:#2ed573">Portal do Aluno FACAPE</strong></span>
        </div>
      ` : `
        <div style="background:rgba(255,165,0,0.08);border:1px solid rgba(255,165,0,0.25);border-radius:10px;padding:10px 14px;font-size:12px;color:rgba(255,255,255,0.6);display:flex;align-items:center;gap:8px">
          ⚠️ <span>Conecte-se ao <strong style="color:#ffa502">Portal do Aluno FACAPE</strong> para preencher automaticamente.</span>
        </div>
      `}

      <div class="accs-form-group">
        <label class="accs-label">Instituição</label>
        <input class="accs-input" type="text" value="${institution}" readonly style="${roStyle}">
        <input type="hidden" id="sp-institution" value="${institution}">
      </div>

      <div class="accs-form-group">
        <label class="accs-label">Curso</label>
        <input class="accs-input" type="text"
          value="${escapeForAttr(course)}"
          placeholder="Sincronize com o Portal do Aluno"
          readonly style="${roStyle}">
        <input type="hidden" id="sp-course" value="${escapeForAttr(course)}">
      </div>

      <div style="display:flex;gap:10px">
        <div class="accs-form-group" style="flex:1">
          <label class="accs-label">Período</label>
          <input class="accs-input" type="text"
            value="${semester ? semester + 'º' : ''}" placeholder="—"
            readonly style="${roStyle}">
          <input type="hidden" id="sp-semester" value="${semester}">
        </div>
        <div class="accs-form-group" style="flex:1">
          <label class="accs-label">Turno</label>
          <input class="accs-input" type="text"
            value="${escapeForAttr(periodStr)}" placeholder="—"
            readonly style="${roStyle}">
          <input type="hidden" id="sp-period" value="${escapeForAttr(period)}">
        </div>
      </div>

      ${subjects.length ? `
        <div class="accs-form-group">
          <label class="accs-label">Matérias do semestre</label>
          <div style="display:flex;flex-wrap:wrap;gap:6px;padding:6px 0">
            ${subjects.map(n => `<span class="accs-skill-tag" style="background:rgba(46,213,115,0.12);border-color:rgba(46,213,115,0.25);color:#2ed573">${escapeHtmlContent(n)}</span>`).join('')}
          </div>
        </div>
      ` : ''}

      <div class="accs-form-group">
        <label class="accs-label">Bio Acadêmica <span style="font-size:11px;color:rgba(255,255,255,0.35)">(opcional)</span></label>
        <textarea id="sp-bio" class="accs-input" rows="3"
          placeholder="Conte sobre seus interesses e objetivos acadêmicos...">${escapeHtmlContent(profile.bio || '')}</textarea>
      </div>

      <button class="accs-save-btn" onclick="window.saveAcademicProfileUI()" style="background:linear-gradient(135deg,#6c63ff,#a89dff)">
        💾 Salvar Perfil Acadêmico
      </button>

      <div id="sp-feedback"></div>
    </div>
  `;
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
    period:      document.getElementById('sp-period')?.value?.trim() || '',
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