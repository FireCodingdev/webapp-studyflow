window._renderSocialPage = async function() {
  const { auth } = await import('./firebase.js');
  const user = auth.currentUser;
  if (!user) return;

  const { renderDiscoverSection } = await import('./social/connections.js');
  const { renderGroupsSection } = await import('./social/groups.js');

  // Ativa tab padrão
  window.switchSocialTab?.('feed');
  await renderDiscoverSection(user.uid);
  await renderGroupsSection(user.uid);
};

// Switch de tabs na página social
window.switchSocialTab = function(tab) {
  document.querySelectorAll('.social-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.social-tab-pane').forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
  if (tab === 'feed') window._renderFeed?.();
};
