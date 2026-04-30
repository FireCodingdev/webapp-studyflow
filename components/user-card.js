// ===== COMPONENTS: USER-CARD.JS =====
// Card de perfil de colega — NOVO COMPONENTE UI reutilizável

export function renderUserCard(user, isFollowing = false) {
  const name = escapeHtml(user.displayName || user.email?.split('@')[0] || 'Usuário');
  const initials = name.slice(0, 2).toUpperCase();
  const institution = escapeHtml(user.institution || '');
  const course = escapeHtml(user.course || '');

  return `
    <div class="user-card">
      <div class="user-card-avatar">${initials}</div>
      <div class="user-card-info">
        <span class="user-card-name">${name}</span>
        ${institution ? `<span class="user-card-inst">🏛 ${institution}</span>` : ''}
        ${course ? `<span class="user-card-course">📖 ${course}</span>` : ''}
      </div>
      <button
        class="user-card-btn ${isFollowing ? 'btn-secondary' : ''}"
        data-follow-uid="${user.uid}"
        onclick="window.toggleFollowUser('${user.uid}')">
        ${isFollowing ? '✔ Seguindo' : '➕ Seguir'}
      </button>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
