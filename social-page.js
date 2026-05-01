window._renderSocialPage = async function() {
  const { auth } = await import('./firebase.js');
  const user = auth.currentUser;
  if (!user) return;

  const { renderDiscoverSection } = await import('./social/connections.js');
  const { renderGroupsSection } = await import('./social/groups.js');
  const { renderTurmasTab, initTurmas } = await import('./social/turmas.js');

  // Inicializa turmas (listeners, etc.)
  initTurmas();

  // Ativa tab padrão (Turmas agora é a aba destaque da Comunidade)
  window.switchSocialTab?.('turmas');
  await renderDiscoverSection(user.uid);
  await renderGroupsSection(user.uid);
  await renderTurmasTab(user.uid);
};

// Switch de tabs na página social
window.switchSocialTab = function(tab) {
  document.querySelectorAll('.social-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.social-tab-pane').forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
  if (tab === 'feed') window._renderFeed?.();
  if (tab === 'turmas') {
    import('./social/turmas.js').then(({ renderTurmasTab }) => {
      const { auth } = window._firebaseAuth || {};
      import('./firebase.js').then(({ auth }) => {
        const uid = auth.currentUser?.uid;
        if (uid) renderTurmasTab(uid);
      });
    });
  }
};
