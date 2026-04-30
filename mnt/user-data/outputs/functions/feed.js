// ===== FUNCTIONS/FEED.JS =====
// Lógica de feed assíncrono — NOVO Cloud Function
// Adicionar ao functions/index.js via: const feedFunctions = require('./feed');
// E exportar: exports.onPostCreated = feedFunctions.onPostCreated;

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { getFirestore } = require('firebase-admin/firestore');

const db = getFirestore();

// ---- Trigger: quando um post é criado, propaga para followers ----
exports.onPostCreated = onDocumentCreated('posts/{postId}', async (event) => {
  const postId = event.params.postId;
  const post = event.data?.data();
  if (!post || !post.authorId) return;

  // Busca followers do autor
  try {
    const connSnap = await db.doc(`connections/${post.authorId}`).get();
    if (!connSnap.exists) return;

    const followers = connSnap.data()?.followers || [];
    if (!followers.length) return;

    // Cria notificação de novo post para cada follower (batch)
    const batch = db.batch();
    const now = new Date();

    followers.slice(0, 500).forEach(followerUid => {
      const notifRef = db.collection(`notifications/${followerUid}/items`).doc();
      batch.set(notifRef, {
        type: 'new_post',
        fromUser: post.authorId,
        postId,
        postType: post.type || 'post',
        read: false,
        createdAt: now,
      });
    });

    await batch.commit();
    console.log(`[feed] Notificações criadas para ${followers.length} followers do post ${postId}`);
  } catch (err) {
    console.error('[feed] Erro ao propagar post:', err);
  }
});

// ---- Trigger: quando post recebe muitas denúncias, oculta automaticamente ----
exports.onPostReportCountUpdated = onDocumentCreated('reports/{reportId}', async (event) => {
  const report = event.data?.data();
  if (!report?.postId) return;

  try {
    const postRef = db.doc(`posts/${report.postId}`);
    const postSnap = await postRef.get();
    if (!postSnap.exists) return;

    const reportCount = postSnap.data()?.reportCount || 0;
    if (reportCount >= 5) {
      await postRef.update({ hidden: true });
      console.log(`[feed] Post ${report.postId} ocultado por excesso de denúncias (${reportCount})`);
    }
  } catch (err) {
    console.error('[feed] Erro ao verificar denúncias:', err);
  }
});
