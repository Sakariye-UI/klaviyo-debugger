// ─── THEME ───────────────────────────────────────────────────────────────────
// Apply saved theme immediately (before DOM paint) to avoid flash
const _savedTheme = localStorage.getItem('kdbg-theme') || 'dark';
document.body.setAttribute('data-theme', _savedTheme);

function applyThemeIcons(theme) {
  const moon = document.querySelector('.icon-moon');
  const sun  = document.querySelector('.icon-sun');
  if (!moon || !sun) return;
  if (theme === 'dark') {
    moon.style.display = 'none';
    sun.style.display  = '';
  } else {
    moon.style.display = '';
    sun.style.display  = 'none';
  }
}

// ─── STATE ───────────────────────────────────────────────────────────────────
let selectedArea      = 'flows';
let selectedTrigger   = 'metric';
let selectedTimeRange = '2d';
let selectedTimeMinutes = 2880; // 2 days default
let selectedTimeMode = 'relative';   // 'relative' | 'date'
let selectedSpecificDate = '';       // 'YYYY-MM-DD' when mode = 'date'

const TIME_MIN = 30;       // 30 minutes
const TIME_MAX = 129600;   // 90 days in minutes
let selectedTool      = 'chronosphere'; // for tool toggle
let selectedCampaignScenario = 'created';
let selectedListScenario     = 'profile_deleted';
let selectedBillingScenario  = 'auto_upgrade';

// Suppression multi-check state
let selectedSuppressionChecks = ['account_level']; // default: first check only
const SUPP_NEEDS_PROFILE = ['profile_manual', 'who_suppressed', 'existing_90day'];
const SUPP_NEEDS_LIST    = ['list_growth'];
let selectedFormScenario     = 'set_draft';
let selectedReviewScenario   = 'not_triggering';
let port = null;
let stepElements = [];
let currentRunningStepIndex = -1; // tracks which step is actively running

// ─── TOOL ROUTING MAP ─────────────────────────────────────────────────────────
const AREA_TOOLS = {
  flows:          'chronosphere', // (list_segment step 1 uses splunk internally)
  campaigns:      'splunk',
  lists_profiles: 'splunk',
  billing:        'splunk',
  forms:          'splunk',
  push:           'splunk',
  reviews:        'splunk',
  integrations:   'splunk',
};

const TOOL_LABELS = {
  chronosphere: { text: 'Chronosphere', color: '#13b67f' },
  splunk:       { text: 'Splunk',       color: '#e07c24' },
  both:         { text: 'Both',         color: '#6366f1' },
};

// ─── CONNECT TO BACKGROUND ───────────────────────────────────────────────────
function connectPort() {
  try {
    port = chrome.runtime.connect({ name: 'flow-debugger' });
    port.onMessage.addListener(handleBackgroundMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      // Reconnect immediately — service worker may have been killed by Chrome's
      // MV3 idle timeout. A 1-second delay here caused a window where clicking
      // Diagnose would silently drop the message.
      connectPort();
    });
  } catch (e) {
    port = null;
    setTimeout(connectPort, 500); // brief retry if connect itself threw
  }
}
connectPort();

// ─── BOOT ────────────────────────────────────────────────────────────────────
// (theme toggle wired up above; badges + fields initialised here)
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.addEventListener('click', () => {
      const current = document.body.getAttribute('data-theme') || 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      document.body.setAttribute('data-theme', next);
      localStorage.setItem('kdbg-theme', next);
      applyThemeIcons(next);
    });
  }
  applyThemeIcons(document.body.getAttribute('data-theme') || 'light');
  updateBadges();
  updateConditionalFields();
});

// ─── AREA BUTTONS ─────────────────────────────────────────────────────────────
document.querySelectorAll('.area-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.area-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedArea = btn.dataset.area;
    updateSections();
    updateBadges();
  });
});

function updateSections() {
  document.querySelectorAll('.area-section').forEach(s => s.style.display = 'none');
  const section = document.getElementById('section-' + selectedArea);
  if (section) section.style.display = '';

  // Tool toggle: show only for areas where choice makes sense
  // (currently none — but reserved for future overlap cases)
  document.getElementById('toolToggleGroup').style.display = 'none';
}

function updateBadges() {
  const container = document.getElementById('toolBadges');
  let tools = [];

  if (selectedArea === 'flows') {
    if (selectedTrigger === 'list_segment') {
      tools = ['splunk', 'chronosphere'];
    } else {
      tools = ['chronosphere'];
    }
  } else {
    tools = ['splunk'];
  }

  container.innerHTML = tools.map(t =>
    `<span class="header-badge" style="background:${TOOL_LABELS[t].color}20;color:${TOOL_LABELS[t].color};border-color:${TOOL_LABELS[t].color}40">${TOOL_LABELS[t].text}</span>`
  ).join('');
}

// ─── TRIGGER TYPE PILLS (flows) ───────────────────────────────────────────────
document.querySelectorAll('#triggerType .pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('#triggerType .pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    selectedTrigger = pill.dataset.value;
    updateConditionalFields();
    updateBadges();
  });
});

function updateConditionalFields() {
  const isMetric  = selectedTrigger === 'metric';
  const isListSeg = selectedTrigger === 'list_segment';

  document.querySelectorAll('.metric-only').forEach(el =>
    el.style.display = isMetric ? '' : 'none');
  document.querySelectorAll('.listseg-only').forEach(el =>
    el.style.display = isListSeg ? '' : 'none');

  // Profile ID: required for list/segment trigger, optional for metric (Step 3 only)
  const profReq = document.getElementById('f_profileId_req');
  const profOpt = document.getElementById('f_profileId_opt');
  if (profReq) profReq.style.display = isListSeg ? '' : 'none';
  if (profOpt) profOpt.style.display = isMetric  ? '' : 'none';

  // Sync form section fields based on current scenario
  syncFormFields(selectedFormScenario);
}

