// ===== SOCIAL: PROFILE.JS =====
// Perfil acadêmico + perfil público com stats, avatar upload, follow button

import { db, auth, storage, ref, uploadBytes, getDownloadURL } from '../firebase.js';
import { getFacapeData } from '../facape.js';
import { FACAPE_COURSES } from './turmas.js';

import {
  doc, getDoc, setDoc, updateDoc, collection, query, where,
  getDocs, limit, orderBy,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── Normalização de nome de curso (FACAPE portal → FACAPE_COURSES) ─────────────
function _normName(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ').trim();
}

function _findCourse(courseName) {
  if (!courseName) return null;
  const n = _normName(courseName);
  return FACAPE_COURSES.find(c => _normName(c.name) === n) || null;
}

// ── Salvar perfil acadêmico ───────────────────────────────────────────────────
export async function saveAcademicProfile(uid, profileData) {
  const courseMatch  = _findCourse(profileData.course) || FACAPE_COURSES.find(c => c.id === profileData.courseId);
  const courseId     = profileData.courseId    || courseMatch?.id    || '';
  const courseSigla  = profileData.courseSigla || courseMatch?.sigla || '';

  // 1. Operação crítica — subcoleção academic
  try {
    await setDoc(doc(db, 'users', uid, 'profile', 'academic'), {
      institution: profileData.institution || '',
      course:      profileData.course      || '',
      courseId,
      courseSigla,
      semester:    profileData.semester    || 1,
      period:      profileData.period      || '',
      skills:      profileData.skills      || [],
      bio:         profileData.bio         || '',
      projects:    profileData.projects    || [],
      updatedAt:   new Date().toISOString(),
    }, { merge: true });
  } catch (err) {
    console.error('[profile] Erro ao salvar academic:', err.code, err.message);
    return false;
  }

  // 2. Inicializa contadores sociais — não-fatal
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    if (!snap.exists() || !snap.data()?.social) {
      await updateDoc(doc(db, 'users', uid), {
        'social.followers': 0, 'social.following': 0, 'social.reputation': 0,
      });
    }
  } catch (err) {
    console.warn('[profile] social stats init:', err.code);
  }

  // 3. Espelha em user_profiles — não-fatal
  try {
    const displayName = auth.currentUser?.displayName || auth.currentUser?.email?.split('@')[0] || '';
    await setDoc(doc(db, 'user_profiles', uid), {
      institution: profileData.institution || '',
      course:      profileData.course      || '',
      courseId,
      courseSigla,
      semester:    profileData.semester    || 1,
      period:      profileData.period      || '',
      displayName,
      updatedAt:   new Date().toISOString(),
    }, { merge: true });
  } catch (err) {
    console.warn('[profile] user_profiles espelho:', err.code);
  }

  return true;
}

// ── Carregar perfil acadêmico ──────────────────────────────────────────────────
export async function loadAcademicProfile(uid) {
  try {
    const snap = await getDoc(doc(db, 'users', uid, 'profile', 'academic'));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.error('[profile] loadAcademicProfile:', err);
    return null;
  }
}

// ── Stats sociais ──────────────────────────────────────────────────────────────
export async function loadSocialStats(uid) {
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    if (snap.exists()) return snap.data().social || { followers: 0, following: 0, reputation: 0 };
    return { followers: 0, following: 0, reputation: 0 };
  } catch { return { followers: 0, following: 0, reputation: 0 }; }
}

// ── Buscar perfis por instituição ──────────────────────────────────────────────
export async function findPeersByInstitution(institution, limitN = 10) {
  try {
    const q = query(
      collection(db, 'user_profiles'),
      where('institution', '==', institution),
      limit(limitN)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
  } catch (err) {
    console.error('[profile] findPeers:', err);
    return [];
  }
}

// ── Inferir dados do FACAPE + STATE ───────────────────────────────────────────
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
    if      (p.includes('noturno'))  filled.period = 'noturno';
    else if (p.includes('matutin'))  filled.period = 'matutino';
    else if (p.includes('vespert'))  filled.period = 'vespertino';
    else if (p.includes('integral')) filled.period = 'integral';
  }

  // Resolve courseId/courseSigla com normalização
  if (!filled.courseId && filled.course) {
    const match = _findCourse(filled.course);
    if (match) { filled.courseId = match.id; filled.courseSigla = match.sigla; }
  }

  filled._fromFacape         = !!(facape);
  filled._stateSubjectNames  = stateSubjects.map(s => s.name || s.nome || '').filter(Boolean);
  return filled;
}

