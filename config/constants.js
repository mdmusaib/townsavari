require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 5000,
  PROJECT_ID: process.env.GOOGLE_CLOUD_PROJECT_ID || 'utility-glider-393102',
  FIRESTORE_DATABASE_ID: process.env.FIRESTORE_DATABASE_ID || 'ridedb',
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || '',

  // Default fare / commission parameters (agent.md §1 + Task 2).
  // Used when systemConfig/global does not exist yet, and as validation fallbacks.
  DEFAULT_CONFIG: {
    baseFare: 25,
    baseDistanceKm: 1.5,
    ratePerKm: 12,
    platformCommissionPercent: 10,
    maxCommissionOwed: 200,
  },
};

