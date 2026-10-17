const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const { PROJECT_ID, FIRESTORE_DATABASE_ID } = require('./constants');

/**
 * Initializes Firebase Admin SDK once and exports:
 *  - admin instance
 *  - db : Firestore handle bound to the named database `ridedb`
 *
 * Auth resolution order:
 *  1. backend/serviceAccountKey.json if present
 *  2. GOOGLE_APPLICATION_CREDENTIALS env var if it points to a file
 *  3. Application Default Credentials (gcloud / GCE / emulator)
 */

let db;

function initFirebaseAdmin() {
  if (admin.apps.length > 0) {
    return admin.app();
  }

  const localKeyPath = path.join(__dirname, '..', 'serviceAccountKey.json');
  // If GOOGLE_APPLICATION_CREDENTIALS points to a missing file, the Google
  // Auth library fails at request time — unset it so file discovery / ADC works.
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const p = path.resolve(process.cwd(), process.env.GOOGLE_APPLICATION_CREDENTIALS);
    if (!fs.existsSync(p)) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }
  const envKeyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? path.resolve(process.cwd(), process.env.GOOGLE_APPLICATION_CREDENTIALS)
    : null;

  let credential;
  if (fs.existsSync(localKeyPath)) {
    credential = admin.credential.cert(require(localKeyPath));
    console.log('[firebase] using serviceAccountKey.json');
  } else if (envKeyPath && fs.existsSync(envKeyPath)) {
    credential = admin.credential.cert(require(envKeyPath));
    console.log(`[firebase] using credentials from ${envKeyPath}`);
  } else {
    credential = admin.credential.applicationDefault();
    console.log('[firebase] using Application Default Credentials');
  }

  return admin.initializeApp({
    credential,
    projectId: PROJECT_ID,
  });
}

function initFirestore(app) {
  // firebase-admin v12 supports named databases via getFirestore(app, databaseId).
  // Fall back to default Firestore instance on older versions.
  try {
    const { getFirestore } = require('firebase-admin/firestore');
    if (FIRESTORE_DATABASE_ID && FIRESTORE_DATABASE_ID !== '(default)') {
      db = getFirestore(app, FIRESTORE_DATABASE_ID);
      console.log(`[firestore] bound to named database: ${FIRESTORE_DATABASE_ID}`);
      return db;
    }
    db = getFirestore(app);
    return db;
  } catch (e) {
    console.warn('[firestore] getFirestore(databaseId) not available, using default:', e.message);
    db = admin.firestore();
    // NOTE: admin.firestore() always targets the (default) database.
    // Upgrade firebase-admin to >= v11 to use the named `ridedb` database.
    return db;
  }
}

const app = initFirebaseAdmin();
initFirestore(app);

module.exports = { admin, db, initFirebaseAdmin };
