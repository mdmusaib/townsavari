const { GOOGLE_MAPS_API_KEY } = require('../config/constants');

function isConfigured() {
  return Boolean(GOOGLE_MAPS_API_KEY);
}

/**
 * getRoadDistance(pickup, dropoff)
 * @param {{lat:number,lng:number}} pickup
 * @param {{lat:number,lng:number}} dropoff
 * @returns {Promise<{distanceMeters:number,distanceKm:number,durationSeconds:number,originAddress:string,destinationAddress:string}>}
 * Uses Google Routes API (computeRoutes) — the modern road-network distance
 * API per agent.md §3.4 (legacy Directions API is not enabled on new projects).
 */
async function getRoadDistance(pickup, dropoff) {
  if (!isConfigured()) {
    throw new Error('GOOGLE_MAPS_API_KEY is not configured');
  }
  if (
    !pickup || !dropoff ||
    typeof pickup.lat !== 'number' || typeof pickup.lng !== 'number' ||
    typeof dropoff.lat !== 'number' || typeof dropoff.lng !== 'number'
  ) {
    throw new Error('pickup and dropoff must be {lat:number,lng:number}');
  }

  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.legs.startLocation,routes.legs.endLocation',
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: pickup.lat, longitude: pickup.lng } } },
      destination: { location: { latLng: { latitude: dropoff.lat, longitude: dropoff.lng } } },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_UNAWARE',
      units: 'METRIC',
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Routes API failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const route = data.routes && data.routes[0];
  if (!route || route.distanceMeters == null) {
    throw new Error('No route found between pickup and dropoff');
  }

  const distanceMeters = Number(route.distanceMeters);
  // duration comes as e.g. "615s"
  let durationSeconds = 0;
  if (typeof route.duration === 'string' && route.duration.endsWith('s')) {
    durationSeconds = Number(route.duration.slice(0, -1));
  } else if (typeof route.duration === 'number') {
    durationSeconds = route.duration;
  }

  return {
    distanceMeters,
    distanceKm: distanceMeters / 1000,
    durationSeconds,
    originAddress: '',
    destinationAddress: '',
  };
}

module.exports = { getRoadDistance, isConfigured };
