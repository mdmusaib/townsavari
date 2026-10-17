/**
 * Haversine great-circle distance between two coordinates.
 * Coordinate-distance FALLBACK when the Maps API is unavailable —
 * never the primary fare distance (agent.md §3.4).
 *
 * @param {{lat:number,lng:number}} a
 * @param {{lat:number,lng:number}} b
 * @returns {number} distance in kilometres
 */
function haversineKm(a, b) {
  const R = 6371; // Earth radius in km
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

module.exports = { haversineKm };
