// ===== FUNCTIONS/MODERATION.JS =====
// Filtro automático de conteúdo — NOVO Cloud Function

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { getFirestore } = require('firebase-admin/firestore');

const db = getFirestore();

// Palavras bloqueadas (server-side — mais seguro que client-side)
const BLOCKED_PATTERNS = [
  /\bspam\b/i, /golpe/i, /fraude/i, /\bscam\b/i,
  /apostas?\s+online/i, /cassino/i, /clique\s+aqui/i,
];

// ---- Trigger: moderar post recém-criado ----
exports.moderatePost = onDocumentCreated('posts/{postId}', async (event) => {
  const postId = event.params.postId;
  const post = event.data?.data();
  if (!post?.content) return;

  const content = post.content;
  const flagged = BLOCKED_PATTERNS.some(p => p.test(content));

  if (flagged) {
    try {
      await db.doc(`posts/${postId}`).update({
        hidden: true,
        moderationStatus: 'auto_flagged',
        moderatedAt: new Date(),
      });
      console.log(`[moderation] Post ${postId} ocultado automaticamente por conteúdo suspeito`);
    } catch (err) {
      console.error('[moderation] Erro ao ocultar post:', err);
    }
  }
});

// ---- Trigger: quando denúncias acumulam, escala revisão ----
exports.escalateReport = onDocumentCreated('reports/{reportId}', async (event) => {
  const report = event.data?.data();
  if (!report?.postId) return;

  try {
    const postSnap = await db.doc(`posts/${report.postId}`).get();
    if (!postSnap.exists) return;

    const reportCount = postSnap.data()?.reportCount || 0;

    // 3+ denúncias → marca para revisão
    if (reportCount >= 3 && !postSnap.data()?.pendingReview) {
      await db.doc(`posts/${report.postId}`).update({ pendingReview: true });
      // Cria ticket de moderação
      await db.collection('moderation_queue').add({
        postId: report.postId,
        reportCount,
        createdAt: new Date(),
        status: 'pending',
      });
      console.log(`[moderation] Post ${report.postId} enviado para fila de moderação (${reportCount} denúncias)`);
    }

    // 5+ denúncias → oculta automaticamente
    if (reportCount >= 5) {
      await db.doc(`posts/${report.postId}`).update({ hidden: true, moderationStatus: 'hidden_by_reports' });
    }
  } catch (err) {
    console.error('[moderation] Erro ao escalar denúncia:', err);
  }
});