// ─── SCENARIO PILLS ──────────────────────────────────────────────────────────
function wireScenarioPills(groupId, setter, conditionalFn) {
  document.querySelectorAll(`#${groupId} .pill`).forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll(`#${groupId} .pill`).forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      setter(pill.dataset.value);
      if (conditionalFn) conditionalFn(pill.dataset.value);
    });
  });
}

wireScenarioPills('campaignScenario', v => { selectedCampaignScenario = v; }, v => {
  document.querySelectorAll('.skipped-only').forEach(el =>
    el.style.display = (v === 'skipped') ? '' : 'none');
  // Toggle Campaign ID required/optional depending on scenario
  const reqMark = document.getElementById('c_campaignId_req');
  const optMark = document.getElementById('c_campaignId_opt');
  const isOptional = !['created', 'sms_failure'].includes(v);
  if (reqMark) reqMark.style.display = isOptional ? 'none' : '';
  if (optMark) optMark.style.display = isOptional ? '' : 'none';
  // Toggle Account ID required/optional depending on scenario
  const accReqMark = document.getElementById('c_accountId_req');
  const accOptMark = document.getElementById('c_accountId_opt');
  const accIsOptional = !['deleted', 'skipped', 'smart_sending'].includes(v);
  if (accReqMark) accReqMark.style.display = accIsOptional ? 'none' : '';
  if (accOptMark) accOptMark.style.display = accIsOptional ? '' : 'none';
});
wireScenarioPills('listScenario', v => { selectedListScenario = v; }, v => {
  // ── Which field groups are visible for each scenario ──────────────────────
  // profile_deleted : Account ID (req), Profile ID (opt)
  // suppression     : Account ID (req) + checklist controls Profile/List ID
  // optin_log       : List ID (req) only
  // segment_change  : Segment ID (req) only
  // list_merge      : Account ID (req), List ID (opt)

  const showAccount = !['optin_log', 'segment_change'].includes(v);
  const showProfile = ['profile_deleted', 'suppression'].includes(v);
  const showList    = ['optin_log', 'list_merge', 'suppression'].includes(v);
  const showSegment = v === 'segment_change';

  const accGroup  = document.getElementById('l_accountId_group');
  const profGroup = document.getElementById('l_profileId_group');
  const listGroup = document.getElementById('l_listId_group');
  const segGroup  = document.getElementById('l_segmentId_group');

  if (accGroup)  accGroup.style.display  = showAccount ? '' : 'none';
  if (profGroup) profGroup.style.display = showProfile ? '' : 'none';
  if (listGroup) listGroup.style.display = showList    ? '' : 'none';
  if (segGroup)  segGroup.style.display  = showSegment ? '' : 'none';

  // Suppression check panel
  const suppPanel = document.getElementById('suppressionChecks');
  if (suppPanel) suppPanel.style.display = v === 'suppression' ? '' : 'none';

  // Reset all label indicators first
  const accReq  = document.getElementById('l_accountId_req');
  const accOpt  = document.getElementById('l_accountId_opt');
  const profReq = document.getElementById('l_profileId_req');
  const profOpt = document.getElementById('l_profileId_opt');
  const listReq = document.getElementById('l_listId_req');
  const listOpt = document.getElementById('l_listId_opt');

  // Account ID: always required when shown
  if (accReq) accReq.style.display = '';
  if (accOpt) accOpt.style.display = 'none';

  // Profile ID: always optional when shown (suppression overrides via syncSuppressionFieldHints)
  if (profReq) profReq.style.display = 'none';
  if (profOpt) profOpt.style.display = '';

  // List ID: required for optin_log, optional for list_merge; suppression overrides dynamically
  if (v === 'optin_log') {
    if (listReq) listReq.style.display = '';
    if (listOpt) listOpt.style.display = 'none';
  } else if (v !== 'suppression') {
    if (listReq) listReq.style.display = 'none';
    if (listOpt) listOpt.style.display = '';
  }

  // Let suppression manage its own Profile/List ID indicators
  if (v === 'suppression') syncSuppressionFieldHints();
});
wireScenarioPills('billingScenario',  v => { selectedBillingScenario = v; });
wireScenarioPills('formScenario', v => {
  selectedFormScenario = v;
  syncFormFields(v);
});

function syncFormFields(scenario) {
  // published → Form ID only (required)
  // set_draft / deleted → Account ID (required) + Form ID (optional)
  const needsAccount  = (scenario !== 'published');
  const showFormId    = true; // always show Form ID field
  const formIdReq     = (scenario === 'published'); // required only for published

  const acctGrp = document.getElementById('fm_accountId_group');
  const fmGrp   = document.getElementById('fm_formId_group');
  const fmReq   = document.getElementById('fm_formId_req');
  const fmOpt   = document.getElementById('fm_formId_opt');

  if (acctGrp) acctGrp.style.display = needsAccount ? '' : 'none';
  if (fmGrp)   fmGrp.style.display   = ''; // always visible
  if (fmReq)   fmReq.style.display   = formIdReq  ? '' : 'none';
  if (fmOpt)   fmOpt.style.display   = !formIdReq ? '' : 'none';

  if (!needsAccount) {
    const inp = document.getElementById('fm_accountId');
    if (inp) { inp.value = ''; inp.classList.remove('error'); }
  }
}
wireScenarioPills('reviewScenario',   v => { selectedReviewScenario = v; });

