const googleMapsService = require('../services/googleMapsService');

/**
 * POST /api/v1/places/autocomplete
 * Body: { input: string, lat?: number, lng?: number }
 */
async function autocomplete(req, res, next) {
  try {
    const { input, lat, lng } = req.body || {};
    if (!input || typeof input !== 'string' || !input.trim()) {
      return res.status(200).json({ suggestions: [] });
    }
    const suggestions = await googleMapsService.autocompletePlaces(input, lat, lng);
    return res.status(200).json({ suggestions });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/places/details/:placeId
 */
async function placeDetails(req, res, next) {
  try {
    const { placeId } = req.params;
    if (!placeId) {
      return res.status(400).json({ error: 'placeId is required' });
    }
    const details = await googleMapsService.getPlaceDetails(placeId);
    return res.status(200).json(details);
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/places/reverse-geocode
 * Body: { lat: number, lng: number }
 */
async function reverseGeocode(req, res, next) {
  try {
    const { lat, lng } = req.body || {};
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'lat and lng numbers are required' });
    }
    const result = await googleMapsService.reverseGeocode(lat, lng);
    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
}

module.exports = { autocomplete, placeDetails, reverseGeocode };
