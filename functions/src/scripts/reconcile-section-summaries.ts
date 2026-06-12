import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { reconcileSectionSummariesForOwner } from "../repositories.js";

initializeApp();

const db = getFirestore();
const ownerUid = process.env.RECONCILE_OWNER_UID;
const dryRun = process.env.RECONCILE_SECTION_SUMMARIES_DRY_RUN !== "false";

if (!ownerUid) {
  console.error("RECONCILE_OWNER_UID is required.");
  process.exitCode = 1;
} else {
  const result = await reconcileSectionSummariesForOwner(db, ownerUid, { dryRun });
  console.info(JSON.stringify(result, null, 2));
}
