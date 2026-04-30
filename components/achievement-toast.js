// ===== COMPONENTS: ACHIEVEMENT-TOAST.JS =====
// Toast de conquista / gamificação — NOVO COMPONENTE UI

// ---- Mostra toast de conquista ----
export function showAchievementToast(achievement) {
  let el = document.getElementById('achievement-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'achievement-toast';
    el.className = 'achievement-toast';
    document.body.appendChild(el);
  }

  el.innerHTML = `
    <div class="achievement-toast-icon">${achievement.icon || '🏆'}</div>
    <div class="achievement-toast-text">
      <span class="achievement-toast-title">Conquista Desbloqueada!</span>
      <span class="achievement-toast-name">${escapeHtml(achievement.name || '')}</span>
      ${achievement.xp ? `<span class="achievement-toast-xp">+${achievement.xp} XP</span>` : ''}
    </div>
  `;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 4000);
}

// ---- Verificar e disparar conquistas automaticamente ----
export function checkAchievements(STATE) {
  const unlocked = [];

  // Conquista: Primeira matéria adicionada
  if (STATE.subjects?.length >= 1 && !_isUnlocked('first_subject')) {
    _unlock('first_subject');
    unlocked.push({ icon: '📚', name: 'Primeira Matéria!', xp: 10 });
  }
  // Conquista: 5 flashcards criados
  if (STATE.flashcards?.length >= 5 && !_isUnlocked('five_flashcards')) {
    _unlock('five_flashcards');
    unlocked.push({ icon: '🃏', name: '5 Flashcards Criados!', xp: 20 });
  }
  // Conquista: 10 atividades completas
  const doneTasks = STATE.tasks?.filter(t => t.done)?.length || 0;
  if (doneTasks >= 10 && !_isUnlocked('ten_tasks')) {
    _unlock('ten_tasks');
    unlocked.push({ icon: '✅', name: '10 Atividades Concluídas!', xp: 50 });
  }
  // Conquista: Primeiro post no feed
  if (_isUnlocked('first_post') === false && STATE._firstPost) {
    _unlock('first_post');
    unlocked.push({ icon: '📝', name: 'Primeiro Post!', xp: 15 });
  }

  // Mostra toasts com delay entre eles
  unlocked.forEach((a, i) => {
    setTimeout(() => showAchievementToast(a), i * 4500);
  });

  return unlocked;
}

// ---- Helpers internos ----
function _isUnlocked(key) {
  return localStorage.getItem('achievement_' + key) === 'true';
}
function _unlock(key) {
  localStorage.setItem('achievement_' + key, 'true');
}
function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- Expõe globalmente para uso direto se necessário ----
window.showAchievementToast = showAchievementToast;
window.checkAchievements = checkAchievements;
