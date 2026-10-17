// Townsavari admin dashboard client — loads/saves fare settings via the admin API.
(function () {
  'use strict';

  var API_URL = '/api/v1/admin/config';
  var FIELDS = [
    'baseFare',
    'baseDistanceKm',
    'ratePerKm',
    'platformCommissionPercent',
    'maxCommissionOwed',
  ];

  var form = document.getElementById('configForm');
  var saveBtn = document.getElementById('saveBtn');
  var statusEl = document.getElementById('status');
  var sourceEl = document.getElementById('source');

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = kind || '';
  }

  function fillForm(cfg) {
    FIELDS.forEach(function (f) {
      if (cfg[f] !== undefined) document.getElementById(f).value = cfg[f];
    });
    sourceEl.textContent = cfg._source
      ? 'Loaded from: ' + (cfg._source === 'firestore' ? 'Firestore (systemConfig/global)' : 'defaults (no saved config yet)')
      : '';
  }

  function readForm() {
    var payload = {};
    FIELDS.forEach(function (f) {
      var raw = document.getElementById(f).value;
      if (raw === '' || raw === null) throw new Error(f + ' is required');
      var num = Number(raw);
      if (!Number.isFinite(num) || num < 0) throw new Error(f + ' must be a non-negative number');
      payload[f] = num;
    });
    if (payload.platformCommissionPercent > 100) {
      throw new Error('platformCommissionPercent cannot exceed 100');
    }
    return payload;
  }

  async function loadConfig() {
    setStatus('Loading current settings…', '');
    saveBtn.disabled = true;
    try {
      var res = await fetch(API_URL);
      if (!res.ok) throw new Error('Load failed (HTTP ' + res.status + ')');
      var cfg = await res.json();
      fillForm(cfg);
      setStatus('', '');
    } catch (err) {
      setStatus('⚠ ' + err.message, 'err');
    } finally {
      saveBtn.disabled = false;
    }
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var payload;
    try {
      payload = readForm();
    } catch (err) {
      setStatus('⚠ ' + err.message, 'err');
      return;
    }
    setStatus('Saving…', '');
    saveBtn.disabled = true;
    try {
      var res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        var detail = data.details ? ': ' + data.details.join('; ') : '';
        throw new Error((data.error || 'Save failed (HTTP ' + res.status + ')') + detail);
      }
      fillForm({ ...data, _source: 'firestore' });
      setStatus('✓ Settings saved to Firestore.', 'ok');
    } catch (err) {
      setStatus('⚠ ' + err.message, 'err');
    } finally {
      saveBtn.disabled = false;
    }
  });

  loadConfig();
})();
