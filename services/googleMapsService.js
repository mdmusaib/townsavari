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

/**
 * autocompletePlaces(input, lat, lng)
 * Uses Places API (New) with optional 50km circular location bias.
 */
async function autocompletePlaces(input, lat, lng) {
  if (!isConfigured()) {
    throw new Error('GOOGLE_MAPS_API_KEY is not configured');
  }
  if (!input || !input.trim()) return [];

  const body = {
    input: input.trim(),
    includedRegionCodes: ['in'],
  };

  if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)) {
    body.locationBias = {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: 50000.0,
      },
    };
  }

  const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Places Autocomplete failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const suggestions = data.suggestions || [];
  return suggestions
    .filter((s) => s.placePrediction)
    .map((s) => {
      const p = s.placePrediction;
      return {
        placeId: p.placeId || (p.place ? p.place.replace(/^places\//, '') : ''),
        mainText: p.structuredFormat?.mainText?.text || p.text?.text || '',
        secondaryText: p.structuredFormat?.secondaryText?.text || '',
        fullText: p.text?.text || '',
        types: p.types || [],
      };
    });
}

/**
 * getPlaceDetails(placeId)
 * Uses Places API (New) to retrieve lat, lng, displayName, formattedAddress.
 */
async function getPlaceDetails(placeId) {
  if (!isConfigured()) {
    throw new Error('GOOGLE_MAPS_API_KEY is not configured');
  }
  const cleanId = String(placeId).replace(/^places\//, '');
  const res = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(cleanId)}?fields=id,displayName,formattedAddress,location&key=${GOOGLE_MAPS_API_KEY}`
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Place Details failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  return {
    placeId: data.id || cleanId,
    name: data.displayName?.text || '',
    formattedAddress: data.formattedAddress || '',
    lat: data.location?.latitude || 0,
    lng: data.location?.longitude || 0,
  };
}

/**
 * reverseGeocode(lat, lng)
 * Converts GPS coordinate fix to human-readable address.
 */
async function reverseGeocode(lat, lng) {
  if (!isConfigured()) {
    throw new Error('GOOGLE_MAPS_API_KEY is not configured');
  }
  const res = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_MAPS_API_KEY}`
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Geocoding failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const first = data.results && data.results[0];
  return {
    formattedAddress: first ? first.formatted_address : `Location (${lat.toFixed(4)}, ${lng.toFixed(4)})`,
    placeId: first ? first.place_id : '',
  };
}

module.exports = { getRoadDistance, autocompletePlaces, getPlaceDetails, reverseGeocode, isConfigured };
