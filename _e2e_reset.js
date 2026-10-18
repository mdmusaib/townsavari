/**
 * E2E test fixture reset (NOT part of production).
 * Deletes any leftover Firestore docs created by the E2E script so a run
 * starts from a clean, deterministic state.
 *
 * Usage:  node _e2e_reset.js
 */
const { db } = require('./config/firebaseAdmin');

const IDS = {
  rides: [],
  users: ['RIDER_E2E', 'DRIVER_E2E_A', 'DRIVER_E2E_B'],
  drivers: ['DRIVER_E2E_A', 'DRIVER_E2E_B'],
};

async function main() {
  // Delete E2E rides: any ride whose riderId/driverId is an E2E id.
  const e2eIds = new Set(['RIDER_E2E', 'DRIVER_E2E_A', 'DRIVER_E2E_B']);
  const rides = await db.collection('rides').get();
  let rideDeletes = 0;
  for (const doc of rides.docs) {
    const d = doc.data() || {};
    if (e2eIds.has(d.riderId) || e2eIds.has(d.driverId)) {
      await doc.ref.delete();
      rideDeletes += 1;
    }
  }

  for (const coll of ['users', 'drivers']) {
    for (const id of IDS[coll]) {
      await db.collection(coll).doc(id).delete();
    }
  }

  console.log(`[e2e_reset] deleted rides=${rideDeletes} users=${IDS.users.length} drivers=${IDS.drivers.length}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[e2e_reset] failed:', err.message);
    process.exit(1);
  });
