// ===== SOCIAL-PAGE.JS =====
// 2025-05-15 — Atualizado para inicializar grupos corretamente e
// acionar renderNotificationsPanel ao abrir a aba de notificações.

window._renderSocialPage = async function() {
  const { auth } = await import('./firebase.js');
  const user = auth.currentUser;
  if (!user) return;

  const { renderDiscoverSection } = await import('./social/connections.js');
  const { renderGroupsSection }   = await import('./social/groups.js');
  const { renderTurmasTab, initTurmas, loadFullAcademicProfile } = await import('./social/turmas.js');
  const { initFeed, renderFeed }  = await import('./social/feed.js');

  // Inicializa módulos
  initTurmas();
  initFeed();

  // Verifica perfil acadêmico — exibe gate se incompleto
  const profile = await loadFullAcademicProfile(user.uid).catch(() => null);
  if (!profile?.courseId || !profile?.subjects?.length) {
    const turmasContent = document.getElementById('turmas-tab-content');
    if (turmasContent) {
      turmasContent.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:48px 24px;text-align:center">
          <div style="font-size:40px">🎓</div>
          <h3 style="margin:0;font-size:17px;color:var(--text,#fff)">Configure seu Perfil Acadêmico para acessar a Comunidade</h3>
          <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.5);max-width:280px">Informe seu curso e matérias para ver sua turma e o feed personalizado.</p>
          <button
            onclick="window.openAcademicSettings()"
            style="margin-top:4px;padding:12px 28px;background:var(--accent,#7c5cfc);color:#fff;border:none;border-radius:24px;font-size:14px;font-weight:700;cursor:pointer">
            Configurar agora →
          </button>
        </div>
      `;
    }
  }

  // Aba padrão: feed (alinhado com data-tab="feed" active no HTML)
  window.switchSocialTab('feed');

  // Pré-carrega discover e grupos em background
  renderDiscoverSection(user.uid).catch(console.warn);
  renderGroupsSection(user.uid).catch(console.warn);
};

// ── Switch de abas ────────────────────────────────────────────────────────────
window.switchSocialTab = function(tab) {
  document.querySelectorAll('.social-tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  document.querySelectorAll('.social-tab-pane').forEach(p =>
    p.classList.toggle('active', p.dataset.tab === tab)
  );

  // Ações por aba
  if (tab === 'feed') {
    import('./social/feed.js').then(({ renderFeed }) => renderFeed()).catch(console.warn);
    return;
  }

  if (tab === 'turmas') {
    import('./social/turmas.js').then(({ renderTurmasTab }) => {
      import('./firebase.js').then(({ auth }) => {
        const uid = auth.currentUser?.uid;
        if (uid) renderTurmasTab(uid);
      });
    }).catch(console.warn);
    return;
  }

  if (tab === 'groups') {
    import('./social/groups.js').then(({ renderGroupsSection }) => {
      import('./firebase.js').then(({ auth }) => {
        const uid = auth.currentUser?.uid;
        if (uid) renderGroupsSection(uid);
      });
    }).catch(console.warn);
    return;
  }

  if (tab === 'discover') {
    import('./social/connections.js').then(({ renderDiscoverSection }) => {
      import('./firebase.js').then(({ auth }) => {
        const uid = auth.currentUser?.uid;
        if (uid) renderDiscoverSection(uid);
      });
    }).catch(console.warn);
    return;
  }

  if (tab === 'notifications') {
    import('./social/notifications-rt.js').then(({ renderNotificationsPanel }) => {
      import('./firebase.js').then(({ auth }) => {
        const uid = auth.currentUser?.uid;
        if (uid) renderNotificationsPanel(uid);
      });
    }).catch(console.warn);
    return;
  }
};