// ── Render: painel de conta (accs-sub-body) ────────────────────────────────────
export async function renderAcademicProfileSection(uid) {
  const panel = document.getElementById('accs-sub-body');
  if (!panel) return;

  panel.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
      gap:12px;padding:40px 20px;color:rgba(255,255,255,0.4)">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="1.5" style="animation:spin 1s linear infinite">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4
          M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
      </svg>
      <span style="font-size:13px">Carregando perfil…</span>
    </div>
    <style>@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}</style>
  `;

  const [saved, social] = await Promise.all([
    loadAcademicProfile(uid).catch(() => null),
    loadSocialStats(uid).catch(() => ({ followers: 0, following: 0, reputation: 0 })),
  ]);

  const profile   = _inferAcademicData(saved || {});
  const PERIOD_LBL = { matutino:'Matutino', vespertino:'Vespertino', noturno:'Noturno', integral:'Integral', ead:'EaD' };
  const hasFacape  = profile._fromFacape;
  const institution = 'FACAPE – Faculdade de Petrolina';
  const course      = profile.course   || '';
  const semester    = profile.semester || '';
  const period      = profile.period   || '';
  const periodStr   = PERIOD_LBL[period] || period;
  const subjects    = profile._stateSubjectNames || [];

  // Avatar URL (opcional)
  let avatarHtml = '';
  try {
    const avatarUrl = await getDownloadURL(ref(storage, `avatars/${uid}.jpg`));
    avatarHtml = `<img src="${avatarUrl}" class="profile-avatar-img" alt="avatar">`;
  } catch {
    const initials = (auth.currentUser?.displayName || 'U').slice(0, 2).toUpperCase();
    avatarHtml = `<div class="profile-avatar-initials">${initials}</div>`;
  }

  const roStyle = 'opacity:.6;cursor:not-allowed;background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08);';

  panel.innerHTML = `
    <!-- Avatar + Stats -->
    <div class="accs-avatar-section">
      <div class="accs-avatar-wrap" onclick="window._uploadAvatar('${uid}')">
        ${avatarHtml}
        <div class="accs-avatar-overlay">📷</div>
        <input type="file" id="avatar-input" accept="image/jpeg,image/png" style="display:none"
          onchange="window._saveAvatar(this,'${uid}')">
      </div>
      <div class="accs-stats-row">
        <div class="accs-stat"><div class="accs-stat-n">${social.followers  || 0}</div><div class="accs-stat-l">Seguidores</div></div>
        <div class="accs-stat"><div class="accs-stat-n">${social.following  || 0}</div><div class="accs-stat-l">Seguindo</div></div>
        <div class="accs-stat"><div class="accs-stat-n">${social.reputation || 0}</div><div class="accs-stat-l">Reputação</div></div>
      </div>
    </div>

    <!-- Banner instituição -->
    <div class="accs-academic-banner">
      <div class="accs-academic-banner-icon">🎓</div>
      <div class="accs-academic-banner-info">
        <div class="accs-academic-banner-title">${institution}</div>
        <div class="accs-academic-banner-sub">${_esc(course || 'Conecte-se ao Portal do Aluno')}</div>
      </div>
    </div>

    <div class="social-profile-form">
      ${hasFacape
        ? `<div class="accs-info-banner accs-info-green">✅ <span>Dados preenchidos via <strong>Portal do Aluno FACAPE</strong></span></div>`
        : `<div class="accs-info-banner accs-info-orange">⚠️ <span>Conecte-se ao <strong>Portal do Aluno FACAPE</strong> para preencher automaticamente.</span></div>`
      }

      <div class="accs-form-group">
        <label class="accs-label">Instituição</label>
        <input class="accs-input" type="text" value="${institution}" readonly style="${roStyle}">
        <input type="hidden" id="sp-institution" value="${institution}">
      </div>

      <div class="accs-form-group">
        <label class="accs-label">Curso</label>
        <input class="accs-input" type="text" value="${_escAttr(course)}"
          placeholder="Sincronize com o Portal do Aluno" readonly style="${roStyle}">
        <input type="hidden" id="sp-course"      value="${_escAttr(course)}">
        <input type="hidden" id="sp-courseId"    value="${_escAttr(profile.courseId    || '')}">
        <input type="hidden" id="sp-courseSigla" value="${_escAttr(profile.courseSigla || '')}">
      </div>

      <div style="display:flex;gap:10px">
        <div class="accs-form-group" style="flex:1">
          <label class="accs-label">Período</label>
          <input class="accs-input" type="text" value="${semester ? semester + 'º' : ''}"
            placeholder="—" readonly style="${roStyle}">
          <input type="hidden" id="sp-semester" value="${semester}">
        </div>
        <div class="accs-form-group" style="flex:1">
          <label class="accs-label">Turno</label>
          <input class="accs-input" type="text" value="${_escAttr(periodStr)}"
            placeholder="—" readonly style="${roStyle}">
          <input type="hidden" id="sp-period" value="${_escAttr(period)}">
        </div>
      </div>

      ${subjects.length ? `
        <div class="accs-form-group">
          <label class="accs-label">Matérias do semestre</label>
          <div style="display:flex;flex-wrap:wrap;gap:6px;padding:6px 0">
            ${subjects.map(n => `<span class="accs-skill-tag" style="background:rgba(46,213,115,.12);border-color:rgba(46,213,115,.25);color:#2ed573">${_esc(n)}</span>`).join('')}
          </div>
        </div>
      ` : ''}

      <div class="accs-form-group">
        <label class="accs-label">Bio Acadêmica <span style="font-size:11px;opacity:.35">(opcional)</span></label>
        <textarea id="sp-bio" class="accs-input" rows="3"
          placeholder="Conte sobre seus interesses e objetivos acadêmicos…">${_esc(profile.bio || '')}</textarea>
      </div>

      <button class="accs-save-btn" onclick="window.saveAcademicProfileUI()"
        style="background:linear-gradient(135deg,#6c63ff,#a89dff)">
        💾 Salvar Perfil Acadêmico
      </button>

      <div id="sp-feedback"></div>
    </div>
  `;

  _injectProfileStyles();
}

// ── Handler: salvar perfil ─────────────────────────────────────────────────────
window.saveAcademicProfileUI = async function() {
  const user = auth.currentUser;
  if (!user) return;

  const btn = document.querySelector('.accs-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Salvando…'; }

  const profileData = {
    institution:  document.getElementById('sp-institution')?.value?.trim()  || '',
    course:       document.getElementById('sp-course')?.value?.trim()       || '',
    courseId:     document.getElementById('sp-courseId')?.value?.trim()     || '',
    courseSigla:  document.getElementById('sp-courseSigla')?.value?.trim()  || '',
    semester:     parseInt(document.getElementById('sp-semester')?.value)   || 1,
    period:       document.getElementById('sp-period')?.value?.trim()       || '',
    skills:       [],
    bio:          document.getElementById('sp-bio')?.value?.trim()          || '',
    projects:     [],
  };

  const ok = await saveAcademicProfile(user.uid, profileData);
  const fb = document.getElementById('sp-feedback');

  if (btn) { btn.disabled = false; btn.textContent = '💾 Salvar Perfil Acadêmico'; }

  if (fb) {
    if (ok) {
      fb.innerHTML = `
        <div class="accs-save-feedback">✅ Perfil salvo com sucesso!</div>
        <button onclick="window.navigateTo?.('social')"
          style="display:block;margin-top:10px;padding:10px 24px;
            background:var(--accent,#7c5cfc);color:#fff;border:none;border-radius:20px;
            font-size:14px;font-weight:700;cursor:pointer;width:100%">
          Ver minha turma →
        </button>`;
      setTimeout(() => { if (fb) fb.innerHTML = ''; }, 5000);
    } else {
      fb.innerHTML = `
        <div class="accs-save-feedback"
          style="background:rgba(224,82,82,.12);border-color:rgba(224,82,82,.25);color:#e05252">
          ❌ Erro ao salvar. Verifique sua conexão e tente novamente.
        </div>`;
    }
  }
};

// ── Avatar upload ──────────────────────────────────────────────────────────────
window._uploadAvatar = function(uid) {
  document.getElementById('avatar-input')?.click();
};

window._saveAvatar = async function(input, uid) {
  const file = input.files?.[0];
  if (!file) return;

  const wrap = document.querySelector('.accs-avatar-wrap');
  if (wrap) wrap.style.opacity = '0.5';

  try {
    const imgRef = ref(storage, `avatars/${uid}.jpg`);
    await uploadBytes(imgRef, file);
    const url = await getDownloadURL(imgRef);

    const img = document.querySelector('.accs-avatar-img');
    if (img) {
      img.src = url;
    } else {
      const initEl = document.querySelector('.accs-avatar-initials');
      if (initEl) {
        initEl.outerHTML = `<img src="${url}" class="accs-avatar-img profile-avatar-img" alt="avatar">`;
      }
    }
  } catch (err) {
    console.error('[profile] avatar upload:', err);
  } finally {
    if (wrap) wrap.style.opacity = '1';
  }
};

// ── Perfil Público (modal) ─────────────────────────────────────────────────────
window.openPublicProfile = async function(uid) {
  if (!uid) return;
  const overlay = document.getElementById('modal-overlay');
  const body    = document.getElementById('modal-body');
  if (!overlay || !body) return;

  body.innerHTML = `<div style="text-align:center;padding:48px;color:rgba(255,255,255,.4)">⏳ Carregando perfil…</div>`;
  overlay.classList.add('active');
  document.getElementById('modal-container')?.classList.add('active');

  const currentUser = auth.currentUser;
  const isOwn = currentUser?.uid === uid;

  const [profileSnap, userSnap, postsSnap] = await Promise.all([
    getDoc(doc(db, 'users', uid, 'profile', 'academic')).catch(() => null),
    getDoc(doc(db, 'users', uid)).catch(() => null),
    getDocs(query(
      collection(db, 'posts'),
      where('authorId', '==', uid),
      orderBy('createdAt', 'desc'),
      limit(8)
    )).catch(() => null),
  ]);

  const profile    = profileSnap?.exists() ? profileSnap.data()  : {};
  const userData   = userSnap?.exists()    ? userSnap.data()     : {};
  const social     = userData.social || {};
  const posts      = postsSnap?.docs.map(d => ({ id: d.id, ...d.data() })) || [];

  // Verifica follow
  let following = false;
  if (currentUser && !isOwn) {
    try {
      const myConn = await getDoc(doc(db, 'connections', currentUser.uid));
      following = myConn.exists() && (myConn.data().following || []).includes(uid);
    } catch { /* noop */ }
  }

  const name       = _esc(userData.displayName || profile.displayName || 'Usuário');
  const course     = profile.course   || '';
  const semester   = profile.semester || '';
  const period     = profile.period   || '';
  const PERIOD_LBL = { matutino:'Matutino', vespertino:'Vespertino', noturno:'Noturno', integral:'Integral', ead:'EaD' };
  const periodStr  = PERIOD_LBL[period] || period;
  const bio        = profile.bio || '';

  const TYPE_ICONS = { doubt:'❓', material:'📚', achievement:'🏆', flashcard:'🃏' };

  // Avatar
  let avatarHtml = `<div class="pub-avatar-initials">${name.slice(0,2).toUpperCase()}</div>`;
  try {
    const url = await getDownloadURL(ref(storage, `avatars/${uid}.jpg`));
    avatarHtml = `<img src="${url}" class="pub-avatar-img" alt="${name}">`;
  } catch { /* usa iniciais */ }

  body.innerHTML = `
    <div class="pub-profile">
      <div class="pub-profile-header">
        <div class="pub-avatar-wrap">${avatarHtml}</div>
        <div class="pub-profile-info">
          <h3 class="pub-name">${name}</h3>
          ${course ? `<span class="pub-course-badge">
            ${_esc(course)}${semester ? ` · ${semester}º` : ''}${periodStr ? ` · ${periodStr}` : ''}
          </span>` : ''}
          ${bio ? `<p class="pub-bio">${_esc(bio)}</p>` : ''}
        </div>
      </div>

      <div class="pub-stats">
        <div class="pub-stat"><div class="pub-stat-n">${posts.length}</div><div class="pub-stat-l">Posts</div></div>
        <div class="pub-stat"><div class="pub-stat-n">${social.followers  || 0}</div><div class="pub-stat-l">Seguidores</div></div>
        <div class="pub-stat"><div class="pub-stat-n">${social.following  || 0}</div><div class="pub-stat-l">Seguindo</div></div>
        <div class="pub-stat"><div class="pub-stat-n">${social.reputation || 0}</div><div class="pub-stat-l">Reputação</div></div>
      </div>

      ${!isOwn ? `
        <button id="pub-follow-btn"
          class="pub-follow-btn${following ? ' btn-secondary' : ''}"
          onclick="window._pubToggleFollow('${uid}')">
          ${following ? '✔ Seguindo' : '➕ Seguir'}
        </button>
      ` : `
        <button class="pub-follow-btn" onclick="window.closeModal?.()">
          ✏️ Editar meu perfil
        </button>
      `}

      <div class="pub-posts-section">
        <div class="feed-section-label">📝 Posts recentes</div>
        ${posts.length
          ? posts.map(p => `
              <div class="pub-post-item" onclick="window.closeModal?.()">
                <span class="pub-post-icon">${TYPE_ICONS[p.type] || '📝'}</span>
                <div class="pub-post-body">
                  <div class="pub-post-text">${_esc((p.content || '').slice(0, 120))}${(p.content || '').length > 120 ? '…' : ''}</div>
                  <div class="pub-post-meta">❤️ ${(p.likes_uids || []).length} · 💬 ${(p.replies || []).length}</div>
                </div>
              </div>`)
            .join('')
          : `<div class="feed-empty" style="padding:20px 0">Nenhum post ainda.</div>`
        }
      </div>
    </div>
  `;

  _injectProfileStyles();
};

window._pubToggleFollow = async function(targetUid) {
  const { followUser, unfollowUser, isFollowing } = await import('./connections.js');
  const user = auth.currentUser;
  if (!user) return;

  const btn = document.getElementById('pub-follow-btn');
  const already = await isFollowing(user.uid, targetUid);

  if (already) {
    await unfollowUser(user.uid, targetUid);
    if (btn) { btn.textContent = '➕ Seguir'; btn.classList.remove('btn-secondary'); }
  } else {
    await followUser(user.uid, targetUid);
    if (btn) { btn.textContent = '✔ Seguindo'; btn.classList.add('btn-secondary'); }
  }
};

// ── Helpers ────────────────────────────────────────────────────────────────────
function _esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function _escAttr(str) {
  return String(str || '').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Estilos injetados ──────────────────────────────────────────────────────────
function _injectProfileStyles() {
  if (document.getElementById('profile-social-styles')) return;
  const s = document.createElement('style');
  s.id = 'profile-social-styles';
  s.textContent = `
    /* ── Avatar section ── */
    .accs-avatar-section {
      display:flex; align-items:center; gap:16px;
      padding: 12px 0 16px;
    }
    .accs-avatar-wrap {
      position:relative; width:72px; height:72px;
      border-radius:50%; overflow:hidden; cursor:pointer; flex-shrink:0;
      border:2px solid var(--border,#2a2a3e);
    }
    .accs-avatar-wrap:hover .accs-avatar-overlay { opacity:1; }
    .accs-avatar-overlay {
      position:absolute; inset:0; background:rgba(0,0,0,.55);
      display:flex; align-items:center; justify-content:center;
      font-size:20px; opacity:0; transition:opacity .2s;
    }
    .profile-avatar-img, .accs-avatar-img {
      width:100%; height:100%; object-fit:cover; display:block;
    }
    .accs-avatar-initials {
      width:100%; height:100%;
      background:var(--accent,#7c5cfc);
      display:flex; align-items:center; justify-content:center;
      font-size:24px; font-weight:800; color:#fff;
    }

    /* ── Stats row ── */
    .accs-stats-row {
      display:flex; gap:16px; flex:1;
    }
    .accs-stat { text-align:center; }
    .accs-stat-n { font-size:18px; font-weight:800; color:var(--text,#fff); }
    .accs-stat-l { font-size:11px; color:rgba(255,255,255,.4); }

    /* ── Info banners ── */
    .accs-info-banner {
      display:flex; align-items:center; gap:8px;
      border-radius:10px; padding:10px 14px;
      font-size:12px; color:rgba(255,255,255,.6);
    }
    .accs-info-green { background:rgba(46,213,115,.08); border:1px solid rgba(46,213,115,.25); }
    .accs-info-orange{ background:rgba(255,165,0,.08);  border:1px solid rgba(255,165,0,.25);  }
    .accs-info-green strong { color:#2ed573; }
    .accs-info-orange strong { color:#ffa502; }

    /* ── Public profile modal ── */
    .pub-profile { display:flex; flex-direction:column; gap:12px; }
    .pub-profile-header { display:flex; gap:14px; align-items:flex-start; }
    .pub-avatar-wrap {
      width:64px; height:64px; border-radius:50%; overflow:hidden;
      flex-shrink:0; border:2px solid var(--border,#2a2a3e);
    }
    .pub-avatar-initials {
      width:100%; height:100%; background:var(--accent,#7c5cfc);
      display:flex; align-items:center; justify-content:center;
      font-size:22px; font-weight:800; color:#fff;
    }
    .pub-avatar-img { width:100%; height:100%; object-fit:cover; }
    .pub-profile-info { flex:1; }
    .pub-name { margin:0 0 4px; font-size:17px; font-weight:800; color:var(--text,#fff); }
    .pub-course-badge {
      display:inline-block; font-size:11px; font-weight:600;
      color:var(--accent,#7c5cfc); background:rgba(124,92,252,.12);
      border-radius:10px; padding:2px 8px; margin-bottom:4px;
    }
    .pub-bio { margin:4px 0 0; font-size:13px; color:rgba(255,255,255,.55); }

    .pub-stats {
      display:grid; grid-template-columns:repeat(4,1fr);
      gap:4px; padding:12px 0;
      border-top:1px solid var(--border,#2a2a3e);
      border-bottom:1px solid var(--border,#2a2a3e);
    }
    .pub-stat { text-align:center; }
    .pub-stat-n { font-size:17px; font-weight:800; color:var(--text,#fff); }
    .pub-stat-l { font-size:10px; color:rgba(255,255,255,.4); }

    .pub-follow-btn {
      width:100%; padding:11px; border:none;
      background:var(--accent,#7c5cfc); color:#fff;
      border-radius:12px; font-size:14px; font-weight:700;
      cursor:pointer; transition:opacity .15s;
    }
    .pub-follow-btn:hover { opacity:.88; }
    .pub-follow-btn.btn-secondary {
      background:rgba(255,255,255,.06);
      border:1px solid var(--border,#2a2a3e);
      color:rgba(255,255,255,.6);
    }

    .pub-posts-section { display:flex; flex-direction:column; gap:0; }
    .pub-post-item {
      display:flex; gap:10px; align-items:flex-start;
      padding:10px 0; border-bottom:1px solid rgba(255,255,255,.05);
      cursor:pointer;
    }
    .pub-post-item:last-child { border-bottom:none; }
    .pub-post-icon { font-size:18px; flex-shrink:0; margin-top:1px; }
    .pub-post-body { flex:1; }
    .pub-post-text { font-size:13px; color:rgba(255,255,255,.8); line-height:1.45; }
    .pub-post-meta { font-size:11px; color:rgba(255,255,255,.35); margin-top:3px; }
  `;
  document.head.appendChild(s);
}
