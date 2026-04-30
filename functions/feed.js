// ===== FUNCTIONS/FEED.JS =====
// Firestore triggers para o Feed social — Cloud Functions backend
// NÃO é um módulo de browser. Deploy: firebase deploy --only functions

const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { getFirestore } = require('firebase-admin/firestore');

const db = getFirestore();

// ── Trigger: novo post criado em /posts/{postId} ────────────────────────────
const onPostCreated = onDocumentCreated('posts/{postId}', async (event) => {
  const post = event.data?.data();
  if (!post) return;
  const { authorId, type, content } = post;
  const postId = event.params.postId;
  try {
    const connSnap = await db.doc(`connections/${authorId}`).get();
    const followers = connSnap.exists ? (connSnap.data().followers || []) : [];
    if (!followers.length) return;
    const batch = db.batch();
    for (const followerId of followers.slice(0, 100)) {
      const notifRef = db.collection('notifications').doc(followerId).collection('items').doc();
      batch.set(notifRef, {
        toUid: followerId, fromUid: authorId, type: 'new_post',
        postId, postType: type || 'doubt',
        preview: (content || '').slice(0, 120),
        read: false, createdAt: new Date(),
      });
    }
    await batch.commit();
    console.log(`[feed] onPostCreated: ${followers.length} notificações criadas para post ${postId}`);
  } catch (err) { console.error('[feed] onPostCreated erro:', err); }
});

// ── Trigger: reportCount atualizado — auto-flag ao atingir 5 denúncias ──────
const onPostReportCountUpdated = onDocumentWritten('posts/{postId}', async (event) => {
  const after  = event.data?.after?.data();
  const before = event.data?.before?.data();
  if (!after) return;
  const countAfter  = after.reportCount  || 0;
  const countBefore = before?.reportCount || 0;
  if (countAfter <= countBefore || countAfter < 5) return;
  const status = after.moderationStatus;
  if (status === 'under_review' || status === 'removed') return;
  try {
    await db.doc(`posts/${event.params.postId}`).update({
      moderationStatus: 'under_review', autoFlaggedAt: new Date(),
    });
    console.log(`[feed] post ${event.params.postId} → under_review (${countAfter} denúncias)`);
  } catch (err) { console.error('[feed] onPostReportCountUpdated erro:', err); }
});

module.exports = { onPostCreated, onPostReportCountUpdated };