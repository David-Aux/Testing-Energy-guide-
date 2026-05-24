// ================================================================
// ENERGY GUIDE — USER GATE MODULE
// user-gate.js
// ================================================================

(function () {
  'use strict';

  const GATE_KEY = 'eg_user_gate_done';
  const DATA_KEY = 'eg_user_gate_data';

  function getSupabase() {
    return (typeof supabaseClient !== 'undefined' && supabaseClient)
      ? supabaseClient : window.supabaseClient || null;
  }

  // ── Register (new user) ────────────────────────────────────────
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
    if (name.length < 2)  { const el = document.getElementById('ugFullNameError'); if(el) el.textContent = 'Please enter your name'; valid = false; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { const el = document.getElementById('ugEmailError'); if(el) el.textContent = 'Valid email required'; valid = false; }
    if (phone.length < 7) { const el = document.getElementById('ugPhoneError'); if(el) el.textContent = 'Valid phone number required'; valid = false; }
    if (!state)           { const el = document.getElementById('ugStateError'); if(el) el.textContent = 'Please select your state'; valid = false; }
    if (!valid) return;

    if (typeof showLoading === 'function') showLoading(true, 'Setting up your account...');

    // 1. Set localStorage FIRST — never block user on Supabase
    try {
      localStorage.setItem(GATE_KEY, '1');
      localStorage.setItem(DATA_KEY, JSON.stringify({ name, email, phone, state }));
    } catch (e) {}

    // 2. Save to Supabase in background
    const sb = getSupabase();
    if (sb) {
      try {
        await sb.from('user_gate_registrations').insert([{
          full_name: name, email, phone, state,
          registered_at: new Date().toISOString(),
          calc_completed: false,
          lead_submitted: false,
        }]);
      } catch (e) {
        console.warn('User gate save error:', e.message);
        // Don't block — user still gets in
      }
    }

    if (typeof showLoading === 'function') showLoading(false);
    // Set greeting name from gate data so dashboard shows their name
    try {
      const raw = localStorage.getItem('eg_user_gate_data');
      if (raw) {
        const gateData = JSON.parse(raw);
        // Patch the greeting element directly since currentUser won't be set
        const greetEl = document.getElementById('userDashboardGreetingName');
        if (greetEl && gateData.name) {
          greetEl.textContent = gateData.name.split(' ')[0];
        }
      }
    } catch(e) {}
    // Go to user portal dashboard, not directly to calculator
    if (typeof egShowUserDashboard === 'function') {
      egShowUserDashboard();
    } else if (typeof showScreen === 'function') {
      showScreen('user-calculator');
    }
  };

  // ── Returning user login (email or phone lookup) ───────────────
  window.userGateReturningLogin = async function () {
    const val = (document.getElementById('ugReturnIdentifier')?.value || '').trim();
    const errEl = document.getElementById('ugReturnError');
    if (errEl) errEl.textContent = '';

    if (val.length < 5) {
      if (errEl) errEl.textContent = 'Please enter your email or phone number';
      return;
    }

    if (typeof showLoading === 'function') showLoading(true, 'Looking up your account...');

    const sb = getSupabase();
    if (!sb) {
      // No Supabase — just let them in with what they typed
      try {
        localStorage.setItem(GATE_KEY, '1');
        localStorage.setItem(DATA_KEY, JSON.stringify({ name: '', email: val, phone: val, state: '' }));
      } catch(e) {}
      if (typeof showLoading === 'function') showLoading(false);
      if (typeof showScreen === 'function') showScreen('user-calculator');
      return;
    }

    try {
      // Try to find by email or phone
      const isEmail = val.includes('@');
      const field   = isEmail ? 'email' : 'phone';
      const { data, error } = await sb
        .from('user_gate_registrations')
        .select('full_name, email, phone, state')
        .eq(field, val)
        .limit(1);

      if (typeof showLoading === 'function') showLoading(false);

      if (error || !data || data.length === 0) {
        if (errEl) errEl.textContent = 'Account not found. Please create a new account below.';
        // Auto-switch to register form after 2 seconds
        setTimeout(() => { if (typeof ugShowRegister === 'function') ugShowRegister(); }, 2000);
        return;
      }

      // Found — restore to localStorage and let them in
      const user = data[0];
      try {
        localStorage.setItem(GATE_KEY, '1');
        localStorage.setItem(DATA_KEY, JSON.stringify({
          name: user.full_name, email: user.email,
          phone: user.phone, state: user.state
        }));
      } catch(e) {}

      if (typeof showToast === 'function') showToast('Welcome back, ' + (user.full_name || 'there') + '!', 'success');
      if (typeof egShowUserDashboard === 'function') {
        egShowUserDashboard();
      } else if (typeof showScreen === 'function') {
        showScreen('user-calculator');
      }

    } catch (err) {
      if (typeof showLoading === 'function') showLoading(false);
      // Network issue — still let them in
      try {
        localStorage.setItem(GATE_KEY, '1');
        localStorage.setItem(DATA_KEY, JSON.stringify({ name: '', email: val, phone: val, state: '' }));
      } catch(e) {}
      if (typeof showScreen === 'function') showScreen('user-calculator');
    }
  };

  // ── Toggle between register and returning user forms ───────────
  window.ugShowReturning = function () {
    document.getElementById('ugRegisterForm').style.display  = 'none';
    document.getElementById('ugReturningForm').style.display = '';
  };
  window.ugShowRegister = function () {
    document.getElementById('ugRegisterForm').style.display  = '';
    document.getElementById('ugReturningForm').style.display = 'none';
  };

  // ── Mark calc completed ────────────────────────────────────────
  window.egUserGateMarkCalcDone = async function () {
    const raw = localStorage.getItem(DATA_KEY);
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      const sb   = getSupabase();
      if (!sb || !data.email) return;
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
      if (!sb || !data.email) return;
      await sb.from('user_gate_registrations')
        .update({ lead_submitted: true })
        .eq('email', data.email);
    } catch (e) {}
  };

  // ── Prefill lead form with known user data ─────────────────────
  window.egUserGatePrefill = function () {
    try {
      const raw = localStorage.getItem(DATA_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      const nameEl  = document.getElementById('leadName') || document.getElementById('leadFullName');
      const emailEl = document.getElementById('leadEmail');
      const phoneEl = document.getElementById('leadPhone');
      if (nameEl  && !nameEl.value)  nameEl.value  = data.name  || '';
      if (emailEl && !emailEl.value) emailEl.value = data.email || '';
      if (phoneEl && !phoneEl.value) phoneEl.value = data.phone || '';
    } catch (e) {}
  };

})();