// ─── SUPPRESSION CHECK LIST ──────────────────────────────────────────────────

// Sync required indicators for Profile ID and List ID based on selected checks
function syncSuppressionFieldHints() {
  const needsProfile = selectedSuppressionChecks.some(c => SUPP_NEEDS_PROFILE.includes(c));
  const needsList    = selectedSuppressionChecks.some(c => SUPP_NEEDS_LIST.includes(c));

  // Profile ID indicator
  const profReq = document.getElementById('l_profileId_req');
  const profOpt = document.getElementById('l_profileId_opt');
  if (profReq) profReq.style.display = needsProfile ? '' : 'none';
  if (profOpt) profOpt.style.display = needsProfile ? 'none' : '';

  // List ID field: show when list_growth is checked
  const listIdField = document.getElementById('l_listId_group');
  if (listIdField) listIdField.style.display = needsList ? '' : 'none';
  const listReq = document.getElementById('l_listId_req');
  const listOpt = document.getElementById('l_listId_opt');
  if (listReq) listReq.style.display = needsList ? '' : 'none';
  if (listOpt) listOpt.style.display = needsList ? 'none' : '';
}

// Update "Select all" / "Deselect all" button label
function updateSuppSelectAllBtn() {
  const btn = document.getElementById('suppSelectAll');
  if (!btn) return;
  const checks = document.querySelectorAll('.supp-check');
  const allChecked = [...checks].every(c => c.checked);
  btn.textContent = allChecked ? 'Deselect all' : 'Select all';
}

// Wire individual checkboxes
document.querySelectorAll('.supp-check').forEach(chk => {
  chk.addEventListener('change', () => {
    selectedSuppressionChecks = [...document.querySelectorAll('.supp-check:checked')].map(c => c.dataset.check);
    updateSuppSelectAllBtn();
    if (selectedListScenario === 'suppression') syncSuppressionFieldHints();
  });
});

// Wire Select all / Deselect all button
document.getElementById('suppSelectAll')?.addEventListener('click', () => {
  const checks = document.querySelectorAll('.supp-check');
  const allChecked = [...checks].every(c => c.checked);
  checks.forEach(c => { c.checked = !allChecked; });
  selectedSuppressionChecks = allChecked ? [] : [...checks].map(c => c.dataset.check);
  updateSuppSelectAllBtn();
  if (selectedListScenario === 'suppression') syncSuppressionFieldHints();
});

// ─── TIME RANGE PICKER ────────────────────────────────────────────────────────

