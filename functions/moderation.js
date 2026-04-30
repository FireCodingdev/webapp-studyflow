// ===== FUNCTIONS/MODERATION.JS =====
// Cloud Functions de moderação de conteúdo — backend
// NÃO é um módulo de browser. Deploy: firebase deploy --only functions

const { onCall } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');

const db = getFirestore();
const ESCALATION_THRESHOLD = 10;

// ── moderatePost — ação de moderação em um post (approve/remove/warn_author) ─
const moderatePost = onCall({ maxInstances: 10 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new Error('Não autenticado');

  const { postId, action, reason } = request.data || {};
  if (!postId || !action) throw new Error('postId e action são obrigatórios');

  const validActions = ['approve', 'remove', 'warn_author'];
  if (!validActions.includes(action)) throw new Error(`action deve ser: ${validActions.join(', ')}`);

  try {
    const userSnap = await db.doc(`users/${uid}`).get();
    const role = userSnap.exists ? (userSnap.data().role || 'user') : 'user';
    if (role !== 'moderator' && role !== 'admin') throw new Error('Sem permissão: apenas moderadores');

    const postRef  = db.doc(`posts/${postId}`);
    const postSnap = await postRef.get();
    if (!postSnap.exists) throw new Error('Post não encontrado');
    const post = postSnap.data();

    if (action === 'approve') {
      await postRef.update({ moderationStatus: 'approved', reviewedBy: uid, reviewedAt: new Date() });

    } else if (action === 'remove') {
      await postRef.update({
        moderationStatus: 'removed', removedBy: uid, removedAt: new Date(),
        removedReason: reason || 'Violação das diretrizes da comunidade',
      });
      await db.collection('notifications').doc(post.authorId).collection('items').add({
        type: 'post_removed', fromUid: uid, postId,
        reason: reason || 'Violação das diretrizes da comunidade',
        read: false, createdAt: new Date(),
      });

    } else if (action === 'warn_author') {
      await db.collection('notifications').doc(post.authorId).collection('items').add({
        type: 'content_warning', fromUid: uid, postId,
        reason: reason || 'Seu conteúdo recebeu denúncias. Por favor revise as diretrizes.',
        read: false, createdAt: new Date(),
      });
    }

    await db.collection('moderation_log').add({
      postId, moderatorId: uid, action, reason: reason || null, createdAt: new Date(),
    });

    console.log(`[moderation] moderatePost: post ${postId} — "${action}" por ${uid}`);
    return { success: true, action };
  } catch (err) {
    console.error('[moderation] moderatePost erro:', err);
    throw new Error(err.message);
  }
});

// ── escalateReport — escalonamento de denúncia para fila de moderação ────────
const escalateReport = onCall({ maxInstances: 10 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new Error('Não autenticado');

  const { reportId, note } = request.data || {};
  if (!reportId) throw new Error('reportId é obrigatório');

  try {
    const reportRef  = db.doc(`reports/${reportId}`);
    const reportSnap = await reportRef.get();
    if (!reportSnap.exists) throw new Error('Denúncia não encontrada');
    const report = reportSnap.data();

    const postSnap   = await db.doc(`posts/${report.postId}`).get();
    const reportCount = postSnap.exists ? (postSnap.data().reportCount || 0) : 0;
    const priority   = reportCount >= ESCALATION_THRESHOLD ? 'high' : 'normal';

    await reportRef.update({
      status: 'escalated', escalatedBy: uid, escalatedAt: new Date(),
      escalationNote: note || null, priority,
    });

    if (postSnap.exists) {
      const currentStatus = postSnap.data().moderationStatus;
      if (!currentStatus || currentStatus === 'active') {
        await db.doc(`posts/${report.postId}`).update({ moderationStatus: 'under_review' });
      }
    }

    console.log(`[moderation] escalateReport: ${reportId} escalonado por ${uid} (prioridade: ${priority})`);
    return { success: true, priority };
  } catch (err) {
    console.error('[moderation] escalateReport erro:', err);
    throw new Error(err.message);
  }
});

module.exports = { moderatePost, escalateReport };