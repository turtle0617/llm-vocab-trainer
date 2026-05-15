import { initializeApp } from "firebase-admin/app";
import { getFirestore, type DocumentReference, type Firestore } from "firebase-admin/firestore";

const collections = ["sections", "cards", "reviewLogs"] as const;
const batchSize = 450;

initializeApp();

const db = getFirestore();
const ownerUid = process.env.BACKFILL_OWNER_UID;
const dryRun = process.env.BACKFILL_OWNER_DRY_RUN !== "false";

if (!ownerUid) {
  console.error("BACKFILL_OWNER_UID is required.");
  process.exitCode = 1;
} else {
  await runBackfill(db, ownerUid, dryRun);
}

export async function runBackfill(db: Firestore, ownerUid: string, dryRun = true) {
  const summary: Record<string, number> = {};

  for (const collection of collections) {
    summary[collection] = await backfillCollection(db, collection, ownerUid, dryRun);
  }

  summary.settings = await backfillSettings(db, ownerUid, dryRun);

  console.info(
    JSON.stringify(
      {
        dryRun,
        ownerUid,
        updated: summary
      },
      null,
      2
    )
  );
}

async function backfillCollection(
  db: Firestore,
  collection: (typeof collections)[number],
  ownerUid: string,
  dryRun: boolean
) {
  let updated = 0;
  let lastDocId: string | null = null;

  while (true) {
    let query = db.collection(collection).orderBy("__name__").limit(batchSize);
    if (lastDocId) query = query.startAfter(lastDocId);

    const snapshot = await query.get();
    if (snapshot.empty) break;

    const refs = snapshot.docs.filter((doc) => !doc.get("ownerUid")).map((doc) => doc.ref);
    updated += refs.length;
    if (!dryRun && refs.length > 0) await updateRefs(db, refs, ownerUid);

    lastDocId = snapshot.docs.at(-1)?.id ?? null;
  }

  return updated;
}

async function backfillSettings(db: Firestore, ownerUid: string, dryRun: boolean) {
  const legacyRef = db.collection("settings").doc("global");
  const legacy = await legacyRef.get();
  if (!legacy.exists) return 0;

  const legacyData = legacy.data() ?? {};
  if (!dryRun) {
    await db
      .collection("settings")
      .doc(ownerUid)
      .set(
        {
          ...legacyData,
          ownerUid
        },
        { merge: true }
      );
  }

  return 1;
}

async function updateRefs(db: Firestore, refs: DocumentReference[], ownerUid: string) {
  for (let index = 0; index < refs.length; index += batchSize) {
    const batch = db.batch();
    refs.slice(index, index + batchSize).forEach((ref) => {
      batch.update(ref, { ownerUid });
    });
    await batch.commit();
  }
}