// Log-scale helpers
function minutesToPos(m) {
  return Math.log(m / TIME_MIN) / Math.log(TIME_MAX / TIME_MIN) * 100;
}
function posToMinutes(pos) {
  return TIME_MIN * Math.pow(TIME_MAX / TIME_MIN, pos / 100);
}
function minutesToLabel(m) {
  if (m < 60)   return `${Math.round(m)} min`;
  if (m < 1440) { const h = Math.round(m / 60);    return `${h} hr`; }
  const d = Math.round(m / 1440);
  return `${d} day${d !== 1 ? 's' : ''}`;
}
function minutesToTimeStr(m) {
  if (m < 60)   return `${Math.round(m)}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

// Central setter — all three controls call this
function setTimeMinutes(minutes, source) {
  selectedTimeMinutes = Math.max(TIME_MIN, Math.min(TIME_MAX, Math.round(minutes)));
  selectedTimeRange   = minutesToTimeStr(selectedTimeMinutes);

  const pos = minutesToPos(selectedTimeMinutes);

  // Slider
  const slider = document.getElementById('timeSlider');
  if (slider && source !== 'slider') {
    slider.value = pos;
  }
  if (slider) slider.style.setProperty('--fill', `${pos}%`);

  // Label
  const lbl = document.getElementById('timeSliderLabel');
  if (lbl) lbl.textContent = minutesToLabel(selectedTimeMinutes);

  // Quick picks — highlight exact matches
  document.querySelectorAll('.time-quick').forEach(btn => {
    btn.classList.toggle('active', Math.abs(selectedTimeMinutes - parseInt(btn.dataset.minutes)) < 1);
  });

  // Manual input — only update if not currently typing there
  if (source !== 'manual') {
    const inp = document.getElementById('timeManualValue');
    let unit = 'd', val = Math.round(selectedTimeMinutes / 1440);
    if (selectedTimeMinutes < 60) {
      unit = 'm'; val = selectedTimeMinutes;
    } else if (selectedTimeMinutes < 1440 || selectedTimeMinutes % 1440 !== 0) {
      unit = 'h'; val = Math.round(selectedTimeMinutes / 60);
    }
    if (inp) inp.value = val;
    document.querySelectorAll('.time-unit-pill').forEach(p =>
      p.classList.toggle('active', p.dataset.unit === unit));
  }
}

// Wire slider
document.getElementById('timeSlider')?.addEventListener('input', (e) => {
  setTimeMinutes(posToMinutes(parseFloat(e.target.value)), 'slider');
});

// Wire quick picks
document.querySelectorAll('.time-quick').forEach(btn => {
  btn.addEventListener('click', () => setTimeMinutes(parseInt(btn.dataset.minutes), 'quick'));
});

// Wire unit pills
document.querySelectorAll('.time-unit-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.time-unit-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    const val = parseInt(document.getElementById('timeManualValue')?.value || '1');
    setTimeMinutes(val * parseInt(pill.dataset.mult), 'unit');
  });
});

// Wire manual number input
document.getElementById('timeManualValue')?.addEventListener('input', (e) => {
  const val = parseInt(e.target.value);
  if (!val || val < 1) return;
  const activePill = document.querySelector('.time-unit-pill.active');
  const mult = activePill ? parseInt(activePill.dataset.mult) : 1440;
  setTimeMinutes(val * mult, 'manual');
});

// ─── TIME MODE TABS (Relative / Date range) ───────────────────────────────────
function buildDateRangeTimeStr() {
  const from = document.getElementById('timeDateFrom')?.value;
  const to   = document.getElementById('timeDateTo')?.value;
  if (from && to) return `daterange:${from}:${to}`;
  if (from)       return `daterange:${from}:${from}`;
  return null;
}

function applyTimeMode(mode) {
  selectedTimeMode = mode;

  document.querySelectorAll('.time-mode-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.mode === mode));

  const relEl  = document.getElementById('timeRelativeControls');
  const dateEl = document.getElementById('timeDateControls');

  if (mode === 'date') {
    if (relEl)  relEl.style.display  = 'none';
    if (dateEl) dateEl.style.display = '';
    // Default From to today and To to today if nothing selected yet
    const today = new Date().toISOString().slice(0, 10);
    const fromInp = document.getElementById('timeDateFrom');
    const toInp   = document.getElementById('timeDateTo');
    if (fromInp && !fromInp.value) fromInp.value = today;
    if (toInp   && !toInp.value)   toInp.value   = today;
    const tr = buildDateRangeTimeStr();
    if (tr) selectedTimeRange = tr;
  } else {
    if (relEl)  relEl.style.display  = '';
    if (dateEl) dateEl.style.display = 'none';
    selectedTimeRange = minutesToTimeStr(selectedTimeMinutes);
  }
}

document.querySelectorAll('.time-mode-tab').forEach(tab => {
  tab.addEventListener('click', () => applyTimeMode(tab.dataset.mode));
});

// Wire From/To date inputs
document.getElementById('timeDateFrom')?.addEventListener('input', () => {
  const tr = buildDateRangeTimeStr();
  if (tr) selectedTimeRange = tr;
});
document.getElementById('timeDateTo')?.addEventListener('input', () => {
  const tr = buildDateRangeTimeStr();
  if (tr) selectedTimeRange = tr;
});

// Wire quick preset buttons
document.querySelectorAll('.time-date-preset').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.time-date-preset').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const days = parseInt(btn.dataset.days);
    const today = new Date();
    const toDate = today.toISOString().slice(0, 10);
    const fromDate = days === 0
      ? toDate
      : new Date(today - days * 86400000).toISOString().slice(0, 10);
    const fromInp = document.getElementById('timeDateFrom');
    const toInp   = document.getElementById('timeDateTo');
    if (fromInp) fromInp.value = fromDate;
    if (toInp)   toInp.value   = toDate;
    const tr = buildDateRangeTimeStr();
    if (tr) selectedTimeRange = tr;
  });
});

// ─── BACK BUTTON ─────────────────────────────────────────────────────────────
document.getElementById('backBtn').addEventListener('click', () => {
  document.getElementById('resultsSection').style.display = 'none';
  document.getElementById('formSection').style.display = '';
  document.getElementById('diagnoseBtn').disabled = false;
});

// ─── DIAGNOSE ────────────────────────────────────────────────────────────────
document.getElementById('diagnoseBtn').addEventListener('click', () => {
  // Hard re-sync: if in date mode, always read the current input values so we never
  // send a stale relative range even if the 'input' event was somehow missed.
  if (selectedTimeMode === 'date') {
    const tr = buildDateRangeTimeStr();
    if (tr) selectedTimeRange = tr;
  }

  const fields = collectFields();
  if (!fields) return;

  document.getElementById('formSection').style.display = 'none';
  document.getElementById('resultsSection').style.display = '';
  document.getElementById('stepsList').innerHTML = '';
  document.getElementById('resultsSummary').textContent = '';
  const vEl = document.getElementById('finalVerdict');
  if (vEl) { vEl.style.display = 'none'; vEl.innerHTML = ''; vEl.className = 'final-verdict'; }
  stepElements = [];

  const stepDefs = getStepDefs();
  stepDefs.forEach((def, i) => {
    const card = buildStepCard(i + 1, def.label, def.description, def.tool, i);
    document.getElementById('stepsList').appendChild(card.el);
    stepElements.push(card);
  });

  document.getElementById('diagnoseBtn').disabled = true;

  // If the port was killed by Chrome's MV3 idle timeout, reconnect now before
  // sending — otherwise the postMessage is silently dropped and nothing runs.
  if (!port) connectPort();

  if (!port) {
    // Still null after reconnect attempt — show a visible error rather than
    // leaving the user staring at spinning hourglasses indefinitely.
    document.getElementById('diagnoseBtn').disabled = false;
    const summary = document.getElementById('resultsSummary');
    summary.textContent = 'Connection error — please try again';
    summary.style.color = 'var(--red)';
    return;
  }

  port.postMessage({
    type: 'DIAGNOSE',
    area: selectedArea,
    flowType: selectedTrigger,
    campaignScenario: selectedCampaignScenario,
    listScenario: selectedListScenario,
    billingScenario: selectedBillingScenario,
    formScenario: selectedFormScenario,
    reviewScenario: selectedReviewScenario,
    suppressionChecks: selectedSuppressionChecks,
    fields,
    timeRange: selectedTimeRange
  });
});

// ─── COLLECT FIELDS ───────────────────────────────────────────────────────────
function collectFields() {
  const inputs = document.querySelectorAll('.field-input');
  inputs.forEach(i => i.classList.remove('error'));

  function get(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }
  function require(id) {
    const val = get(id);
    if (!val) { document.getElementById(id)?.classList.add('error'); return null; }
    return val;
  }

  if (selectedArea === 'flows') {
    const accountId = require('f_accountId');
    const flowId    = require('f_flowId');
    // Profile ID: required for list/segment trigger, optional for metric (only used in Step 3)
    const profileId     = selectedTrigger === 'list_segment' ? require('f_profileId') : get('f_profileId');
    // Activity ID: optional for metric (strongly recommended but not required)
    const activityId    = get('f_activityId');
    const listSegId     = selectedTrigger === 'list_segment' ? require('f_listSegId') : get('f_listSegId');
    const flowMessageId = get('f_flowMessageId'); // optional — used for Step 3 per-message filter
    if (!accountId || !flowId) return null;
    if (selectedTrigger === 'list_segment' && (!listSegId || !profileId)) return null;
    return { accountId, flowId, profileId, activityId, listSegId, flowMessageId };
  }

  if (selectedArea === 'campaigns') {
    // Which field each scenario actually uses in its query/link
    const ACCOUNT_ID_REQUIRED  = ['deleted', 'skipped', 'smart_sending'];
    const CAMPAIGN_ID_REQUIRED = ['created', 'sms_failure'];
    const accountId  = ACCOUNT_ID_REQUIRED.includes(selectedCampaignScenario)
      ? require('c_accountId') : get('c_accountId');
    const campaignId = CAMPAIGN_ID_REQUIRED.includes(selectedCampaignScenario)
      ? require('c_campaignId') : get('c_campaignId');
    if (ACCOUNT_ID_REQUIRED.includes(selectedCampaignScenario)  && !accountId)  return null;
    if (CAMPAIGN_ID_REQUIRED.includes(selectedCampaignScenario) && !campaignId) return null;
    return { accountId, campaignId, profileId: get('c_profileId') };
  }

  if (selectedArea === 'lists_profiles') {
    // optin_log: only List ID required
    if (selectedListScenario === 'optin_log') {
      const listId = require('l_listId');
      if (!listId) return null;
      return { accountId: get('l_accountId'), profileId: get('l_profileId'), listId };
    }

    // segment_change: only Segment ID required
    if (selectedListScenario === 'segment_change') {
      const segmentId = require('l_segmentId');
      if (!segmentId) return null;
      return { segmentId };
    }

    const accountId = require('l_accountId');
    if (!accountId) return null;

    if (selectedListScenario === 'suppression') {
      if (selectedSuppressionChecks.length === 0) return null;
      const needsProfile = selectedSuppressionChecks.some(c => SUPP_NEEDS_PROFILE.includes(c));
      const needsList    = selectedSuppressionChecks.some(c => SUPP_NEEDS_LIST.includes(c));
      const profileId = needsProfile ? require('l_profileId') : get('l_profileId');
      const listId    = needsList    ? require('l_listId')    : get('l_listId');
      if (needsProfile && !profileId) return null;
      if (needsList    && !listId)    return null;
      return { accountId, profileId, listId, suppressionChecks: selectedSuppressionChecks };
    }

    return { accountId, profileId: get('l_profileId'), listId: get('l_listId') };
  }

  if (selectedArea === 'billing') {
    const accountId = require('b_accountId');
    if (!accountId) return null;
    return { accountId };
  }

  if (selectedArea === 'forms') {
    if (selectedFormScenario === 'published') {
      // Published/unpublished: search by form ID only (required)
      const formId = require('fm_formId');
      if (!formId) return null;
      return { accountId: null, formId };
    }
    // set_draft / deleted: account ID required, form ID optional (narrows results)
    const accountId = require('fm_accountId');
    if (!accountId) return null;
    const formIdVal = document.getElementById('fm_formId')?.value.trim() || null;
    return { accountId, formId: formIdVal };
  }

  if (selectedArea === 'push') {
    const profileId = require('p_profileId');
    if (!profileId) return null;
    return { profileId };
  }

  if (selectedArea === 'reviews') {
    const accountId = require('r_accountId');
    if (!accountId) return null;
    return { accountId };
  }

  if (selectedArea === 'integrations') {
    const accountId = require('i_accountId');
    if (!accountId) return null;
    return { accountId };
  }

  return {};
}

// ─── STEP DEFINITIONS (mirrors background.js, for display only) ──────────────
function getStepDefs() {
  if (selectedArea === 'flows') {
    if (selectedTrigger === 'metric') return [
      { label: 'Trigger filter check',      description: 'Did profile pass the trigger filter at event time?',       tool: 'chronosphere' },
      { label: 'Flow filter check',         description: 'Did profile pass the flow profile filter?',                tool: 'chronosphere' },
      { label: 'Additional message filter', description: 'Did profile pass per-message additional filters? (requires Flow Message ID)',  tool: 'chronosphere' },
    ];
    if (selectedTrigger === 'list_segment') return [
      { label: 'List trigger path check', description: 'Was profile added via a path that skips flows?',    tool: 'splunk' },
      { label: 'Group trigger received',  description: 'Did Groups/Segments send the trigger to Flows?',    tool: 'chronosphere' },
      { label: 'Pipeline started',        description: 'Did the Flows pipeline pick up and start?',          tool: 'chronosphere' },
      { label: 'Trigger filter check',    description: 'Did profile pass the trigger filter?',               tool: 'chronosphere' },
      { label: 'Flow filter check',       description: 'Did profile pass the flow profile filter?',          tool: 'chronosphere' },
    ];
    if (selectedTrigger === 'date') return [
      { label: 'Nightly queue eligibility', description: 'Was profile in the nightly date-based queue?', tool: 'chronosphere' },
      { label: 'Date range check',          description: 'Was next date within range of tomorrow?',       tool: 'chronosphere' },
      { label: 'Trigger / flow filter',     description: 'Did profile pass the date trigger filter?',     tool: 'chronosphere' },
    ];
  }
  if (selectedArea === 'campaigns') return [
    { label: 'Campaign log check', description: campaignScenarioLabel(), tool: 'splunk' }
  ];
  if (selectedArea === 'lists_profiles') {
    if (selectedListScenario === 'suppression') {
      const checkNames = {
        account_level:  'Account-level suppression',
        profile_manual: 'Profile manual suppression',
        who_suppressed: 'Who suppressed? (post Oct 2025)',
        bulk:           'Bulk suppression',
        existing_90day: '90-day suppression window',
        list_growth:    'List growth — suppressed profiles'
      };
      return selectedSuppressionChecks.map(c => ({
        label: checkNames[c] || c,
        description: 'Splunk suppression log check',
        tool: 'splunk'
      }));
    }
    return [{ label: 'Profile / List log check', description: listScenarioLabel(), tool: 'splunk' }];
  }
  if (selectedArea === 'billing') {
    if (selectedBillingScenario === 'back_in_stock') return [
      { label: 'Back in Stock setting check', description: 'Check Back in Stock min inventory setting changes', tool: 'splunk' }
    ];
    // auto_upgrade — 2 steps (mirrors qw_auto_upgrade_logs + billing_plan_changes dashboards)
    return [
      { label: 'Auto-upgrade events',  description: 'Trigger signals, payment outcome, and flex overage charges', tool: 'splunk' },
      { label: 'Billing plan changes', description: 'BILLING_PLAN_CHANGE_SERVICE logs — what plan was set and how', tool: 'splunk' },
    ];
  }
  if (selectedArea === 'forms') return [
    { label: 'Form log check', description: formScenarioLabel(), tool: 'splunk' }
  ];
  if (selectedArea === 'push') return [
    { label: 'Push consent change check', description: 'Check push consent change log for this profile', tool: 'splunk' }
  ];
  if (selectedArea === 'reviews') return [
    { label: 'Reviews log check', description: reviewScenarioLabel(), tool: 'splunk' }
  ];
  if (selectedArea === 'integrations') return [
    { label: 'Integration log check', description: 'Check integration-related logs in Splunk', tool: 'splunk' }
  ];
  return [];
}

function campaignScenarioLabel() {
  const m = { created: 'Who created this campaign?', deleted: 'Who deleted this campaign?',
    skipped: 'Why was this campaign skipped?', smart_sending: 'Was Smart Sending enabled?',
    sms_failure: 'What caused the SMS send failure?' };
  return m[selectedCampaignScenario] || '';
}
function listScenarioLabel() {
  const m = { profile_deleted: 'Check if profile was deleted and when', suppression: 'Check profile suppression log',
    optin_log: 'Check list opt-in setting changes', segment_change: 'Check segment definition change log',
    list_merge: 'Check list merging log' };
  return m[selectedListScenario] || '';
}
function billingScenarioLabel() {
  const m = { auto_upgrade: 'Check auto-upgrade events', back_in_stock: 'Check Back in Stock min inventory setting changes' };
  return m[selectedBillingScenario] || '';
}
function formScenarioLabel() {
  const m = { set_draft: 'When was this form set to draft?', deleted: 'Who deleted this form?', published: 'When was this form published/unpublished?' };
  return m[selectedFormScenario] || '';
}
function reviewScenarioLabel() {
  const m = { not_triggering: 'Ready to Review not triggering due to billing limits', exported: 'Check who exported reviews', settings_change: 'Check settings changes' };
  return m[selectedReviewScenario] || '';
}

// ─── BUILD STEP CARD ──────────────────────────────────────────────────────────
function buildStepCard(num, label, description, tool, idx) {
  const toolInfo = TOOL_LABELS[tool] || TOOL_LABELS.chronosphere;
  const el = document.createElement('div');
  el.className = 'step-card';
  el.innerHTML = `
    <div class="step-header">
      <div class="step-number">${num}</div>
      <div class="step-info">
        <div class="step-label">${label}</div>
        <div class="step-meta">${description}</div>
      </div>
      <div class="step-tool-badge" style="background:${toolInfo.color}20;color:${toolInfo.color}">${toolInfo.text}</div>
      <div class="step-status"><button class="step-run-btn step-pending-btn" title="Run from here">⏳</button></div>
    </div>
    <div class="step-body"></div>
  `;
  el.querySelector('.step-header').addEventListener('click', () =>
    el.querySelector('.step-body').classList.toggle('open'));
  el.querySelector('.step-pending-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    handleContinueFrom(idx);
  });
  return { el, body: el.querySelector('.step-body'), num };
}

// ─── HANDLE BACKGROUND MESSAGES ───────────────────────────────────────────────
function handleBackgroundMessage(msg) {
  if (msg.type === 'STEP_START') {
    const card = stepElements[msg.stepIndex];
    if (card) {
      currentRunningStepIndex = msg.stepIndex;
      card.el.classList.remove('pass','fail','warn');
      card.el.classList.add('running');
      const statusEl = card.el.querySelector('.step-status');
      statusEl.innerHTML = '<button class="step-stop-btn" title="Stop run"><div class="step-spinner"></div></button>';
      statusEl.querySelector('.step-stop-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        handleCancel();
      });
    }
  }

  if (msg.type === 'STEP_RESULT') {
    const card = stepElements[msg.stepIndex];
    if (!card) return;
    card.el.classList.remove('running','pass','fail','warn');
    card.el.classList.add(msg.status);
    card.el.querySelector('.step-status').innerHTML =
      msg.status === 'pass' ? '✅' : msg.status === 'fail' ? '❌' : '⚠️';

    let html = `<div class="step-verdict">${msg.verdict}</div>`;
    if (msg.count) html += `<div class="step-count">Found: ${msg.count}</div>`;
    if (msg.jiraTeam) {
      html += `<div class="jira-hint">🎫 Create Jira for <strong>${msg.jiraTeam}</strong>: ${msg.jiraNote}</div>`;
    }
    if (msg.queryUrl) {
      const toolName = msg.queryUrl.includes('chronosphere') ? 'Chronosphere' : 'Splunk';
      html += `<a class="step-action" href="${msg.queryUrl}" target="_blank">🔍 View in ${toolName}</a>`;
    }
    if (msg.splunkDashboardUrl) {
      html += `<a class="step-action" href="${msg.splunkDashboardUrl}" target="_blank" style="margin-top:4px">📊 Open Splunk Dashboard</a>`;
    }
    if (msg.summaries?.length) {
      html += `<div class="step-raw">
        <button class="step-raw-toggle">Show raw logs (${msg.summaries.length})</button>
        <div class="step-raw-content">${escHtml(msg.summaries.join('\n\n---\n\n'))}</div>
      </div>`;
    }
    card.body.innerHTML = html;
    card.body.classList.add('open');

    const tog = card.body.querySelector('.step-raw-toggle');
    const raw = card.body.querySelector('.step-raw-content');
    tog?.addEventListener('click', () => {
      raw.classList.toggle('open');
      tog.textContent = raw.classList.contains('open')
        ? 'Hide raw logs' : `Show raw logs (${msg.summaries.length})`;
    });
  }

  if (msg.type === 'STEP_ERROR') {
    const card = stepElements[msg.stepIndex];
    if (!card) return;
    card.el.classList.remove('running'); card.el.classList.add('warn');
    card.el.querySelector('.step-status').innerHTML = '⚠️';
    card.body.innerHTML = `<div class="step-verdict">Error: ${escHtml(msg.error)}</div>`;
    card.body.classList.add('open');
  }

  if (msg.type === 'DONE') {
    currentRunningStepIndex = -1;
    document.getElementById('diagnoseBtn').disabled = false;
    const passes = stepElements.filter(c => c.el.classList.contains('pass')).length;
    const fails  = stepElements.filter(c => c.el.classList.contains('fail')).length;
    const summary = document.getElementById('resultsSummary');
    if (fails > 0) {
      summary.textContent = `${fails} issue${fails > 1 ? 's' : ''} found`;
      summary.style.color = 'var(--red)';
    } else if (passes === stepElements.length) {
      summary.textContent = selectedArea === 'flows' ? 'All checks passed' : 'Logs found';
      summary.style.color = 'var(--green)';
    } else {
      summary.textContent = `${passes}/${stepElements.length} complete`;
      summary.style.color = 'var(--text-secondary)';
    }

    // Final verdict box
    if (msg.finalVerdict) {
      const verdictEl = document.getElementById('finalVerdict');
      verdictEl.className = 'final-verdict';
      if (msg.finalStatus === 'pass')      verdictEl.classList.add('verdict-pass');
      else if (msg.finalStatus === 'fail') verdictEl.classList.add('verdict-fail');
      else                                 verdictEl.classList.add('verdict-warn');
      verdictEl.innerHTML = msg.finalVerdict;
      verdictEl.style.display = '';
      verdictEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // If stopped early, make pending steps into clickable ▶ run buttons
    if (msg.canContinue && msg.nextStep != null) {
      stepElements.forEach((card, idx) => {
        if (idx >= msg.nextStep) makeStepRunnable(card, idx);
      });
    }
  }
}

// ─── MAKE STEP RUNNABLE (shared by canContinue and cancel) ───────────────────
function makeStepRunnable(card, idx) {
  card.el.classList.remove('running', 'pass', 'fail', 'warn');
  const statusEl = card.el.querySelector('.step-status');
  statusEl.innerHTML = '<button class="step-run-btn" title="Run from here">▶</button>';
  statusEl.querySelector('.step-run-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    handleContinueFrom(idx);
  });
}

// ─── CANCEL RUNNING CALL ──────────────────────────────────────────────────────
function handleCancel() {
  if (port) port.postMessage({ type: 'CANCEL' });
  currentRunningStepIndex = -1;
  document.getElementById('diagnoseBtn').disabled = false;

  // Reset running step and any still-pending steps to runnable ▶
  stepElements.forEach((card, idx) => {
    if (card.el.classList.contains('running')) {
      card.body.innerHTML = '';
      card.body.classList.remove('open');
      makeStepRunnable(card, idx);
    }
  });

  const summary = document.getElementById('resultsSummary');
  summary.textContent = 'Stopped';
  summary.style.color = 'var(--text-secondary)';
}

// ─── CONTINUE FROM STEP ───────────────────────────────────────────────────────
function handleContinueFrom(fromIndex) {
  // Reset all steps from fromIndex onwards back to runnable buttons
  stepElements.forEach((card, idx) => {
    if (idx >= fromIndex) {
      makeStepRunnable(card, idx);
      card.body.innerHTML = '';
      card.body.classList.remove('open');
    }
  });

  // Hide the current verdict while re-running
  const vEl = document.getElementById('finalVerdict');
  if (vEl) { vEl.style.display = 'none'; }

  document.getElementById('resultsSummary').textContent = '';
  document.getElementById('diagnoseBtn').disabled = true;

  if (!port) connectPort();
  if (port) {
    port.postMessage({ type: 'CONTINUE_FROM', fromIndex });
  } else {
    document.getElementById('diagnoseBtn').disabled = false;
    const summary = document.getElementById('resultsSummary');
    summary.textContent = 'Connection error — please try again';
    summary.style.color = 'var(--red)';
  }
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── FEEDBACK ENDPOINT ────────────────────────────────────────────────────────
// Paste your deployed Apps Script web app URL here after running setup.
// See feedback-script.gs for setup instructions.
const FEEDBACK_SCRIPT_URL = 'https://script.google.com/a/macros/klaviyo.com/s/AKfycbxwUePuNfGvsqWmlaY-lXoYWGKJgBy5R5B6XBMznPFIQdIjyhQJz2WVyqtb4B0lH1ebsQ/exec';

// ─── PAGE NAVIGATION ──────────────────────────────────────────────────────────
(function() {
  const navBtns = document.querySelectorAll('.nav-btn');
  const pages   = document.querySelectorAll('.page');

  function showPage(pageId) {
    pages.forEach(p => p.classList.toggle('active', p.id === pageId));
    navBtns.forEach(b => b.classList.toggle('active', b.dataset.page === pageId));
  }

  // Side nav buttons
  navBtns.forEach(btn => {
    btn.addEventListener('click', () => showPage(btn.dataset.page));
  });

  // IKB notice link → articles page
  document.getElementById('ikbLink')?.addEventListener('click', e => {
    e.preventDefault();
    showPage('pageArticles');
  });

  // Back buttons (data-back="pageId")
  document.querySelectorAll('.page-back-btn').forEach(btn => {
    btn.addEventListener('click', () => showPage(btn.dataset.back || 'pageDiagnose'));
  });

  // ─── SETTINGS: THEME PICKER ─────────────────────────────────────────────────
  function syncSettingsTheme() {
    const current = document.body.getAttribute('data-theme') || 'dark';
    document.querySelectorAll('.theme-option').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.themeValue === current);
    });
  }
  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.themeValue;
      document.body.setAttribute('data-theme', t);
      localStorage.setItem('kdbg-theme', t);
      applyThemeIcons(t);
      syncSettingsTheme();
    });
  });
  syncSettingsTheme();

  // ─── REPORT FORM ────────────────────────────────────────────────────────────
  const reportTypeBtns = document.querySelectorAll('.report-type-btn');
  reportTypeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      reportTypeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  document.getElementById('reportSubmit')?.addEventListener('click', async () => {
    const type    = document.querySelector('.report-type-btn.active')?.textContent?.trim() || 'Feedback';
    const subject = document.getElementById('reportSubject')?.value?.trim() || '';
    const body    = document.getElementById('reportBody')?.value?.trim() || '';
    const submitBtn   = document.getElementById('reportSubmit');
    const successEl   = document.getElementById('reportSuccess');

    if (!body) {
      const ta = document.getElementById('reportBody');
      if (ta) { ta.style.borderColor = 'var(--red)'; ta.focus(); setTimeout(() => { ta.style.borderColor = ''; }, 1500); }
      return;
    }

    if (!FEEDBACK_SCRIPT_URL) {
      // Script not yet deployed — open the sheet directly as fallback
      chrome.tabs.create({ url: 'https://docs.google.com/spreadsheets/d/1XMIZnx_cbPi5IlnA4-tm1LTGeQyV3vnovCo2gSmUrTA/edit' });
      if (successEl) {
        successEl.innerHTML = '⚠️ <strong>Script not configured yet.</strong><br>Opened the feedback sheet — please paste your report manually until <code>FEEDBACK_SCRIPT_URL</code> is set.';
        successEl.style.display = 'block';
        setTimeout(() => { successEl.style.display = 'none'; }, 5000);
      }
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    try {
      const res = await fetch(FEEDBACK_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          subject,
          area: selectedArea || '',
          description: body,
          reporter: 'sakariye.ali@klaviyo.com'
        })
      });
      const json = await res.json();
      if (json.success) {
        if (successEl) {
          successEl.innerHTML = '✅ <strong>Feedback submitted!</strong><br>It\'s been logged to the Klaviyo Debugger Feedback sheet.';
          successEl.style.display = 'block';
          setTimeout(() => { successEl.style.display = 'none'; }, 4000);
        }
        document.getElementById('reportBody').value = '';
        document.getElementById('reportSubject').value = '';
      } else {
        throw new Error(json.error || 'Unknown error');
      }
    } catch (err) {
      if (successEl) {
        successEl.innerHTML = `❌ <strong>Submission failed:</strong> ${err.message}<br>Check that the script URL is correct and deployed as a web app.`;
        successEl.style.display = 'block';
        setTimeout(() => { successEl.style.display = 'none'; }, 6000);
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send Feedback';
    }
  });
})();
