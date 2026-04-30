// ===== COMPONENTS: SKILL-BADGE.JS =====
// Badge de habilidade/matéria — NOVO COMPONENTE UI reutilizável

const SKILL_COLORS = [
  '#6c63ff','#ff6584','#ffa502','#2ed573',
  '#1e90ff','#ff4757','#eccc68','#a29bfe',
  '#fd79a8','#00b894','#e17055','#74b9ff',
];

function colorForSkill(skill) {
  let hash = 0;
  for (const c of skill) hash = (hash * 31 + c.charCodeAt(0)) & 0xffff;
  return SKILL_COLORS[hash % SKILL_COLORS.length];
}

// ---- Renderiza um badge de habilidade/matéria ----
export function renderSkillBadge(skill, options = {}) {
  const { removable = false, onClick = '' } = options;
  const color = colorForSkill(skill);
  const label = String(skill).slice(0, 24); // trunca se muito longo

  return `
    <span class="skill-badge" style="background:${color}22;color:${color};border:1px solid ${color}44;"
      ${onClick ? `onclick="${onClick}"` : ''}>
      ${escapeHtml(label)}
      ${removable ? `<button class="skill-badge-remove" onclick="event.stopPropagation();window.removeSkillBadge(this,'${escapeForAttr(skill)}')" title="Remover">×</button>` : ''}
    </span>
  `;
}

// ---- Renderiza lista de badges ----
export function renderSkillBadges(skills = [], options = {}) {
  if (!skills.length) return '<span class="skill-badge-empty">Nenhuma habilidade cadastrada</span>';
  return skills.map(s => renderSkillBadge(s, options)).join('');
}

// ---- Handler: remover badge (para uso em formulários) ----
window.removeSkillBadge = function(btn, skill) {
  btn.closest('.skill-badge')?.remove();
  // Dispara evento customizado para que forms possam reagir
  document.dispatchEvent(new CustomEvent('skillRemoved', { detail: { skill } }));
};

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeForAttr(str) {
  return String(str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
