const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const { PORT, PROJECT_ID, FIRESTORE_DATABASE_ID } = require('./config/constants');
const googleMapsService = require('./services/googleMapsService');
const adminController = require('./controllers/adminController');
const rideController = require('./controllers/rideController');
const driverController = require('./controllers/driverController');
const { gpsValidator } = require('./middlewares/gpsValidator');
const { commissionGuard } = require('./middlewares/commissionGuard');
const errorHandler = require('./middlewares/errorHandler');

const app = express();
app.use(cors());
app.use(express.json());

// Lazy-load Firestore so /health can report connection errors cleanly
// even when credentials are missing locally.
function getDbStatus() {
  return new Promise(async (resolve) => {
    try {
      const { db } = require('./config/firebaseAdmin');
      // Lightweight connectivity check: list collections (works on empty DB too).
      await db.listCollections();
      resolve({ connected: true, databaseId: FIRESTORE_DATABASE_ID });
    } catch (err) {
      resolve({ connected: false, error: err.message });
    }
  });
}

app.get('/health', async (req, res) => {
  const firestore = await getDbStatus();
  const googleMaps = {
    configured: googleMapsService.isConfigured(),
    status: googleMapsService.isConfigured() ? 'active' : 'missing_api_key',
  };
  const healthy = firestore.connected && googleMaps.configured;
  res.status(healthy ? 200 : 200).json({
    status: healthy ? 'healthy' : 'degraded',
    projectId: PROJECT_ID,
    firestore,
    googleMaps,
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.json({ service: 'townsavari-backend', status: 'running' });
});

// Task 3 — Embedded Admin Dashboard
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/admin.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.js'));
});

// Task 4 — Server-Side Dynamic Fare Engine
app.post('/api/v1/rides/estimate', rideController.estimateRide);

// Task 5 — Atomic Ride Acceptance (409 if already taken)
// Task 9 — commissionGuard blocks over-limit drivers with 403.
app.post('/api/v1/rides/accept', commissionGuard, rideController.acceptRide);

// Task 9 — Available rides listing, guarded by commission check.
app.get('/api/v1/driver/available-rides', commissionGuard, driverController.listAvailableRides);

// Task 8 — Ride Request + Cash Settlement / Commission Ledger
app.post('/api/v1/rides/request', rideController.requestRide);
app.post('/api/v1/rides/complete', rideController.completeRide);

// Task 7 — FCM dev test route (DEVELOPMENT ONLY — remove before production)
app.post('/api/v1/dev/notify-test', rideController.devNotifyTest);

// Task 6 — Driver GPS Polling & Anti-Spoofing (120 km/h guard + geohash)
app.post(
  '/api/v1/driver/location',
  driverController.loadPreviousFix,
  gpsValidator,
  driverController.updateLocation
);

// Task 2 — System Configuration Engine (systemConfig/global)
// NOTE: protect with admin authorization before production use (agent.md Task 2).
app.get('/api/v1/admin/config', adminController.getConfig);
app.post('/api/v1/admin/config', adminController.updateConfig);

// Centralized error handling — must be registered last.
app.use(errorHandler);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[townsavari] backend listening on http://localhost:${PORT}`);
    console.log(`[townsavari] project=${PROJECT_ID} firestoreDb=${FIRESTORE_DATABASE_ID}`);
  });
}

module.exports = app;
