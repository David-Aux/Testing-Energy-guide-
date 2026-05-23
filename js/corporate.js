// ================================================================
// ENERGY GUIDE — CORPORATE PARTNER MODULE
// corporate.js — loaded after platform.js
// Option C: Agent uses the REAL user-calculator screen directly.
// No duplicate HTML. No ID conflicts.
// ================================================================

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────
  let corpSession     = null;
  let agentPortalCode = null;
  let agentInfo       = null;
  let agentCalcResult = null;
  let agentLastApps   = [];

  // ── Supabase helper ────────────────────────────────────────────
  function getSupabase() {
    return (typeof supabaseClient !== 'undefined' && supabaseClient)
      ? supabaseClient : window.supabaseClient || null;
  }

  // ── Helpers: show/hide agent mode on user-calculator ──────────
  function enterAgentCalcMode() {
    // Hide everything that's for regular users
    ['userGuestBanner','userCalcBackBar','userCalcGuestBackBtn','userPostCalcActions'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    // Show agent banner
    const banner     = document.getElementById('agentCalcBanner');
    const bannerText = document.getElementById('agentCalcBannerText');
    if (banner)     banner.style.display = '';
    if (bannerText && agentInfo) {
      bannerText.textContent = 'Agent: ' + agentInfo.name + ' (#' + agentInfo.code + ') — ' + (agentInfo.city ? agentInfo.city + ', ' : '') + agentInfo.state;
    }
    // Only hide agent submit panel if no result exists yet; preserve it if calc already ran
    const agentPost = document.getElementById('agentPostCalcActions');
    if (agentPost && !agentCalcResult) agentPost.style.display = 'none';
  }

  function exitAgentCalcMode() {
    // Hide agent-specific elements
    const banner  = document.getElementById('agentCalcBanner');
    const agentPost = document.getElementById('agentPostCalcActions');
    if (banner)    banner.style.display    = 'none';
    if (agentPost) agentPost.style.display = 'none';
  }

  // ── URL param: ?agent=CODE ─────────────────────────────────────
  function checkAgentUrl() {
    const params = new URLSearchParams(window.location.search);
    const code   = params.get('agent');
    if (code) {
      agentPortalCode = code.toUpperCase();
      setTimeout(() => launchAgentPortal(agentPortalCode), 700);
    }
  }

  async function launchAgentPortal(code) {
    const sb = getSupabase();
    let companyName = code;
    if (sb) {
      try {
        const { data } = await sb.from('corporate_partners').select('company_name').eq('company_code', code).single();
        if (data) companyName = data.company_name;
      } catch (e) {}
    }
    agentPortalCode = code;
    const nameEl = document.getElementById('agentPortalCompanyName');
    if (nameEl) nameEl.textContent = companyName + ' — Agent Portal';
    resetAgentSession();
    if (typeof showScreen === 'function') showScreen('corporate-agent-portal');
  }

  function resetAgentSession() {
    agentInfo       = null;
    agentCalcResult = null;
    agentLastApps   = [];
    ['agentCode','agentName','agentPhone','agentCity'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const st = document.getElementById('agentState');
    if (st) st.value = '';
    const infoBar = document.getElementById('agentInfoBar');
    if (infoBar) infoBar.style.display = 'none';
    document.getElementById('agentStep1').style.display = '';
    exitAgentCalcMode();
    if (typeof l4u_resetCalculatorSession === 'function') l4u_resetCalculatorSession();
  }

  // ── Corporate Auth ─────────────────────────────────────────────
  window.corporateLogin = async function () {
    const email    = (document.getElementById('corpLoginEmail')?.value    || '').trim();
    const password = (document.getElementById('corpLoginPassword')?.value || '').trim();
    const emailErr = document.getElementById('corpLoginEmailError');
    const passErr  = document.getElementById('corpLoginPasswordError');
    if (emailErr) emailErr.textContent = '';
    if (passErr)  passErr.textContent  = '';
    let valid = true;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { if (emailErr) emailErr.textContent = 'Valid email required'; valid = false; }
    if (!password) { if (passErr) passErr.textContent = 'Password required'; valid = false; }
    if (!valid) return;

    if (typeof showLoading === 'function') showLoading(true, 'Logging in...');
    const sb = getSupabase();
    if (!sb) { if (typeof showLoading === 'function') showLoading(false); return; }
    try {
      const { data: authData, error: authErr } = await sb.auth.signInWithPassword({ email, password });
      if (authErr) throw authErr;
      const { data: corpData, error: corpErr } = await sb.from('corporate_partners').select('*').eq('user_id', authData.user.id).single();
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
    const errs = {
      corpRegCompanyError:  company.length  < 2 ? 'Company name required'  : '',
      corpRegCodeError:     rawCode.length  < 2 ? 'Company code required'  : '',
      corpRegContactError:  contact.length  < 2 ? 'Contact name required'  : '',
      corpRegEmailError:    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? 'Valid email required' : '',
      corpRegPasswordError: password.length < 8 ? 'Min 8 characters'       : ''
    };
    let valid = true;
    Object.entries(errs).forEach(([id, msg]) => { const el = document.getElementById(id); if (el) el.textContent = msg; if (msg) valid = false; });
    if (!valid) return;

    if (typeof showLoading === 'function') showLoading(true, 'Creating account...');
    const sb = getSupabase();
    if (!sb) { if (typeof showLoading === 'function') showLoading(false); return; }
    try {
      const { data: authData, error: authErr } = await sb.auth.signUp({ email, password });
      if (authErr) throw authErr;
      const { error: insErr } = await sb.from('corporate_partners').insert([{
        user_id: authData.user.id, company_name: company, company_code: rawCode,
        contact_name: contact, email, industry
      }]);
      if (insErr) throw insErr;
      if (typeof showLoading === 'function') showLoading(false);
      if (typeof showToast === 'function') showToast('Account created! Check your email to verify, then log in.', 'success');
      if (typeof showScreen === 'function') showScreen('corporate-login');
    } catch (err) {
      if (typeof showLoading === 'function') showLoading(false);
      if (typeof showToast === 'function') showToast(err.message || 'Registration failed', 'error');
    }
  };

  // ── Corporate Dashboard ────────────────────────────────────────
  async function openCorporateDashboard() {
    if (!corpSession) return;
    const t = document.getElementById('corpDashTitle');
    const s = document.getElementById('corpDashSubtitle');
    if (t) t.textContent = corpSession.company_name + ' Dashboard';
    if (s) s.textContent = 'Code: ' + corpSession.company_code;
    const linkEl = document.getElementById('corpAgentLink');
    if (linkEl) linkEl.textContent = window.location.href.split('?')[0] + '?agent=' + corpSession.company_code;
    if (typeof showScreen === 'function') showScreen('corporate-dashboard');
    await loadCorpStats();
  }

  async function loadCorpStats() {
    if (!corpSession) return;
    const sb = getSupabase();
    if (!sb) return;
    try {
      const { data, error } = await sb.from('agent_submissions').select('state').eq('company_code', corpSession.company_code);
      if (error) throw error;
      const totalEl  = document.getElementById('corpStatTotal');
      const statesEl = document.getElementById('corpStatStates');
      const states   = [...new Set(data.map(r => r.state).filter(Boolean))];
      if (totalEl)  totalEl.textContent  = data.length;
      if (statesEl) statesEl.textContent = states.length;
      const breakdown = {};
      data.forEach(r => { if (r.state) breakdown[r.state] = (breakdown[r.state] || 0) + 1; });
      const sorted = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
      const breakdownEl = document.getElementById('corpStateBreakdown');
      if (breakdownEl) {
        breakdownEl.innerHTML = sorted.length === 0
          ? '<em>No submissions yet. Share the agent link to get started.</em>'
          : sorted.map(([state, count]) =>
              `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f3f4f6;">
                <span>${state}</span><span style="font-weight:600;color:#7c3aed;">${count} agent${count>1?'s':''}</span>
              </div>`).join('');
      }
    } catch (err) { console.warn('Corp stats error:', err.message); }
  }

  async function loadCorpSubmissions() {
    if (!corpSession) return;
    const sb     = getSupabase();
    const listEl = document.getElementById('corpSubmissionsList');
    if (!listEl) return;
    listEl.innerHTML = '<em style="color:#687076;">Loading...</em>';
    try {
      const { data, error } = await sb.from('agent_submissions').select('*').eq('company_code', corpSession.company_code).order('created_at', { ascending: false });
      if (error) throw error;
      if (!data || data.length === 0) { listEl.innerHTML = '<em style="color:#687076;">No agent submissions yet.</em>'; return; }
      listEl.innerHTML = data.map(sub => `
        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
            <div><span style="font-weight:600;font-size:13px;">${sub.agent_name||'Agent'}</span><span style="font-size:11px;color:#687076;margin-left:8px;">#${sub.agent_code}</span></div>
            <span style="font-size:11px;background:#f5f3ff;color:#7c3aed;padding:2px 8px;border-radius:20px;">${sub.state||'—'}</span>
          </div>
          <div style="font-size:12px;color:#374151;margin-bottom:4px;">📍 ${sub.city||'—'} &nbsp;|&nbsp; 📞 ${sub.phone||'—'}</div>
          <div style="font-size:12px;color:#374151;background:#f9fafb;padding:8px;border-radius:6px;margin-top:6px;">${sub.sizing_summary||'—'}</div>
          <div style="font-size:11px;color:#9ca3af;margin-top:6px;">${sub.created_at ? new Date(sub.created_at).toLocaleString('en-NG') : ''}</div>
        </div>`).join('');
    } catch (err) { listEl.innerHTML = '<em style="color:#ef4444;">Failed to load: ' + err.message + '</em>'; }
  }

  window.corporateDownloadReport = async function () {
    if (!corpSession) return;
    const sb = getSupabase();
    if (typeof showLoading === 'function') showLoading(true, 'Preparing report...');
    try {
      const { data, error } = await sb.from('agent_submissions').select('*').eq('company_code', corpSession.company_code).order('state', { ascending: true });
      if (error) throw error;
      if (!data || data.length === 0) {
        if (typeof showLoading === 'function') showLoading(false);
        if (typeof showToast === 'function') showToast('No submissions to export yet', 'error');
        return;
      }
      const headers = ['Agent Code','Agent Name','Phone','State','City','Inverter (kVA)','Panels','Daily Load (kWh)','Submission Date'];
      const rows = data.map(r => {
        const s = r.sizing_json || {};
        return [r.agent_code||'', r.agent_name||'', r.phone||'', r.state||'', r.city||'',
          s.invKva||'', s.numPanels||'', s.dailyKwh ? Number(s.dailyKwh).toFixed(2) : '',
          r.created_at ? new Date(r.created_at).toLocaleDateString('en-NG') : ''
        ].map(v => '"' + String(v).replace(/"/g,'""') + '"');
      });
      const csv  = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = corpSession.company_code + '_agents_' + new Date().toISOString().slice(0,10) + '.csv';
      a.click(); URL.revokeObjectURL(url);
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
    navigator.clipboard.writeText(linkEl.textContent)
      .then(() => { if (typeof showToast === 'function') showToast('Link copied!', 'success'); })
      .catch(() => { if (typeof showToast === 'function') showToast('Copy failed — copy manually', 'error'); });
  };

  // ── Agent Code Entry (I'm an Agent card) ──────────────────────
  window.agentEnterWithCode = async function () {
    const code   = (document.getElementById('agentEntryCode')?.value || '').trim().toUpperCase();
    const errEl  = document.getElementById('agentEntryCodeError');
    const nameEl = document.getElementById('agentEntryCompanyName');
    if (errEl)  errEl.textContent  = '';
    if (nameEl) nameEl.textContent = '';
    if (!code || code.length < 2) { if (errEl) errEl.textContent = 'Please enter your company code'; return; }

    if (typeof showLoading === 'function') showLoading(true, 'Looking up company...');
    const sb = getSupabase();
    try {
      let companyName = null;
      if (sb) {
        const { data } = await sb.from('corporate_partners').select('company_name').eq('company_code', code).single();
        if (data) companyName = data.company_name;
      }
      if (typeof showLoading === 'function') showLoading(false);
      if (!companyName) { if (errEl) errEl.textContent = 'Company code not found. Check with your manager.'; return; }
      agentPortalCode = code;
      const portalNameEl = document.getElementById('agentPortalCompanyName');
      if (portalNameEl) portalNameEl.textContent = companyName + ' — Agent Portal';
      resetAgentSession();
      if (typeof showScreen === 'function') showScreen('corporate-agent-portal');
    } catch (err) {
      if (typeof showLoading === 'function') showLoading(false);
      if (errEl) errEl.textContent = 'Could not verify code. Check your connection and try again.';
    }
  };

  function setupAgentCodeLivePreview() {
    const input = document.getElementById('agentEntryCode');
    if (!input || input._corpListenerAttached) return;
    input._corpListenerAttached = true;
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
          const { data } = await sb.from('corporate_partners').select('company_name').eq('company_code', code).single();
          if (data && nameEl) nameEl.textContent = '✓ ' + data.company_name;
        } catch (e) {}
      }, 600);
    });
  }

  // ── Agent Portal Step 1: Details → navigate to real calculator ─
  window.agentGoToCalculator = function () {
    const code  = (document.getElementById('agentCode')?.value  || '').trim().toUpperCase();
    const name  = (document.getElementById('agentName')?.value  || '').trim();
    const phone = (document.getElementById('agentPhone')?.value || '').trim();
    const state = (document.getElementById('agentState')?.value || '');
    const city  = (document.getElementById('agentCity')?.value  || '').trim();

    let valid = true;
    [['agentCodeError',  !code,           'Agent code required'],
     ['agentNameError',  name.length < 2, 'Name required'],
     ['agentPhoneError', phone.length < 7,'Phone required'],
     ['agentStateError', !state,          'Please select your state']
    ].forEach(([id, fail, msg]) => {
      const el = document.getElementById(id);
      if (el) el.textContent = fail ? msg : '';
      if (fail) valid = false;
    });
    if (!valid) return;

    agentInfo = { code, name, phone, state, city };

    // Update info bar on agent portal
    const infoBar  = document.getElementById('agentInfoBar');
    const infoText = document.getElementById('agentInfoText');
    if (infoText) infoText.textContent = `Agent: ${name} (#${code}) — ${city ? city + ', ' : ''}${state}`;
    if (infoBar)  infoBar.style.display = '';

    // Reset calc
    if (typeof l4u_resetCalculatorSession === 'function') l4u_resetCalculatorSession();
    agentCalcResult = null;
    agentLastApps   = [];

    // Navigate to real user-calculator in agent mode
    if (typeof showScreen === 'function') showScreen('user-calculator');
    // enterAgentCalcMode is called from our showScreen hook below
  };

  window.agentChangeDetails = function () {
    // Return to agent portal step 1
    exitAgentCalcMode();
    if (typeof showScreen === 'function') showScreen('corporate-agent-portal');
  };

  window.agentBackToStep1 = function () {
    exitAgentCalcMode();
    if (typeof showScreen === 'function') showScreen('corporate-agent-portal');
  };

  window.agentStartOver = function () {
    resetAgentSession();
    if (typeof showScreen === 'function') showScreen('corporate-agent-portal');
  };

  // ── Intercept receiveEmbeddedCalculation ──────────────────────
  const _origReceiveCalc = window.receiveEmbeddedCalculation;
  window.receiveEmbeddedCalculation = function (mode, result, apps) {
    if (typeof _origReceiveCalc === 'function') _origReceiveCalc(mode, result, apps);
    if (mode === 'user' && agentInfo) {
      agentCalcResult = result;
      agentLastApps   = apps || [];
      // Show agent submit after enterAgentCalcMode's 50ms timeout has cleared.
      // enterAgentCalcMode is triggered by showScreen('user-calculator') inside
      // the original handler; it runs at +50ms and would re-hide the panel if
      // we set display here synchronously. Waiting 80ms ensures we win the race.
      setTimeout(function () {
        const userActions  = document.getElementById('userPostCalcActions');
        const agentActions = document.getElementById('agentPostCalcActions');
        if (userActions)  userActions.style.display  = 'none';
        if (agentActions) agentActions.style.display = '';
      }, 80);
    }
  };

  // ── Agent Submit ───────────────────────────────────────────────
  window.agentConfirmSubmit = async function () {
    if (!agentInfo)       { if (typeof showToast === 'function') showToast('Please fill in your details first', 'error'); return; }
    if (!agentCalcResult) { if (typeof showToast === 'function') showToast('Please calculate your system first', 'error'); return; }

    const r            = agentCalcResult;
    const invKva       = r.invKva   || 0;
    const panels       = r.numPanels || r.panels || 0;
    const dailyKwh     = r.dailyKwh  || 0;
    const sysV         = r.sysV || r.systemVoltage || 0;
    const batLabel     = r.batLabel  || '';
    const batUnits     = r.batUnits  || '';
    const sizingSummary = `Inverter: ${invKva}kVA | Panels: ${panels}× | Battery: ${batUnits ? batUnits + '× ' : ''}${batLabel} | Daily: ${typeof dailyKwh.toFixed === 'function' ? dailyKwh.toFixed(2) : dailyKwh}kWh | ${sysV}V`;

    if (typeof showLoading === 'function') showLoading(true, 'Submitting...');
    const sb = getSupabase();
    if (!sb) { if (typeof showLoading === 'function') showLoading(false); return; }
    try {
      const { error } = await sb.from('agent_submissions').insert([{
        company_code:    agentPortalCode || 'UNKNOWN',
        agent_code:      agentInfo.code,
        agent_name:      agentInfo.name,
        phone:           agentInfo.phone,
        state:           agentInfo.state,
        city:            agentInfo.city,
        appliances_json: JSON.stringify(agentLastApps),
        sizing_json:     JSON.stringify(agentCalcResult),
        sizing_summary:  sizingSummary,
      }]);
      if (error) throw error;
      if (typeof showLoading === 'function') showLoading(false);
      exitAgentCalcMode();
      const successEl = document.getElementById('agentSuccessSummary');
      if (successEl) {
        successEl.innerHTML = `
          <div style="margin-bottom:6px;"><strong>Agent:</strong> ${agentInfo.name} (#${agentInfo.code})</div>
          <div style="margin-bottom:6px;"><strong>Location:</strong> ${agentInfo.city ? agentInfo.city + ', ' : ''}${agentInfo.state}</div>
          <div><strong>System:</strong> ${sizingSummary}</div>`;
      }
      if (typeof showScreen === 'function') showScreen('corporate-agent-success');
    } catch (err) {
      if (typeof showLoading === 'function') showLoading(false);
      if (typeof showToast === 'function') showToast('Submission failed: ' + err.message, 'error');
    }
  };

  // ── Hook showScreen ────────────────────────────────────────────
  const _origShowScreen = window.showScreen;
  window.showScreen = function (screenId) {
    if (typeof _origShowScreen === 'function') _origShowScreen(screenId);

    if (screenId === 'user-calculator') {
      if (agentInfo) {
        // Small delay so platform.js finishes its own showScreen logic first
        setTimeout(enterAgentCalcMode, 50);
      } else {
        exitAgentCalcMode();
      }
    }
    if (screenId === 'corporate-submissions')              loadCorpSubmissions();
    if (screenId === 'corporate-dashboard' && corpSession) loadCorpStats();
    if (screenId === 'agent-code-entry')                   setupAgentCodeLivePreview();
    // When leaving agent portal to anywhere other than user-calculator, clean up
    if (screenId !== 'user-calculator' && screenId !== 'corporate-agent-portal' && screenId !== 'corporate-agent-success') {
      if (!corpSession) exitAgentCalcMode(); // only if not corporate user
    }
  };

  // ── Init ───────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkAgentUrl);
  } else {
    checkAgentUrl();
  }

})();
