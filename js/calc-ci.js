// ═══════════════════════════════════════════════════════════════════════════
// EnergyGuide — C&I Calculator Engine v2 (calc-ci.js)
// Namespace: l4ci_ (public), l4ci__ (internal) — unchanged from v1 so that
// eg-analytics.js's monkey-patch of window.l4ci_calculate keeps working
// with zero changes on that file.
//
// PIPELINE (per spec):
//   INPUT → Energy Conversion → Load Estimation →
//   Solar + Battery + Inverter Sizing → BOM → Financial Analysis → OUTPUT
//
// This file is split into two pure, independently-testable modules:
//   1. SIZING ENGINE  — business/energy inputs → system size (kW/kWh/kVA)
//   2. BOM ENGINE      — system size → full bill of materials + warnings
// A third small module (FINANCIAL ENGINE) computes savings/payback.
// The orchestrator at the bottom wires these to the DOM, matching the
// public contract the rest of the app expects: window.l4ci_calculate(),
// window.l4ci__lastResult, window.l4ci_pickBess() (kept as a no-op-safe
// stub — see note near the bottom).
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // ───────────────────────────────────────────────────────────────────────
  // GLOBAL CONSTANTS / DEFAULT ASSUMPTIONS (per spec, sections 3 & 2 of BOM doc)
  // ───────────────────────────────────────────────────────────────────────
  const DEFAULTS = {
    sun_hours: 5,
    system_efficiency: 0.75,
    power_factor: 0.85,
    battery_DoD_lithium: 0.8,
    diversity_factor: 1.3,
    tariff_default: 120, // ₦/kWh — midpoint of the 100–150 editable range
    diesel_cost_per_kwh: 250,
    // Indicative-only installed cost range (₦/kW), used ONLY until a real
    // vendor/installer quote is submitted through the platform. Sourced
    // from a blend of published Nigerian C&I solar market pricing
    // (bands quoted, not a single rate — no defensible single figure
    // exists given battery-mix, brand-tier, and FX variability). Revisit
    // this periodically — it will go stale as FX/import costs move.
    // Sourced July 2026 — see NREL 2024 commercial benchmark (~$1.55/W)
    // cross-checked against Nigerian market listings for C&I-scale systems.
    cost_per_kw_low: 450000,
    cost_per_kw_high: 750000
  };

  // Fixed system-scope assumptions (no product database yet — see MVP spec §7)
  const SYSTEM_DEFAULTS = {
    system_type: 'hybrid',     // 'grid_tied' | 'hybrid' — defaulted, not user-facing yet
    phase: 'three_phase'       // 'single' | 'three_phase' — defaulted, not user-facing yet
  };

  const LOAD_PROFILE = {
    office:   { day: 0.80, night: 0.20 },
    factory:  { day: 0.70, night: 0.30 },
    hospital: { day: 0.50, night: 0.50 },
    mall:     { day: 0.75, night: 0.25 },
    other:    { day: 0.75, night: 0.25 } // reasonable fallback, not in spec table
  };

  const GLOBAL = {
    panel: { watt: 550, voc: 49, isc: 13 },
    inverter: { max_dc_voltage: 1000, mppt: 2, max_strings_per_mppt: 2, standard_sizes: [10, 20, 30, 50] },
    battery: { unit_kwh: 12, dod: 0.8, batteries_per_rack: 5 },
    electrical: { voltage_ac: 415, power_factor: 0.85 },
    earthing: { soil_resistivity: 100, rod_length: 3, rod_diameter: 0.016, target_resistance: 2, efficiency: 0.8 }
  };

  // ───────────────────────────────────────────────────────────────────────
  // HELPERS
  // ───────────────────────────────────────────────────────────────────────
  function nearestAbove(sizes, value) {
    for (let i = 0; i < sizes.length; i++) if (sizes[i] >= value) return sizes[i];
    return sizes[sizes.length - 1]; // largest available if value exceeds all
  }
  function nearestStandardBreaker(sizes, value) {
    for (let i = 0; i < sizes.length; i++) if (sizes[i] >= value) return sizes[i];
    return sizes[sizes.length - 1];
  }
  function round1(n) { return Math.round(n * 10) / 10; }
  function round2(n) { return Math.round(n * 100) / 100; }

  // ═══════════════════════════════════════════════════════════════════════
  // MODULE 1 — SIZING ENGINE
  // Pure function: raw business/energy inputs → system size.
  // Matches spec sections 3–5 (steps 1–8) exactly.
  // ═══════════════════════════════════════════════════════════════════════
  function runSizingEngine(inputs) {
    const errors = [];

    const business_type = inputs.business_type || 'other';
    const sun_hours = inputs.sun_hours || DEFAULTS.sun_hours;
    const tariff = inputs.tariff || DEFAULTS.tariff_default;
    const operating_hours_per_day = inputs.operating_hours_per_day;
    const critical_load_percentage = (inputs.critical_load_percentage != null) ? inputs.critical_load_percentage : 100;
    const backup_hours = inputs.backup_hours;
    const has_night_load = !!inputs.has_night_load;

    if (!operating_hours_per_day || operating_hours_per_day <= 0) errors.push('Operating hours per day is required.');
    if (!backup_hours || backup_hours <= 0) errors.push('Backup hours is required.');
    if (!inputs.monthly_bill && !inputs.monthly_energy_kwh) errors.push('Enter either a monthly bill or monthly energy usage (kWh).');
    if (inputs.monthly_bill && !tariff) errors.push('Tariff is required when using monthly bill.');

    if (errors.length) return { ok: false, errors: errors };

    // STEP 1 — Monthly Energy (kWh)
    const monthly_energy_kwh = inputs.monthly_energy_kwh
      ? Number(inputs.monthly_energy_kwh)
      : Number(inputs.monthly_bill) / tariff;

    // STEP 2 — Daily Energy
    const daily_energy_kwh = monthly_energy_kwh / 30;

    // STEP 3 — Peak Load (kW)
    const raw_peak_kw = daily_energy_kwh / operating_hours_per_day;
    const peak_load_kw = raw_peak_kw * DEFAULTS.diversity_factor;

    // STEP 4 — Load Profile Split
    const profile = LOAD_PROFILE[business_type] || LOAD_PROFILE.other;
    const day_energy = daily_energy_kwh * profile.day;
    const night_energy = daily_energy_kwh * profile.night;

    // STEP 5 — Solar PV Sizing
    const raw_solar_kw = day_energy / sun_hours;
    const solar_size_kw = raw_solar_kw / DEFAULTS.system_efficiency;

    // STEP 6 — Battery Sizing (two methods, per spec; we take the larger of
    // the two so backup needs AND night-load needs are both covered — the
    // spec presents them as alternatives but doesn't say which wins, and
    // undersizing either one would leave a real operating gap).
    const critical_load_kw = peak_load_kw * (critical_load_percentage / 100);
    const battery_kwh_backup = (critical_load_kw * backup_hours) / DEFAULTS.battery_DoD_lithium;
    const battery_kwh_night = has_night_load ? (night_energy / DEFAULTS.battery_DoD_lithium) : 0;
    const battery_kwh = Math.max(battery_kwh_backup, battery_kwh_night);

    // STEP 7 — Inverter Sizing (3-phase)
    const inverter_kva = peak_load_kw / DEFAULTS.power_factor;

    // STEP 8 — Panel Count
    const number_of_panels = Math.ceil((solar_size_kw * 1000) / GLOBAL.panel.watt);

    return {
      ok: true,
      inputs: {
        business_type: business_type,
        monthly_bill: inputs.monthly_bill || null,
        monthly_energy_kwh: round1(monthly_energy_kwh),
        tariff: tariff,
        operating_hours_per_day: operating_hours_per_day,
        days_per_week: inputs.days_per_week || null,
        has_night_load: has_night_load,
        critical_load_percentage: critical_load_percentage,
        backup_hours: backup_hours,
        sun_hours: sun_hours
      },
      daily_energy_kwh: round1(daily_energy_kwh),
      peak_load_kw: round1(peak_load_kw),
      day_energy_kwh: round1(day_energy),
      night_energy_kwh: round1(night_energy),
      solar_size_kw: round1(solar_size_kw),
      battery_kwh: round1(battery_kwh),
      battery_kwh_backup: round1(battery_kwh_backup),
      battery_kwh_night: round1(battery_kwh_night),
      inverter_kva: round1(inverter_kva),
      number_of_panels: number_of_panels,
      critical_load_kw: round1(critical_load_kw)
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MODULE 2 — BOM ENGINE
  // Pure function per the Claude BOM spec, input schema exactly as given:
  // {solar_size_kw, battery_kwh, inverter_kva, peak_load_kw, backup_hours,
  //  system_type, phase, business_type}
  // ═══════════════════════════════════════════════════════════════════════
  function runBomEngine(sizing) {
    const solar_size_kw = sizing.solar_size_kw;
    const battery_kwh = sizing.battery_kwh;
    const inverter_kva = sizing.inverter_kva;

    const warnings = [];

    // MODULE 1 — Solar Panel & String Design
    const total_panels = Math.ceil((solar_size_kw * 1000) / GLOBAL.panel.watt);
    const max_panels_per_string = Math.floor(GLOBAL.inverter.max_dc_voltage / GLOBAL.panel.voc);
    const panels_per_string = Math.floor(max_panels_per_string * 0.9);
    const number_of_strings = Math.ceil(total_panels / panels_per_string);

    // MODULE 2 — Inverter Configuration
    const selected_inverter_size = nearestAbove(GLOBAL.inverter.standard_sizes, inverter_kva);
    const number_of_inverters = Math.ceil(inverter_kva / selected_inverter_size);
    const ratio = solar_size_kw / (number_of_inverters * selected_inverter_size);

    // MPPT check — scaled by the whole array's inverter count, not a single
    // unit. mppt × max_strings_per_mppt is one inverter's string capacity;
    // multiplying by number_of_inverters gives the array's true capacity.
    const max_strings_allowed = GLOBAL.inverter.mppt * GLOBAL.inverter.max_strings_per_mppt * number_of_inverters;
    if (number_of_strings > max_strings_allowed) warnings.push('MPPT_LIMIT_EXCEEDED');
    if (ratio > 1.3) warnings.push('PV_OVERSIZED');
    if (ratio < 1.0) warnings.push('PV_UNDERSIZED');

    // MODULE 3 — Battery System
    const battery_units = Math.ceil(battery_kwh / GLOBAL.battery.unit_kwh);
    const number_of_racks = Math.ceil(battery_units / GLOBAL.battery.batteries_per_rack);

    // MODULE 4 — DC Side
    const string_current = GLOBAL.panel.isc;
    let dc_cable;
    if (string_current <= 15) dc_cable = '4mm²';
    else if (string_current <= 25) dc_cable = '6mm²';
    else dc_cable = '10mm²';
    const combiner_boxes = (number_of_strings > 3) ? Math.ceil(number_of_strings / 4) : 0;
    const dc_isolators = number_of_inverters;

    // MODULE 5 — AC Side
    const I = (selected_inverter_size * 1000) / (1.732 * GLOBAL.electrical.voltage_ac);
    let ac_cable;
    if (I <= 50) ac_cable = '10mm²';
    else if (I <= 100) ac_cable = '25mm²';
    else ac_cable = '70mm²';
    const breaker_current = I * 1.25;
    const breaker = nearestStandardBreaker([32, 40, 63, 80, 100, 125, 160, 200], breaker_current);

    // MODULE 6 — Earthing System
    // Two parallel numbers by design, not reconciled into one:
    //   - calculated_rods: theoretical, from real soil-resistance physics
    //   - recommended_rods: practical override for real-world installation
    // The gap between them (often large) is itself the signal — a big gap
    // means poor soil conditions, and the notes/warning below say so
    // explicitly rather than silently picking one number.
    const e = GLOBAL.earthing;
    const R_single = (e.soil_resistivity / (2 * Math.PI * e.rod_length)) * Math.log((4 * e.rod_length) / e.rod_diameter);
    const n_rods_calc = Math.ceil(R_single / (e.target_resistance * e.efficiency));
    let rods_recommended;
    if (solar_size_kw < 20) rods_recommended = 2;
    else if (solar_size_kw < 100) rods_recommended = 4;
    else rods_recommended = 6;
    let earth_cable;
    if (inverter_kva <= 30) earth_cable = '6mm²';
    else if (inverter_kva <= 100) earth_cable = '10mm²';
    else earth_cable = '16mm²';
    const earth_points = {
      inverter: number_of_inverters,
      array: Math.ceil(total_panels / 30),
      lightning: 1
    };
    if (n_rods_calc > 10) warnings.push('HIGH_SOIL_RESISTIVITY_OR_POOR_GROUNDING');

    // MODULE 7 — Mounting Structure
    const mounting_sets = total_panels;
    const rail_length_m = total_panels * 2;

    // NEMSA flag — carried over from v1, not in the new spec explicitly but
    // a real Nigerian compliance requirement worth keeping surfaced.
    const nemsaFlag = sizing.peak_load_kw >= 100;

    return {
      solar: {
        panels: total_panels,
        panel_rating: '550W',
        strings: number_of_strings,
        panels_per_string: panels_per_string
      },
      inverter: {
        count: number_of_inverters,
        rating_kva: selected_inverter_size
      },
      battery: {
        units: battery_units,
        unit_kwh: GLOBAL.battery.unit_kwh,
        total_kwh: battery_kwh,
        racks: number_of_racks
      },
      dc: {
        cable: dc_cable,
        combiner_boxes: combiner_boxes,
        isolators: dc_isolators
      },
      ac: {
        cable: ac_cable,
        breaker: breaker,
        current_a: round1(I)
      },
      earthing: {
        calculated_rods: n_rods_calc,
        recommended_rods: rods_recommended,
        rod_spec: '3m copper-bonded, 16mm diameter',
        earth_cable: earth_cable,
        points: earth_points,
        soil_resistivity: e.soil_resistivity,
        target_resistance: '≤2Ω',
        single_rod_resistance: round2(R_single),
        notes: [
          'Calculated rods based on soil physics',
          'Recommended rods based on practical installation',
          'Use chemical grounding or earth grid if resistance is high'
        ]
      },
      mounting: {
        sets: mounting_sets,
        rail_length_m: rail_length_m
      },
      nemsaFlag: nemsaFlag,
      warnings: warnings
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MODULE 3 — FINANCIAL ENGINE (spec section 5)
  // ═══════════════════════════════════════════════════════════════════════
  function runFinancialEngine(sizing, opts) {
    opts = opts || {};
    const tariff = sizing.inputs.tariff;
    const monthly_energy_kwh = sizing.inputs.monthly_energy_kwh;

    const monthly_cost = monthly_energy_kwh * tariff;
    const monthly_solar_energy = sizing.solar_size_kw * sizing.inputs.sun_hours * 30;
    const monthly_savings = monthly_solar_energy * tariff;
    const annual_savings = monthly_savings * 12;

    let diesel_savings = null;
    if (opts.has_generator) {
      const dieselRate = opts.diesel_cost_per_kwh || DEFAULTS.diesel_cost_per_kwh;
      diesel_savings = monthly_solar_energy * dieselRate;
    }

    // Payback — hybrid strategy:
    //   - If a real system_cost is supplied (vendor/installer quote submitted
    //     through the platform), compute a single precise payback figure and
    //     flag it as quote-backed.
    //   - Otherwise, fall back to a wide indicative ₦/kW range so the user
    //     isn't left with no ROI signal at all — clearly labeled as rough,
    //     never presented as a quote.
    const solar_kw = sizing.solar_size_kw;
    let payback;
    if (opts.system_cost && opts.system_cost > 0) {
      payback = {
        source: 'vendor_quote',
        system_cost: Math.round(opts.system_cost),
        payback_years: round2(opts.system_cost / annual_savings),
        label: 'Updated with vendor quote'
      };
    } else {
      const costLow = solar_kw * DEFAULTS.cost_per_kw_low;
      const costHigh = solar_kw * DEFAULTS.cost_per_kw_high;
      payback = {
        source: 'indicative_estimate',
        system_cost_low: Math.round(costLow),
        system_cost_high: Math.round(costHigh),
        payback_years_low: round2(costLow / annual_savings),
        payback_years_high: round2(costHigh / annual_savings),
        label: 'Indicative estimate — not a quote',
        disclaimer: 'Actual system cost depends on equipment tier, brand, and site conditions. Request a quote from an installer for exact pricing.'
      };
    }

    // Coverage estimates
    const daytime_coverage = Math.min(100, round1((monthly_solar_energy / (sizing.day_energy_kwh * 30)) * 100));
    const total_energy_offset = Math.min(100, round1((monthly_solar_energy / monthly_energy_kwh) * 100));

    return {
      monthly_cost: Math.round(monthly_cost),
      monthly_solar_energy: round1(monthly_solar_energy),
      monthly_savings: Math.round(monthly_savings),
      annual_savings: Math.round(annual_savings),
      diesel_savings: diesel_savings != null ? Math.round(diesel_savings) : null,
      payback: payback,
      daytime_coverage: daytime_coverage,
      total_energy_offset: total_energy_offset
    };
  }

  function buildBehaviorSummary(sizing, financial) {
    const nightPart = sizing.inputs.has_night_load
      ? ' and approximately ' + Math.min(100, Math.round((sizing.battery_kwh_night > 0 ? (sizing.battery_kwh / sizing.night_energy_kwh) * 100 : 100))) + '% of your night load'
      : '';
    return 'This system will power ' + financial.daytime_coverage + '% of your daytime operations' + nightPart + '.';
  }

  // Expose modules for testing / reuse without DOM
  window.l4ci_v2 = {
    runSizingEngine: runSizingEngine,
    runBomEngine: runBomEngine,
    runFinancialEngine: runFinancialEngine,
    buildBehaviorSummary: buildBehaviorSummary,
    DEFAULTS: DEFAULTS,
    GLOBAL: GLOBAL,
    SYSTEM_DEFAULTS: SYSTEM_DEFAULTS
  };

  // ═══════════════════════════════════════════════════════════════════════
  // DOM ORCHESTRATION LAYER
  // Public contract preserved exactly for the rest of the app:
  //   window.l4ci_calculate()      — eg-analytics.js monkey-patches this
  //   window.l4ci__lastResult      — read by corporate.js, platform.js,
  //                                   eg-post-calc-extras.js
  //   window.l4ci_pickBess()       — kept as safe no-op; v2's BESS sizing
  //                                   is a single derived kWh figure, not
  //                                   a pick-list of hardware options like
  //                                   v1's 100kWh/215kWh pack choice, so
  //                                   there is nothing to switch between.
  //                                   Any old UI calling this won't error.
  // ═══════════════════════════════════════════════════════════════════════

  function $(id) { return document.getElementById(id); }
  function setText(id, val) { const el = $(id); if (el) el.textContent = val; }
  function fmtNaira(n) { return '₦' + Math.round(n).toLocaleString('en-NG'); }

  function readInputs() {
    const mode = window._ci2EnergyMode || 'bill';
    const backupHrs = parseFloat($('ci2-inp-backup-hrs') && $('ci2-inp-backup-hrs').value) || window._ci2BackupHrs;
    const opHrs = parseFloat($('ci2-inp-op-hours') && $('ci2-inp-op-hours').value) || window._ci2OpHrs;

    return {
      business_type: $('ci2-inp-business-type') ? $('ci2-inp-business-type').value : 'other',
      monthly_bill: mode === 'bill' ? parseFloat($('ci2-inp-monthly-bill').value) || null : null,
      monthly_energy_kwh: mode === 'kwh' ? parseFloat($('ci2-inp-monthly-kwh').value) || null : null,
      tariff: parseFloat($('ci2-inp-tariff') && $('ci2-inp-tariff').value) || DEFAULTS.tariff_default,
      operating_hours_per_day: opHrs,
      days_per_week: parseFloat($('ci2-inp-days-week') && $('ci2-inp-days-week').value) || null,
      has_night_load: $('ci2-inp-night-load') ? $('ci2-inp-night-load').checked : false,
      critical_load_percentage: parseFloat($('ci2-inp-critical-pct') && $('ci2-inp-critical-pct').value) || 50,
      backup_hours: backupHrs
    };
  }

  function renderWarnings(warnings) {
    const el = $('ci2-r-warnings');
    if (!el) return;
    el.innerHTML = '';
    const MESSAGES = {
      MPPT_LIMIT_EXCEEDED: { color: '#fca5a5', bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.35)', text: 'String count exceeds this inverter configuration\'s MPPT input capacity. Additional combiner/re-stringing design or higher-MPPT inverter units required.' },
      PV_OVERSIZED: { color: '#fcd34d', bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.35)', text: 'Solar array is oversized relative to inverter capacity (ratio > 1.3). Consider a larger inverter stack.' },
      PV_UNDERSIZED: { color: '#fcd34d', bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.35)', text: 'Solar array is undersized relative to inverter capacity (ratio < 1.0). Inverter stack has spare headroom.' }
    };
    warnings.forEach(function (w) {
      if (w === 'HIGH_SOIL_RESISTIVITY_OR_POOR_GROUNDING') return; // shown in earthing card, not here
      const m = MESSAGES[w];
      if (!m) return;
      const div = document.createElement('div');
      div.style.cssText = 'background:' + m.bg + ';border:1px solid ' + m.border + ';border-radius:8px;padding:10px 12px;font-size:12px;color:' + m.color + ';line-height:1.5;margin-top:6px;';
      div.textContent = '⚠️ ' + m.text;
      el.appendChild(div);
    });
  }

  function renderBomTable(bom) {
    const body = $('ci2-r-bom-body');
    if (!body) return;
    const rows = [
      ['550W Solar Panel', bom.solar.panels],
      ['Inverter (' + bom.inverter.rating_kva + 'kVA)', bom.inverter.count],
      ['Battery Unit (' + bom.battery.unit_kwh + 'kWh)', bom.battery.units],
      ['Battery Rack', bom.battery.racks],
      ['DC Combiner Box', bom.dc.combiner_boxes],
      ['DC Isolator', bom.dc.isolators],
      ['AC Breaker (' + bom.ac.breaker + 'A)', 1],
      ['Earth Rod (recommended)', bom.earthing.recommended_rods],
      ['Mounting Rail Set', bom.mounting.sets]
    ];
    body.innerHTML = rows.map(function (r) {
      return '<tr style="border-top:1px solid var(--border,#334155);">' +
        '<td style="padding:9px 12px;font-size:12px;color:#e2e8f0;">' + r[0] + '</td>' +
        '<td style="padding:9px 6px;text-align:center;font-size:12px;color:#94a3b8;">' + r[1] + '</td>' +
        '<td style="padding:9px 8px;text-align:right;font-size:11px;color:#64748b;">Quote Required</td>' +
        '</tr>';
    }).join('');
  }

  function renderPayback(financial) {
    const p = financial.payback;
    if (p.source === 'vendor_quote') {
      setText('ci2-r-payback-label', 'PAYBACK PERIOD');
      setText('ci2-r-payback', p.payback_years + ' years');
      setText('ci2-r-payback-disclaimer', '✅ ' + p.label + ' — based on submitted system cost of ' + fmtNaira(p.system_cost) + '.');
    } else {
      setText('ci2-r-payback-label', 'PAYBACK PERIOD (INDICATIVE)');
      setText('ci2-r-payback', p.payback_years_low + ' – ' + p.payback_years_high + ' years');
      setText('ci2-r-payback-disclaimer', p.disclaimer);
    }
  }

  function renderResults(sizing, bom, financial) {
    $('ci2-error').style.display = 'none';
    $('ci2-placeholder').style.display = 'none';
    $('ci2-results').style.display = 'block';

    setText('ci2-r-summary', buildBehaviorSummary(sizing, financial));
    $('ci2-r-nemsa-flag').style.display = bom.nemsaFlag ? 'block' : 'none';

    setText('ci2-r-solar-kw', sizing.solar_size_kw + ' kWp');
    setText('ci2-r-panels', bom.solar.panels + ' × 550W panels');

    setText('ci2-r-battery-kwh', sizing.battery_kwh + ' kWh');
    setText('ci2-r-battery-units', bom.battery.units + ' units (' + bom.battery.unit_kwh + 'kWh each) across ' + bom.battery.racks + ' rack(s)');
    setText('ci2-r-battery-basis', sizing.battery_kwh_night > sizing.battery_kwh_backup ? 'Sized by night-load requirement' : 'Sized by critical-load backup requirement');

    setText('ci2-r-inverter-kva', sizing.inverter_kva + ' kVA');
    setText('ci2-r-inverter-config', bom.inverter.count + ' × ' + bom.inverter.rating_kva + 'kVA units, 3-phase');
    renderWarnings(bom.warnings);

    setText('ci2-r-daytime-coverage', financial.daytime_coverage + '%');
    setText('ci2-r-total-offset', financial.total_energy_offset + '%');

    setText('ci2-r-strings', bom.solar.strings + ' strings × ' + bom.solar.panels_per_string + ' panels/string');
    setText('ci2-r-combiners', bom.dc.combiner_boxes > 0 ? bom.dc.combiner_boxes + ' combiner box(es) required' : 'No combiner box required (≤3 strings)');

    setText('ci2-r-dc-cable', bom.dc.cable);
    setText('ci2-r-ac-cable', bom.ac.cable);
    setText('ci2-r-breaker', bom.ac.breaker + 'A');
    setText('ci2-r-isolators', bom.dc.isolators + ' isolators / ' + bom.dc.combiner_boxes + ' combiners');

    setText('ci2-r-earth-recommended', bom.earthing.recommended_rods + ' rods');
    setText('ci2-r-earth-spec', bom.earthing.rod_spec);
    setText('ci2-r-earth-cable', bom.earthing.earth_cable);
    setText('ci2-r-earth-note', '⚠️ Theoretical calculation suggests ' + bom.earthing.calculated_rods + ' rods for ≤2Ω in this soil model — the recommended count above is the practical installation figure. ' + bom.earthing.notes[2]);

    setText('ci2-r-monthly-savings', fmtNaira(financial.monthly_savings) + '/mo');
    setText('ci2-r-annual-savings', fmtNaira(financial.annual_savings) + '/yr');

    if (financial.diesel_savings != null) {
      $('ci2-r-diesel-row').style.display = 'block';
      setText('ci2-r-diesel-savings', fmtNaira(financial.diesel_savings) + '/mo vs. diesel');
    } else {
      $('ci2-r-diesel-row').style.display = 'none';
    }

    renderPayback(financial);
    renderBomTable(bom);
  }

  function showError(msg) {
    const el = $('ci2-error');
    if (!el) return;
    el.style.display = 'block';
    el.textContent = msg;
    $('ci2-results').style.display = 'none';
    $('ci2-placeholder').style.display = 'block';
  }

  // Public entry point — name preserved for eg-analytics.js's monkey-patch
  window.l4ci_calculate = function () {
    const inputs = readInputs();
    const sizing = runSizingEngine(inputs);

    if (!sizing.ok) {
      showError(sizing.errors.join(' '));
      return;
    }

    const bom = runBomEngine(sizing);
    const hasGenerator = $('ci2-inp-has-generator') ? $('ci2-inp-has-generator').checked : false;
    const financial = runFinancialEngine(sizing, {
      has_generator: hasGenerator,
      system_cost: window._ci2SystemCostOverride || null
    });

    renderResults(sizing, bom, financial);

    // Public result object — shape is NEW (does not match v1), but the
    // window property name and its role as "the last calculation" is
    // preserved for corporate.js / platform.js / eg-post-calc-extras.js,
    // which are being rewritten against this new shape in the same pass.
    window.l4ci__lastResult = {
      sizing: sizing,
      bom: bom,
      financial: financial,
      summary: buildBehaviorSummary(sizing, financial),
      calculatedAt: new Date().toISOString()
    };

    document.dispatchEvent(new CustomEvent('eg:ci-calculated'));
  };

  // Re-runs ONLY the financial engine against the last stored sizing/BOM —
  // used when a vendor/installer prices a system in the Build Quote/Offer
  // screen (cibRecalc), so the payback figure on the calculator screen
  // sharpens from "indicative" to "quote-backed" without forcing the user
  // to re-navigate and re-run the full sizing pipeline.
  window.l4ci_refreshFinancials = function () {
    const r = window.l4ci__lastResult;
    if (!r) return;
    const hasGenerator = $('ci2-inp-has-generator') ? $('ci2-inp-has-generator').checked : false;
    const financial = runFinancialEngine(r.sizing, {
      has_generator: hasGenerator,
      system_cost: window._ci2SystemCostOverride || null
    });
    r.financial = financial;
    r.summary = buildBehaviorSummary(r.sizing, financial);
    // Only re-render if the calculator results screen is currently visible
    // (it may not be, if the user is on the builder screen right now) —
    // avoids writing to hidden/stale DOM nodes.
    if ($('ci2-results') && $('ci2-results').style.display !== 'none') {
      setText('ci2-r-summary', r.summary);
      setText('ci2-r-monthly-savings', fmtNaira(financial.monthly_savings) + '/mo');
      setText('ci2-r-annual-savings', fmtNaira(financial.annual_savings) + '/yr');
      renderPayback(financial);
    }
  };

  // Kept as a safe no-op for any old markup/onclick still referencing it —
  // v2 has no BESS pack alternatives to switch between (see note above).
  window.l4ci_pickBess = function () {
    console.warn('l4ci_pickBess is a no-op in the v2 C&I engine — battery sizing is a single derived figure, not a pack selection.');
  };

  // Input mode toggle (bill vs kWh) and quick-select chips
  window.l4ci_setEnergyInputMode = function (mode) {
    window._ci2EnergyMode = mode;
    const billTab = $('ci2-tab-bill'), kwhTab = $('ci2-tab-kwh');
    const billField = $('ci2-field-bill'), kwhField = $('ci2-field-kwh');
    if (mode === 'bill') {
      billField.style.display = 'block'; kwhField.style.display = 'none';
      billTab.style.background = 'rgba(14,165,233,0.15)'; billTab.style.borderColor = '#0ea5e9'; billTab.style.color = '#38bdf8';
      kwhTab.style.background = 'transparent'; kwhTab.style.borderColor = 'var(--border,#334155)'; kwhTab.style.color = 'var(--text,#f1f5f9)';
    } else {
      billField.style.display = 'none'; kwhField.style.display = 'block';
      kwhTab.style.background = 'rgba(14,165,233,0.15)'; kwhTab.style.borderColor = '#0ea5e9'; kwhTab.style.color = '#38bdf8';
      billTab.style.background = 'transparent'; billTab.style.borderColor = 'var(--border,#334155)'; billTab.style.color = 'var(--text,#f1f5f9)';
    }
  };
  window._ci2EnergyMode = 'bill';

  window.l4ci_setOpHrs = function (h) {
    window._ci2OpHrs = h;
    if ($('ci2-inp-op-hours')) $('ci2-inp-op-hours').value = h;
  };
  window.l4ci_setBackupHrs = function (h) {
    window._ci2BackupHrs = h;
    if ($('ci2-inp-backup-hrs')) $('ci2-inp-backup-hrs').value = h;
  };

  // Handoff from residential calculator's oversize flag. Per decision:
  // pre-fill is dropped entirely — we only show a short context note.
  // No sessionStorage read, no field pre-population. This replaces v1's
  // eg:ci-handoff listener and its peakKw/dailyKwh payload entirely.
  document.addEventListener('eg:ci-handoff', function () {
    const note = $('ci2-handoff-note');
    if (note) note.style.display = 'block';
  });

})();

