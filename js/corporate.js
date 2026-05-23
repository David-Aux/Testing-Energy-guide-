// ================================================================
// ENERGY GUIDE — CORPORATE PARTNER MODULE
// corporate.js — loaded after platform.js
// Adds: Corporate login/register, dashboard, agent portal, submissions
// Does NOT modify any existing platform functions.
// ================================================================

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────
  let corpSession = null;       // { id, company_name, company_code, email }
  let agentPortalCode = null;   // company_code when agent opens a direct link
  let agentInfo = null;         // { code, name, phone, state, city }
  let agentAppliances = [];     // [{ name, watts, qty, hours }]
  let agentCalcResult = null;   // result from runAgentCalc()

  // Common appliances for quick pick in agent portal
  const COMMON_APPLIANCES = [
    { name: 'LED Bulb',         watts: 10,   hours: 8 },
    { name: 'Ceiling Fan',      watts: 75,   hours: 8 },
    { name: 'Standing Fan',     watts: 60,   hours: 8 },
    { name: 'TV (32")',         watts: 80,   hours: 6 },
    { name: 'TV (43")',         watts: 120,  hours: 6 },
    { name: 'Laptop',           watts: 65,   hours: 6 },
    { name: 'Desktop PC',       watts: 200,  hours: 8 },
    { name: 'Phone Charger',    watts: 15,   hours: 4 },
    { name: 'Router/Modem',     watts: 15,   hours: 12 },
    { name: 'Small Fridge',     watts: 80,   hours: 8 },
    { name: 'CCTV Camera',      watts: 15,   hours: 24 },
    { name: 'Printer',          watts: 400,  hours: 2 },
    { name: 'AC (1HP)',         watts: 750,  hours: 6 },
    { name: 'Pos Machine',      watts: 20,   hours: 10 },
    { name: 'Water Dispenser',  watts: 500,  hours: 4 },
  ];

  // ── Supabase helpers ───────────────────────────────────────────
  function getSupabase() {
    if (typeof supabaseClient !== 'undefined' && supabaseClient) return supabaseClient;
    if (window.supabaseClient) return window.supabaseClient;
    return null;
  }

  // ── URL param: ?agent=BET9JA ───────────────────────────────────
  // Check on load — if URL has ?agent=CODE, route to agent portal
  function checkAgentUrl() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('agent');
    if (code) {
      agentPortalCode = code.toUpperCase();
      // Small delay to let platform.js finish initialising
      setTimeout(() => launchAgentPortal(agentPortalCode), 600);
    }
  }

  async function launchAgentPortal(code) {
    // Look up company name from Supabase
    const sb = getSupabase();
    let companyName = code; // fallback
    if (sb) {
      try {
        const { data } = await sb
          .from('corporate_partners')
          .select('company_name')
          .eq('company_code', code)
          .single();
        if (data) companyName = data.company_name;
      } catch (e) { /* silently fall back */ }
    }
    // Set portal branding
    const nameEl = document.getElementById('agentPortalCompanyName');
    if (nameEl) nameEl.textContent = companyName + ' — Agent Portal';
    agentPortalCode = code;
    renderAgentApplianceList();
    if (typeof window.populateStateSelect === 'function') {
      window.populateStateSelect('agentState');
    }
    if (typeof showScreen === 'function') showScreen('corporate-agent-portal');
  }

  // ── Corporate Auth ─────────────────────────────────────────────
  window.corporateLogin = async function () {
    const email    = (document.getElementById('corpLoginEmail')?.value || '').trim();
    const password = (document.getElementById('corpLoginPassword')?.value || '').trim();

    let valid = true;
    const emailErr = document.getElementById('corpLoginEmailError');
    const passErr  = document.getElementById('corpLoginPasswordError');
    if (emailErr) emailErr.textContent = '';
    if (passErr)  passErr.textContent  = '';

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (emailErr) emailErr.textContent = 'Valid email required';
      valid = false;
    }
    if (!password) {
      if (passErr) passErr.textContent = 'Password required';
      valid = false;
    }
    if (!valid) return;

    if (typeof showLoading === 'function') showLoading(true, 'Logging in...');
    const sb = getSupabase();
    if (!sb) { if (typeof showLoading === 'function') showLoading(false); if (typeof showToast === 'function') showToast('App not ready — try again', 'error'); return; }

    try {
      const { data: authData, error: authErr } = await sb.auth.signInWithPassword({ email, password });
      if (authErr) throw authErr;

      // Fetch corporate profile
      const { data: corpData, error: corpErr } = await sb
        .from('corporate_partners')
        .select('*')
        .eq('user_id', authData.user.id)
        .single();

      if (corpErr || !corpData) throw new Error('No corporate account found for this email.');

      corpSession = { ...corpData, email };
      if (typeof showLoading === 'function') showLoading(false);
      openCorporateDashboard();
    } catch (err) {
      if (typeof showLoading === 'function') showLoading(false);
      if (typeof showToast === 'function') showToast(err.message || 'Login failed', 'error');
    }
  };

  window.corporateRegister = async function () {
    const company  = (document.getElementById('corpRegCompany')?.value   || '').trim();
    const rawCode  = (document.getElementById('corpRegCode')?.value       || '').trim().toUpperCase();
    const contact  = (document.getElementById('corpRegContact')?.value    || '').trim();
    const email    = (document.getElementById('corpRegEmail')?.value      || '').trim();
    const password = (document.getElementById('corpRegPassword')?.value   || '').trim();
    const industry = (document.getElementById('corpRegIndustry')?.value   || '');

    // Validate
    const errs = { corpRegCompanyError: company.length < 2 ? 'Company name required' : '',
                   corpRegCodeError:    rawCode.length < 2 ? 'Company code required' : '',
                   corpRegContactError: contact.length < 2 ? 'Contact name required' : '',
                   corpRegEmailError:   !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? 'Valid email required' : '',
                   corpRegPasswordError:password.length < 8 ? 'Min 8 characters' : '' };
    let valid = true;
    Object.entries(errs).forEach(([id, msg]) => {
      const el = document.getElementById(id);
      if (el) el.textContent = msg;
      if (msg) valid = false;
    });
    if (!valid) return;

    if (typeof showLoading === 'function') showLoading(true, 'Creating account...');
    const sb = getSupabase();
    if (!sb) { if (typeof showLoading === 'function') showLoading(false); return; }

    try {
      // 1. Create auth user
      const { data: authData, error: authErr } = await sb.auth.signUp({ email, password });
      if (authErr) throw authErr;

      // 2. Insert corporate_partners row
      const { error: insErr } = await sb
        .from('corporate_partners')
        .insert([{
          user_id:      authData.user.id,
          company_name: company,
          company_code: rawCode,
          contact_name: contact,
          email,
          industry,
        }]);
      if (insErr) throw insErr;

      if (typeof showLoading === 'function') showLoading(false);
      if (typeof showToast === 'function') showToast('Account created! Please check your email to verify, then log in.', 'success');
      showScreen('corporate-login');
    } catch (err) {
      if (typeof showLoading === 'function') showLoading(false);
      if (typeof showToast === 'function') showToast(err.message || 'Registration failed', 'error');
    }
  };

  // ── Corporate Dashboard ────────────────────────────────────────
  async function openCorporateDashboard() {
    if (!corpSession) return;

    // Set titles
    const titleEl    = document.getElementById('corpDashTitle');
    const subtitleEl = document.getElementById('corpDashSubtitle');
    if (titleEl)    titleEl.textContent    = corpSession.company_name + ' Dashboard';
    if (subtitleEl) subtitleEl.textContent = 'Code: ' + corpSession.company_code;

    // Agent link
    const linkEl = document.getElementById('corpAgentLink');
    if (linkEl) {
      const baseUrl = window.location.href.split('?')[0];
      linkEl.textContent = baseUrl + '?agent=' + corpSession.company_code;
    }

    showScreen('corporate-dashboard');
    await loadCorpStats();
  }

  async function loadCorpStats() {
    if (!corpSession) return;
    const sb = getSupabase();
    if (!sb) return;

    try {
      const { data, error } = await sb
        .from('agent_submissions')
        .select('state')
        .eq('company_code', corpSession.company_code);

      if (error) throw error;

      const total  = data.length;
      const states = [...new Set(data.map(r => r.state).filter(Boolean))];

      const totalEl  = document.getElementById('corpStatTotal');
      const statesEl = document.getElementById('corpStatStates');
      if (totalEl)  totalEl.textContent  = total;
      if (statesEl) statesEl.textContent = states.length;

      // State breakdown
      const breakdown = {};
      data.forEach(r => { if (r.state) breakdown[r.state] = (breakdown[r.state] || 0) + 1; });
      const sorted = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);

      const breakdownEl = document.getElementById('corpStateBreakdown');
      if (breakdownEl) {
        if (sorted.length === 0) {
          breakdownEl.innerHTML = '<em>No submissions yet. Share the agent link to get started.</em>';
        } else {
          breakdownEl.innerHTML = sorted.map(([state, count]) =>
            `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f3f4f6;">
              <span>${state}</span>
              <span style="font-weight:600;color:#7c3aed;">${count} agent${count > 1 ? 's' : ''}</span>
            </div>`
          ).join('');
        }
      }
    } catch (err) {
      console.warn('Corporate stats error:', err.message);
    }
  }

  // ── Submissions List ───────────────────────────────────────────
  async function loadCorpSubmissions() {
    if (!corpSession) return;
    const sb = getSupabase();
    const listEl = document.getElementById('corpSubmissionsList');
    if (!listEl) return;
    listEl.innerHTML = '<em style="color:#687076;">Loading...</em>';

    try {
      const { data, error } = await sb
        .from('agent_submissions')
        .select('*')
        .eq('company_code', corpSession.company_code)
        .order('created_at', { ascending: false });

      if (error) throw error;

      if (!data || data.length === 0) {
        listEl.innerHTML = '<em style="color:#687076;">No agent submissions yet.</em>';
        return;
      }

      listEl.innerHTML = data.map(sub => `
        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
            <div>
              <span style="font-weight:600;font-size:13px;">${sub.agent_name || 'Agent'}</span>
              <span style="font-size:11px;color:#687076;margin-left:8px;">#${sub.agent_code}</span>
            </div>
            <span style="font-size:11px;background:#f5f3ff;color:#7c3aed;padding:2px 8px;border-radius:20px;">${sub.state || '—'}</span>
          </div>
          <div style="font-size:12px;color:#374151;margin-bottom:4px;">📍 ${sub.city || '—'} &nbsp;|&nbsp; 📞 ${sub.phone || '—'}</div>
          <div style="font-size:12px;color:#374151;background:#f9fafb;padding:8px;border-radius:6px;margin-top:6px;">${sub.sizing_summary || '—'}</div>
          <div style="font-size:11px;color:#9ca3af;margin-top:6px;">${sub.created_at ? new Date(sub.created_at).toLocaleString('en-NG') : ''}</div>
        </div>
      `).join('');
    } catch (err) {
      listEl.innerHTML = '<em style="color:#ef4444;">Failed to load: ' + err.message + '</em>';
    }
  }

  // ── Download CSV Report ────────────────────────────────────────
  window.corporateDownloadReport = async function () {
    if (!corpSession) return;
    const sb = getSupabase();
    if (typeof showLoading === 'function') showLoading(true, 'Preparing report...');

    try {
      const { data, error } = await sb
        .from('agent_submissions')
        .select('*')
        .eq('company_code', corpSession.company_code)
        .order('state', { ascending: true });

      if (error) throw error;
      if (!data || data.length === 0) {
        if (typeof showLoading === 'function') showLoading(false);
        if (typeof showToast === 'function') showToast('No submissions to export yet', 'error');
        return;
      }

      const headers = ['Agent Code','Agent Name','Phone','State','City','Inverter (kVA)','Batteries','Panels','Daily Load (kWh)','Submission Date'];
      const rows = data.map(r => {
        const s = r.sizing_json || {};
        return [
          r.agent_code || '',
          r.agent_name || '',
          r.phone || '',
          r.state || '',
          r.city || '',
          s.invKva   ? s.invKva.toFixed(1) : '',
          s.numBattStrings || '',
          s.numPanels || '',
          s.dailyKwh  ? s.dailyKwh.toFixed(2) : '',
          r.created_at ? new Date(r.created_at).toLocaleDateString('en-NG') : ''
        ].map(v => '"' + String(v).replace(/"/g,'""') + '"');
      });

      const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = corpSession.company_code + '_agent_report_' + new Date().toISOString().slice(0,10) + '.csv';
      a.click();
      URL.revokeObjectURL(url);
      if (typeof showLoading === 'function') showLoading(false);
      if (typeof showToast === 'function') showToast('Report downloaded!', 'success');
    } catch (err) {
      if (typeof showLoading === 'function') showLoading(false);
      if (typeof showToast === 'function') showToast('Export failed: ' + err.message, 'error');
    }
  };

  window.corporateCopyLink = function () {
    const linkEl = document.getElementById('corpAgentLink');
    if (!linkEl) return;
    navigator.clipboard.writeText(linkEl.textContent).then(() => {
      if (typeof showToast === 'function') showToast('Link copied!', 'success');
    }).catch(() => {
      if (typeof showToast === 'function') showToast('Copy failed — copy manually', 'error');
    });
  };

  // ── Agent Portal Logic ─────────────────────────────────────────
  window.agentGoToCalculator = function () {
    const code  = (document.getElementById('agentCode')?.value  || '').trim().toUpperCase();
    const name  = (document.getElementById('agentName')?.value  || '').trim();
    const phone = (document.getElementById('agentPhone')?.value || '').trim();
    const state = (document.getElementById('agentState')?.value || '');
    const city  = (document.getElementById('agentCity')?.value  || '').trim();

    let valid = true;
    [['agentCodeError', !code, 'Agent code required'],
     ['agentNameError', name.length < 2, 'Name required'],
     ['agentPhoneError', phone.length < 7, 'Phone required'],
     ['agentStateError', !state, 'Please select your state']
    ].forEach(([id, fail, msg]) => {
      const el = document.getElementById(id);
      if (el) el.textContent = fail ? msg : '';
      if (fail) valid = false;
    });

    if (!valid) return;
    agentInfo = { code, name, phone, state, city };

    // Show step 2
    document.getElementById('agentStep1').style.display = 'none';
    document.getElementById('agentStep2').style.display = '';
    document.getElementById('agentStep3').style.display = 'none';
    if (agentAppliances.length === 0) agentAppliances = [];
    renderAgentApplianceList();
  };

  window.agentBackToStep1 = function () {
    document.getElementById('agentStep1').style.display = '';
    document.getElementById('agentStep2').style.display = 'none';
    document.getElementById('agentStep3').style.display = 'none';
  };

  window.agentBackToStep2 = function () {
    document.getElementById('agentStep1').style.display = 'none';
    document.getElementById('agentStep2').style.display = '';
    document.getElementById('agentStep3').style.display = 'none';
  };

  window.agentStartOver = function () {
    agentInfo = null;
    agentAppliances = [];
    agentCalcResult = null;
    document.getElementById('agentStep1').style.display = '';
    document.getElementById('agentStep2').style.display = 'none';
    document.getElementById('agentStep3').style.display = 'none';
    ['agentCode','agentName','agentPhone','agentCity'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const st = document.getElementById('agentState');
    if (st) st.value = '';
    showScreen('corporate-agent-portal');
  };

  function renderAgentApplianceList() {
    const listEl = document.getElementById('agentApplianceList');
    if (!listEl) return;

    if (agentAppliances.length === 0) {
      listEl.innerHTML = '<p style="color:#687076;font-size:12px;text-align:center;padding:12px 0;">No appliances added yet. Tap below to add.</p>';
      return;
    }

    listEl.innerHTML = agentAppliances.map((app, i) => `
      <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin-bottom:8px;display:flex;align-items:center;gap:8px;">
        <div style="flex:1;">
          <div style="font-size:13px;font-weight:600;color:#374151;">${app.name}</div>
          <div style="font-size:11px;color:#687076;">${app.watts}W × ${app.qty} unit${app.qty > 1 ? 's' : ''} × ${app.hours}h/day</div>
        </div>
        <button onclick="agentRemoveAppliance(${i})" style="background:none;border:none;color:#ef4444;font-size:16px;cursor:pointer;padding:4px;">✕</button>
      </div>
    `).join('');
  }

  window.agentRemoveAppliance = function (index) {
    agentAppliances.splice(index, 1);
    renderAgentApplianceList();
  };

  window.agentAddAppliance = function () {
    // Build a simple inline form + quick-pick
    const listEl = document.getElementById('agentApplianceList');
    if (!listEl) return;

    // Prevent double-adding the form
    if (document.getElementById('agentAddForm')) return;

    const quickPicks = COMMON_APPLIANCES.map((a, i) =>
      `<button onclick="agentQuickPick(${i})" style="background:#f5f3ff;border:1px solid #e9d5ff;color:#7c3aed;border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer;margin:3px 2px;">${a.name}</button>`
    ).join('');

    const formHtml = `
      <div id="agentAddForm" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin-bottom:10px;">
        <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:8px;">Quick Pick:</div>
        <div style="margin-bottom:12px;line-height:2;">${quickPicks}</div>
        <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:8px;">Or enter custom:</div>
        <input type="text" id="newAppName" placeholder="Appliance name" class="form-input" style="margin-bottom:6px;"/>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px;">
          <div><label style="font-size:11px;color:#687076;">Watts</label><input type="number" id="newAppWatts" placeholder="e.g. 75" class="form-input" min="1"/></div>
          <div><label style="font-size:11px;color:#687076;">Qty</label><input type="number" id="newAppQty" placeholder="1" class="form-input" min="1" value="1"/></div>
          <div><label style="font-size:11px;color:#687076;">Hours/day</label><input type="number" id="newAppHours" placeholder="8" class="form-input" min="0.5" step="0.5" value="8"/></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <button class="btn btn-primary" onclick="agentSaveAppliance()" style="background:#7c3aed;border-color:#7c3aed;font-size:13px;">Add</button>
          <button class="btn btn-secondary" onclick="agentCancelAdd()" style="font-size:13px;">Cancel</button>
        </div>
      </div>
    `;
    listEl.insertAdjacentHTML('beforeend', formHtml);
  };

  window.agentQuickPick = function (index) {
    const app = COMMON_APPLIANCES[index];
    document.getElementById('newAppName').value  = app.name;
    document.getElementById('newAppWatts').value = app.watts;
    document.getElementById('newAppHours').value = app.hours;
    document.getElementById('newAppQty').value   = 1;
  };

  window.agentSaveAppliance = function () {
    const name  = (document.getElementById('newAppName')?.value  || '').trim();
    const watts = parseFloat(document.getElementById('newAppWatts')?.value) || 0;
    const qty   = parseInt(document.getElementById('newAppQty')?.value)     || 1;
    const hours = parseFloat(document.getElementById('newAppHours')?.value) || 1;

    if (!name || watts < 1) {
      if (typeof showToast === 'function') showToast('Enter appliance name and wattage', 'error');
      return;
    }
    agentAppliances.push({ name, watts, qty, hours });
    renderAgentApplianceList();
  };

  window.agentCancelAdd = function () {
    const form = document.getElementById('agentAddForm');
    if (form) form.remove();
  };

  // ── Agent Calculator (mirrors platform.js calc logic) ──────────
  function runAgentCalc(appliances) {
    let totalWatts = 0, dailyWh = 0, maxSurge = 0;

    appliances.forEach(app => {
      const load = app.watts * app.qty;
      totalWatts += load;
      dailyWh    += load * app.hours;

      // Rough surge: motors/AC get 3× start surge
      const name = app.name.toLowerCase();
      if (name.includes('ac') || name.includes('fridge') || name.includes('pump') || name.includes('motor')) {
        maxSurge = Math.max(maxSurge, load * 2);
      }
    });

    const peakWatts   = totalWatts + maxSurge;
    const energyFactor = 1.25;
    const dailyKwh    = (dailyWh / 1000) * energyFactor;
    const invKva      = Math.max(totalWatts * 1.25, peakWatts) / 800;
    const sysV        = invKva > 3.75 ? 48 : 24;

    // Battery (2 days autonomy, 0.8 DoD)
    const battKwh      = (dailyKwh * 2) / 0.8;
    const battV        = sysV;
    const battAh       = (battKwh * 1000) / battV;
    const battPerStr   = battV === 48 ? 4 : 2;    // 12V batteries in series
    const strings      = Math.ceil(battAh / 200);  // 200Ah batteries

    // Solar panels (5 peak sun hours)
    const pvWatts  = (dailyKwh * 1000) / 5;
    const panels   = Math.ceil(pvWatts / 400);     // 400W panels

    return {
      totalWatts, dailyKwh, invKva: Math.ceil(invKva * 2) / 2,
      sysV, battKwh, strings, battPerStr, pvWatts, panels,
      numPanels: panels, numBattStrings: strings
    };
  }

  window.agentCalculateAndSubmit = function () {
    // Remove the add form if open
    const form = document.getElementById('agentAddForm');
    if (form) form.remove();

    if (agentAppliances.length === 0) {
      if (typeof showToast === 'function') showToast('Add at least one appliance first', 'error');
      return;
    }

    agentCalcResult = runAgentCalc(agentAppliances);
    const r = agentCalcResult;

    const summary = `
      <div style="margin-bottom:10px;font-weight:600;color:#7c3aed;">Recommended System</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;">
        <div style="background:#fff;border:1px solid #e9d5ff;border-radius:8px;padding:10px;text-align:center;">
          <div style="font-size:18px;font-weight:700;color:#7c3aed;">${r.invKva.toFixed(1)} kVA</div>
          <div style="color:#687076;font-size:11px;margin-top:2px;">Inverter</div>
        </div>
        <div style="background:#fff;border:1px solid #e9d5ff;border-radius:8px;padding:10px;text-align:center;">
          <div style="font-size:18px;font-weight:700;color:#7c3aed;">${r.panels}</div>
          <div style="color:#687076;font-size:11px;margin-top:2px;">Solar Panels (400W)</div>
        </div>
        <div style="background:#fff;border:1px solid #e9d5ff;border-radius:8px;padding:10px;text-align:center;">
          <div style="font-size:18px;font-weight:700;color:#7c3aed;">${r.strings} × ${r.battPerStr}</div>
          <div style="color:#687076;font-size:11px;margin-top:2px;">Battery Strings (200Ah)</div>
        </div>
        <div style="background:#fff;border:1px solid #e9d5ff;border-radius:8px;padding:10px;text-align:center;">
          <div style="font-size:18px;font-weight:700;color:#7c3aed;">${r.dailyKwh.toFixed(1)} kWh</div>
          <div style="color:#687076;font-size:11px;margin-top:2px;">Daily Energy Need</div>
        </div>
      </div>
      <div style="margin-top:12px;font-size:11px;color:#687076;">
        Running load: ${r.totalWatts.toLocaleString()}W &nbsp;|&nbsp; System voltage: ${r.sysV}V
      </div>
    `;

    const resultBox = document.getElementById('agentResultBox');
    if (resultBox) resultBox.innerHTML = summary;

    document.getElementById('agentStep1').style.display = 'none';
    document.getElementById('agentStep2').style.display = 'none';
    document.getElementById('agentStep3').style.display = '';
  };

  window.agentConfirmSubmit = async function () {
    if (!agentInfo || !agentCalcResult) return;

    const r = agentCalcResult;
    const sizingSummary = `Inverter: ${r.invKva.toFixed(1)}kVA | Panels: ${r.panels}×400W | Batteries: ${r.strings}×${r.battPerStr}×200Ah | Daily: ${r.dailyKwh.toFixed(1)}kWh`;

    if (typeof showLoading === 'function') showLoading(true, 'Submitting...');
    const sb = getSupabase();
    if (!sb) { if (typeof showLoading === 'function') showLoading(false); return; }

    try {
      const { error } = await sb
        .from('agent_submissions')
        .insert([{
          company_code:    agentPortalCode || 'UNKNOWN',
          agent_code:      agentInfo.code,
          agent_name:      agentInfo.name,
          phone:           agentInfo.phone,
          state:           agentInfo.state,
          city:            agentInfo.city,
          appliances_json: JSON.stringify(agentAppliances),
          sizing_json:     JSON.stringify(agentCalcResult),
          sizing_summary:  sizingSummary,
        }]);

      if (error) throw error;

      if (typeof showLoading === 'function') showLoading(false);

      // Show success screen
      const successEl = document.getElementById('agentSuccessSummary');
      if (successEl) {
        successEl.innerHTML = `
          <div style="margin-bottom:6px;"><strong>Agent:</strong> ${agentInfo.name} (#${agentInfo.code})</div>
          <div style="margin-bottom:6px;"><strong>Location:</strong> ${agentInfo.city ? agentInfo.city + ', ' : ''}${agentInfo.state}</div>
          <div><strong>System:</strong> ${sizingSummary}</div>
        `;
      }
      showScreen('corporate-agent-success');
    } catch (err) {
      if (typeof showLoading === 'function') showLoading(false);
      if (typeof showToast === 'function') showToast('Submission failed: ' + err.message, 'error');
    }
  };

  // ── Hook showScreen to load submissions when navigating ────────
  // We wrap the existing showScreen (already exposed on window by platform.js)
  const _origShowScreen = window.showScreen;
  window.showScreen = function (screenId) {
    if (typeof _origShowScreen === 'function') _origShowScreen(screenId);
    if (screenId === 'corporate-submissions') loadCorpSubmissions();
    if (screenId === 'corporate-dashboard' && corpSession) loadCorpStats();
    if (screenId === 'agent-code-entry') setupAgentCodeLivePreview();
  };

  // ── Agent Code Entry (from welcome screen "I'm an Agent" card) ───
  window.agentEnterWithCode = async function () {
    const code  = (document.getElementById('agentEntryCode')?.value || '').trim().toUpperCase();
    const errEl = document.getElementById('agentEntryCodeError');
    const nameEl = document.getElementById('agentEntryCompanyName');

    if (errEl)  errEl.textContent  = '';
    if (nameEl) nameEl.textContent = '';

    if (!code || code.length < 2) {
      if (errEl) errEl.textContent = 'Please enter your company code';
      return;
    }

    if (typeof showLoading === 'function') showLoading(true, 'Looking up company...');
    const sb = getSupabase();

    try {
      let companyName = null;
      if (sb) {
        const { data } = await sb
          .from('corporate_partners')
          .select('company_name')
          .eq('company_code', code)
          .single();
        if (data) companyName = data.company_name;
      }

      if (typeof showLoading === 'function') showLoading(false);

      if (!companyName) {
        if (errEl) errEl.textContent = 'Company code not found. Check with your manager.';
        return;
      }

      // Brand the agent portal
      agentPortalCode = code;
      const portalNameEl = document.getElementById('agentPortalCompanyName');
      if (portalNameEl) portalNameEl.textContent = companyName + ' — Agent Portal';

      // Reset state
      agentAppliances = [];
      agentInfo       = null;
      agentCalcResult = null;

      // Reset steps
      ['agentStep1','agentStep2','agentStep3'].forEach((id, i) => {
        const el = document.getElementById(id);
        if (el) el.style.display = i === 0 ? '' : 'none';
      });

      // Clear fields
      ['agentCode','agentName','agentPhone','agentCity'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      const stEl = document.getElementById('agentState');
      if (stEl) stEl.value = '';

      renderAgentApplianceList();
      if (typeof showScreen === 'function') showScreen('corporate-agent-portal');

    } catch (err) {
      if (typeof showLoading === 'function') showLoading(false);
      if (errEl) errEl.textContent = 'Could not verify code. Check your connection and try again.';
    }
  };

  // Live company name preview as agent types
  function setupAgentCodeLivePreview() {
    const input = document.getElementById('agentEntryCode');
    if (!input) return;
    let timer;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      const nameEl = document.getElementById('agentEntryCompanyName');
      const errEl  = document.getElementById('agentEntryCodeError');
      if (nameEl) nameEl.textContent = '';
      if (errEl)  errEl.textContent  = '';
      const code = input.value.trim().toUpperCase();
      if (code.length < 3) return;
      timer = setTimeout(async () => {
        const sb = getSupabase();
        if (!sb) return;
        try {
          const { data } = await sb
            .from('corporate_partners')
            .select('company_name')
            .eq('company_code', code)
            .single();
          if (data && nameEl) nameEl.textContent = '✓ ' + data.company_name;
        } catch (e) { /* not found yet — silent */ }
      }, 600);
    });
  }

  // ── Init: check for ?agent= in URL ────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkAgentUrl);
  } else {
    checkAgentUrl();
  }

})();
