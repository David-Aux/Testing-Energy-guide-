// ================================================================
// ENERGY GUIDE — USER GATE MODULE
// user-gate.js — lightweight onboarding gate for regular users
// Collects: name, email, phone, state — saves to Supabase + localStorage
// No password. No email confirmation. Immediate access after submit.
// ================================================================

(function () {
  'use strict';

  const GATE_KEY = 'eg_user_gate_done';
  const DATA_KEY = 'eg_user_gate_data';

  function getSupabase() {
    return (typeof supabaseClient !== 'undefined' && supabaseClient)
      ? supabaseClient : window.supabaseClient || null;
  }

  // ── Main register function (called by "Start Calculating" button) ─
  window.userGateRegister = async function () {
    const name  = (document.getElementById('ugFullName')?.value || '').trim();
    const email = (document.getElementById('ugEmail')?.value    || '').trim();
    const phone = (document.getElementById('ugPhone')?.value    || '').trim();
    const state = (document.getElementById('ugState')?.value    || '');

    // Clear errors
    ['ugFullNameError','ugEmailError','ugPhoneError','ugStateError'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '';
    });

    // Validate
    let valid = true;
    if (name.length < 2)  { document.getElementById('ugFullNameError').textContent = 'Please enter your name'; valid = false; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { document.getElementById('ugEmailError').textContent = 'Valid email required'; valid = false; }
    if (phone.length < 7) { document.getElementById('ugPhoneError').textContent = 'Valid phone number required'; valid = false; }
    if (!state)           { document.getElementById('ugStateError').textContent = 'Please select your state'; valid = false; }
    if (!valid) return;

    if (typeof showLoading === 'function') showLoading(true, 'Setting up your account...');

    // Save to Supabase (fire and forget — don't block the user if it fails)
    const sb = getSupabase();
    if (sb) {
      try {
        await sb.from('user_gate_registrations').insert([{
          full_name:  name,
          email:      email,
          phone:      phone,
          state:      state,
          registered_at: new Date().toISOString(),
          calc_completed: false,
          lead_submitted: false,
        }]);
      } catch (e) {
        // Silent — don't block access if Supabase insert fails
        console.warn('User gate save error:', e.message);
      }
    }

    // Mark gate as done in localStorage — remembered on return visits
    try {
      localStorage.setItem(GATE_KEY, '1');
      localStorage.setItem(DATA_KEY, JSON.stringify({ name, email, phone, state }));
    } catch (e) {}

    if (typeof showLoading === 'function') showLoading(false);

    // Go straight to calculator
    if (typeof showScreen === 'function') showScreen('user-calculator');
  };

  // ── Mark calc completed (called after user runs calculation) ──
  window.egUserGateMarkCalcDone = async function () {
    const raw = localStorage.getItem(DATA_KEY);
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      const sb   = getSupabase();
      if (!sb) return;
      await sb.from('user_gate_registrations')
        .update({ calc_completed: true })
        .eq('email', data.email);
    } catch (e) {}
  };

  // ── Mark lead submitted ────────────────────────────────────────
  window.egUserGateMarkLeadDone = async function () {
    const raw = localStorage.getItem(DATA_KEY);
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      const sb   = getSupabase();
      if (!sb) return;
      await sb.from('user_gate_registrations')
        .update({ lead_submitted: true })
        .eq('email', data.email);
    } catch (e) {}
  };

  // ── Prepopulate known user info on lead form if available ──────
  // Called when user opens lead/submit form so they don't retype their details
  window.egUserGatePrefill = function () {
    try {
      const raw = localStorage.getItem(DATA_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      // Try to prefill common lead form fields if they exist
      const nameEl  = document.getElementById('leadName')  || document.getElementById('leadFullName');
      const emailEl = document.getElementById('leadEmail');
      const phoneEl = document.getElementById('leadPhone');
      if (nameEl  && !nameEl.value)  nameEl.value  = data.name  || '';
      if (emailEl && !emailEl.value) emailEl.value = data.email || '';
      if (phoneEl && !phoneEl.value) phoneEl.value = data.phone || '';
    } catch (e) {}
  };

})();
