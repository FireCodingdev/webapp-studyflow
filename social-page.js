// ===== SOCIAL-PAGE.JS =====
// 2025-05-15 — Atualizado para inicializar grupos corretamente e
// acionar renderNotificationsPanel ao abrir a aba de notificações.

window._renderSocialPage = async function() {
  const { auth } = await import('./firebase.js');

  // Aguarda o Firebase restaurar a sessão antes de verificar o usuário
  const user = await new Promise(resolve => {
    if (auth.currentUser !== null) { resolve(auth.currentUser); return; }
    const unsub = auth.onAuthStateChanged(u => { unsub(); resolve(u); });
  });
  if (!user) return;

  const { renderDiscoverSection } = await import('./social/connections.js');
  const { renderGroupsSection }   = await import('./social/groups.js');
  const { renderTurmasTab, initTurmas } = await import('./social/turmas.js');
  const { initFeed, renderFeed }        = await import('./social/feed.js');

  // Inicializa módulos
  initTurmas();
  initFeed();

  // Atualiza UI das abas (feed é a padrão)
  document.querySelectorAll('.social-tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === 'feed')
  );
  document.querySelectorAll('.social-tab-pane').forEach(p =>
    p.classList.toggle('active', p.dataset.tab === 'feed')
  );

  // Chama renderFeed diretamente com a referência já importada (confiável)
  renderFeed();

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