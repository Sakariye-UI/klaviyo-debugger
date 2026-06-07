// ─── URLS ─────────────────────────────────────────────────────────────────────
const CHRONO_BASE  = 'https://klaviyo.chronosphere.io/logs/explorer';
const SPLUNK_BASE  = 'https://klaviyo.splunkcloud.com/en-GB/app/search/search';
const SPLUNK_LIST_TRIGGER_DASHBOARD =
  'https://klaviyo.splunkcloud.com/en-GB/app/search/dashboards'; // update with real dashboard URL
const SPLUNK_AUTO_UPGRADE_DASHBOARD_BASE  = 'https://klaviyo.splunkcloud.com/en-US/app/search/qw_auto_upgrade_logs?form.token=';
const SPLUNK_BILLING_PLAN_CHANGES_BASE    = 'https://klaviyo.splunkcloud.com/en-US/app/search/billing_plan_changes?form.company_id=';
const SPLUNK_AU_DASH_PARAMS               = '&form.time_tok.earliest=%40mon&form.time_tok.latest=now&form.host=*&form.row_count=50';
const SPLUNK_PC_DASH_PARAMS               = '&form.time_tok.earliest=%40mon&form.time_tok.latest=now&form.product_type=*&form.mrr_as_zero=all';

// ─── PORT ─────────────────────────────────────────────────────────────────────
let panelPort = null;
let savedDiagState = null; // saved when stopEarly; allows CONTINUE_FROM to resume
let currentRunId = 0;      // incremented on each new DIAGNOSE; stale runs check this before sending

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'flow-debugger') {
    panelPort = port;
    port.onMessage.addListener(handlePanelMessage);
    port.onDisconnect.addListener(() => { panelPort = null; });
  }
});

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────
async function handlePanelMessage(msg) {
  if (msg.type === 'CANCEL') {
    currentRunId++; // invalidates any in-flight run instantly
    return;
  }

  if (msg.type === 'DIAGNOSE') {
    savedDiagState = null;
    const myRunId = ++currentRunId;
    try {
      await runDiagnostic(msg, myRunId);
    } catch (err) {
      if (myRunId !== currentRunId) return;
      sendToPanel({ type: 'STEP_ERROR', stepIndex: 0, error: err.message });
      sendToPanel({ type: 'DONE' });
    }
    return;
  }

  if (msg.type === 'CONTINUE_FROM') {
    if (!savedDiagState) return;
    const myRunId = currentRunId;
    try {
      await resumeFromStep(msg.fromIndex, myRunId);
    } catch (err) {
      if (myRunId !== currentRunId) return;
      sendToPanel({ type: 'STEP_ERROR', stepIndex: msg.fromIndex, error: err.message });
      const { finalStatus, finalVerdict } = computeFinalVerdict(savedDiagState?.stepOutcomes || [], savedDiagState?.area);
      sendToPanel({ type: 'DONE', finalStatus, finalVerdict });
    }
    return;
  }
}

async function runDiagnostic(msg, runId) {
  const { area, flowType, fields, timeRange } = msg;
  let steps;
  const stepOutcomes = []; // track {status, label} for final verdict

  switch (area) {
    case 'flows':         steps = buildFlowSteps(flowType, fields, msg); break;
    case 'campaigns':     steps = buildCampaignSteps(msg.campaignScenario, fields, timeRange); break;
    case 'lists_profiles':steps = buildListProfileSteps(msg.listScenario, fields, timeRange); break;
    case 'billing':       steps = buildBillingSteps(msg.billingScenario, fields, timeRange); break;
    case 'forms':         steps = buildFormSteps(msg.formScenario, fields, timeRange); break;
    case 'push':          steps = buildPushSteps(fields, timeRange); break;
    case 'reviews':       steps = buildReviewSteps(msg.reviewScenario, fields, timeRange); break;
    case 'integrations':  steps = buildIntegrationSteps(fields, timeRange); break;
    default:              steps = [];
  }

  for (let i = 0; i < steps.length; i++) {
    if (runId !== currentRunId) return; // cancelled by a newer run
    const step = steps[i];
    sendToPanel({ type: 'STEP_START', stepIndex: i });

    try {
      // Manual/dashboard steps (no auto-execution)
      if (step.manual) {
        if (runId !== currentRunId) return;
        sendToPanel({
          type: 'STEP_RESULT',
          stepIndex: i,
          status: 'warn',
          verdict: step.manualNote,
          queryUrl: null,
          splunkDashboardUrl: step.dashboardUrl || null,
          count: null,
          summaries: []
        });
        continue;
      }

      const isSplunk = step.tool === 'splunk';
      const tabId    = isSplunk
        ? await findOrCreateSplunkTab()
        : await findOrCreateChronosphereTab();

      if (runId !== currentRunId) return;

      const queryUrl = isSplunk
        ? buildSplunkUrl(step.query, timeRange)
        : buildChronoUrl(step.query, timeRange);

      await navigateAndWait(tabId, queryUrl);
      if (runId !== currentRunId) return;

      const results = isSplunk
        ? await readSplunkResults(tabId)
        : await readChronosphereResults(tabId);

      if (runId !== currentRunId) return;

      // ── Timeout guard ─────────────────────────────────────────────────────
      // results.timeout means the page loaded but results never rendered.
      // This is NOT the same as "no logs" — treat it as unknown and tell
      // the agent to check manually rather than showing a false negative.
      if (results.timeout) {
        const toolName = isSplunk ? 'Splunk' : 'Chronosphere';
        sendToPanel({
          type: 'STEP_RESULT',
          stepIndex: i,
          status: 'warn',
          verdict: `<strong>⏱ ${toolName} timed out before results loaded</strong><br>
            <br>This does <em>not</em> mean the log doesn't exist — ${toolName} was just slow to render.<br>
            <br><strong>What to do:</strong>
            <ul>
              <li>Click <strong>"View in ${toolName}"</strong> below to open the query directly</li>
              <li>Wait for the page to fully load</li>
              <li>If results appear → the log exists (check <code>is_qualified</code> for pass/fail)</li>
              <li>If you see "0 Logs" or "No results found" → the log genuinely doesn't exist</li>
            </ul>`,
          count: '?',
          summaries: [],
          queryUrl
        });
        // Don't stop early on a timeout — continue checking remaining steps
        continue;
      }

      const verdict = step.interpret(results);
      stepOutcomes.push({ status: verdict.status, label: step.label || `Step ${i + 1}`, stopEarly: verdict.stopEarly });

      sendToPanel({
        type: 'STEP_RESULT',
        stepIndex: i,
        status: verdict.status,
        verdict: verdict.message,
        count: results.count,
        summaries: results.summaries,
        queryUrl,
        jiraTeam: verdict.jiraTeam || null,
        jiraNote: verdict.jiraNote || null
      });

      if (verdict.stopEarly) {
        if (runId !== currentRunId) return;
        // Save state so the agent can continue if they want
        savedDiagState = { steps, timeRange: msg.timeRange, area, stepOutcomes };
        const { finalStatus, finalVerdict } = computeFinalVerdict(stepOutcomes, area);
        sendToPanel({ type: 'DONE', finalStatus, finalVerdict, canContinue: true, nextStep: i + 1 });
        return;
      }

    } catch (err) {
      if (runId !== currentRunId) return;
      sendToPanel({ type: 'STEP_ERROR', stepIndex: i, error: err.message });
    }
  }

  if (runId !== currentRunId) return;
  savedDiagState = { steps, timeRange: msg.timeRange, area, stepOutcomes };
  const { finalStatus, finalVerdict } = computeFinalVerdict(stepOutcomes, area);
  sendToPanel({ type: 'DONE', finalStatus, finalVerdict });
}

// ── Extract final verdict so both runDiagnostic and resumeFromStep can use it ─
function computeFinalVerdict(stepOutcomes, area) {
  const blockedStep   = stepOutcomes.find(o => o.status === 'fail');
  const uncertainStep = stepOutcomes.find(o => o.status === 'warn' && o.stopEarly !== true);
  const allPass = stepOutcomes.length > 0 && stepOutcomes.every(o => o.status === 'pass');

  // Flow-specific messages
  if (area === 'flows') {
    if (blockedStep) return {
      finalStatus: 'fail',
      finalVerdict: `❌ <strong>Profile did NOT enter the flow</strong> — blocked at <strong>${blockedStep.label}</strong>.<br>See that step above for details and next steps.`
    };
    if (allPass) return {
      finalStatus: 'pass',
      finalVerdict: `✅ <strong>Profile entered the flow</strong> — all checks passed.<br>If they still didn't receive a message, check suppression status, Smart Sending, and conditional splits.`
    };
    if (uncertainStep) return {
      finalStatus: 'warn',
      finalVerdict: `⚠️ <strong>Diagnosis incomplete</strong> — one or more steps could not confirm pass/fail.<br>Click "View in Chronosphere" on the flagged step(s) and check <code>is_qualified</code> manually.`
    };
    return {
      finalStatus: 'warn',
      finalVerdict: `⚠️ <strong>No blocking filter found</strong> — the profile appears to have passed all evaluated filters.<br>If they still didn't receive a message, check: suppression/unsubscribe status, Smart Sending window, conditional splits routing to "Do nothing", and flow grace period.`
    };
  }

  // Area-specific pass messages
  const passLabel = 'Logs found — see details above.';

  if (blockedStep) return {
    finalStatus: 'fail',
    finalVerdict: `❌ <strong>Issue found</strong> — see <strong>${blockedStep.label}</strong> above for details and next steps.`
  };
  if (allPass) return {
    finalStatus: 'pass',
    finalVerdict: `✅ <strong>${passLabel}</strong>`
  };
  if (uncertainStep) return {
    finalStatus: 'warn',
    finalVerdict: `⚠️ <strong>Diagnosis incomplete</strong> — one or more steps need manual review. Check the flagged step(s) above.`
  };
  return {
    finalStatus: 'warn',
    finalVerdict: `⚠️ <strong>No issues detected</strong> — all evaluated checks passed. Review the steps above for more detail.`
  };
}

// ── Resume from a specific step after an early stop ────────────────────────────
async function resumeFromStep(fromIndex, runId) {
  if (!savedDiagState) return;
  const { steps, timeRange, area, stepOutcomes } = savedDiagState;

  for (let i = fromIndex; i < steps.length; i++) {
    if (runId !== currentRunId) return;
    const step = steps[i];
    sendToPanel({ type: 'STEP_START', stepIndex: i });

    try {
      if (step.manual) {
        if (runId !== currentRunId) return;
        sendToPanel({ type: 'STEP_RESULT', stepIndex: i, status: 'warn',
          verdict: step.manualNote, queryUrl: null,
          splunkDashboardUrl: step.dashboardUrl || null, count: null, summaries: [] });
        continue;
      }

      const isSplunk = step.tool === 'splunk';
      const tabId    = isSplunk ? await findOrCreateSplunkTab() : await findOrCreateChronosphereTab();
      if (runId !== currentRunId) return;
      const queryUrl = isSplunk ? buildSplunkUrl(step.query, timeRange) : buildChronoUrl(step.query, timeRange);
      await navigateAndWait(tabId, queryUrl);
      if (runId !== currentRunId) return;

      const results = isSplunk ? await readSplunkResults(tabId) : await readChronosphereResults(tabId);
      if (runId !== currentRunId) return;

      if (results.timeout) {
        const toolName = isSplunk ? 'Splunk' : 'Chronosphere';
        sendToPanel({ type: 'STEP_RESULT', stepIndex: i, status: 'warn',
          verdict: `<strong>⏱ ${toolName} timed out before results loaded</strong><br>
            <br>Click <strong>"View in ${toolName}"</strong> to check manually.`,
          count: '?', summaries: [], queryUrl });
        continue;
      }

      const verdict = step.interpret(results);
      // Avoid duplicating a step outcome that was already recorded
      if (!stepOutcomes[i]) {
        stepOutcomes[i] = { status: verdict.status, label: step.label || `Step ${i + 1}`, stopEarly: verdict.stopEarly };
      }

      sendToPanel({ type: 'STEP_RESULT', stepIndex: i, status: verdict.status,
        verdict: verdict.message, count: results.count, summaries: results.summaries,
        queryUrl, jiraTeam: verdict.jiraTeam || null, jiraNote: verdict.jiraNote || null });

      if (verdict.stopEarly) {
        if (runId !== currentRunId) return;
        savedDiagState = { steps, timeRange, area, stepOutcomes };
        const { finalStatus, finalVerdict } = computeFinalVerdict(stepOutcomes, area);
        sendToPanel({ type: 'DONE', finalStatus, finalVerdict, canContinue: true, nextStep: i + 1 });
        return;
      }

    } catch (err) {
      if (runId !== currentRunId) return;
      sendToPanel({ type: 'STEP_ERROR', stepIndex: i, error: err.message });
    }
  }

  if (runId !== currentRunId) return;
  savedDiagState = { steps, timeRange: msg.timeRange, area, stepOutcomes };
  const { finalStatus, finalVerdict } = computeFinalVerdict(stepOutcomes, area);
  sendToPanel({ type: 'DONE', finalStatus, finalVerdict });
}

// ══════════════════════════════════════════════════════════════════════════════
// ─── STEP BUILDERS ────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// ── is_qualified helper ────────────────────────────────────────────────────────
// Parses Chronosphere row text to determine if a flow criteria log shows
// is_qualified = true or false. Returns true/false/null (null = undetermined).
// Handles all JSON formats: {"is_qualified":false}, "is_qualified": false, etc.
function detectQualified(summaries) {
  // Match all real-world Chronosphere JSON formats:
  //   "is_qualified": true / false   (standard JSON)
  //   "is_qualified":true            (no space)
  //   is_qualified = true            (assignment style)
  //   "is_qualified":"true"          (string-wrapped)
  for (const s of summaries) {
    // false / 0 → blocked
    if (/"?is_qualified"?\s*[:=]\s*"?false"?/i.test(s))    return false;
    if (/"?is_qualified"?\s*[:=]\s*0(?:[,}\s]|$)/i.test(s)) return false;
    // true / 1 → passed
    if (/"?is_qualified"?\s*[:=]\s*"?true"?/i.test(s))     return true;
    if (/"?is_qualified"?\s*[:=]\s*1(?:[,}\s]|$)/i.test(s)) return true;
  }
  return null; // log found but is_qualified not readable from extracted text
}

// ── PROFILE FILTER FAILURE PARSER ─────────────────────────────────────────────
// Converts a raw criterion string from simplified_criterions into readable HTML.
function parseCriterionLabel(s) {
  // customer-in-flow-alltime-{flowId}
  const inFlowMatch = s.match(/^customer-in-flow-alltime-(.+)$/);
  if (inFlowMatch) return `Profile has already been in this flow (${inFlowMatch[1]})`;

  // customer-attribute-{type}-{op}[-{value}]--{propertyName}
  const ddIdx = s.indexOf('--');
  if (ddIdx !== -1) {
    const left = s.substring(0, ddIdx);
    const property = s.substring(ddIdx + 2);
    // Strip "customer-attribute-{type}-" prefix to get the condition part
    const condPart = left.replace(/^customer-attribute-\w+-/, '');
    if (condPart === 'exists')   return `<code>${property}</code> must exist`;
    if (condPart === 'nexists')  return `<code>${property}</code> does not exist`;
    const m = condPart.match(/^(eq|ne|lt|lte|gt|gte|contains|ncontains)-(.+)$/);
    if (m) {
      const ops = { eq: '=', ne: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥', contains: 'contains', ncontains: 'does not contain' };
      return `<code>${property}</code> ${ops[m[1]] || m[1]} <code>${m[2]}</code>`;
    }
    return `<code>${property}</code> ${condPart}`;
  }
  return `<code>${s}</code>`;
}

// Parses FLOW_CRITERIA_LOG from Chronosphere summaries and returns an array of
// failed criterion groups, or null if the log can't be parsed.
// Each entry is an array of sub-condition strings (OR logic within the group).
function parseFilterFailure(summaries) {
  const logText = (summaries || []).find(s => s.includes('FLOW_CRITERIA_LOG'));
  if (!logText) return null;
  const jsonStart = logText.indexOf('---- ');
  if (jsonStart === -1) return null;
  let data;
  try { data = JSON.parse(logText.substring(jsonStart + 5)); } catch (e) { return null; }
  const criterions = data.simplified_criterions || [];
  const result0 = (data.filtering_results || [])[0];
  if (!result0) return null;
  const rpc = result0.results_per_criterion || [];
  const failedGroups = [];
  criterions.forEach((group, i) => {
    const groupResults = rpc[i] || [];
    // Only process groups that were actually evaluated (have at least one real Array entry)
    if (!groupResults.some(r => Array.isArray(r))) return;
    // Group fails if no sub-condition returned is_qualified = true
    if (!groupResults.some(r => Array.isArray(r) && r[0] === true)) {
      failedGroups.push(group);
    }
  });
  return failedGroups.length > 0 ? failedGroups : null;
}

// Renders the "Failed conditions" block from parseFilterFailure output.
function renderFilterFailureDetail(failedGroups) {
  if (!failedGroups) return '';
  const rows = failedGroups.map(group => {
    const condHtml = group.map(parseCriterionLabel).join(' <em style="color:var(--text-secondary)">or</em> ');
    return `<li>${condHtml}</li>`;
  }).join('');
  const plural = failedGroups.length > 1 ? 's' : '';
  return `<br><strong>Failed condition${plural}:</strong><ul style="margin:4px 0 0">${rows}</ul>`;
}

// ── FLOWS ─────────────────────────────────────────────────────────────────────
function buildFlowSteps(flowType, fields, msg) {
  const { accountId, flowId, profileId, activityId, listSegId, flowMessageId } = fields;
  const timeRange = msg.timeRange;

  // ── METRIC TRIGGER ──────────────────────────────────────────────────────────
  if (flowType === 'metric') return [
    // Step 1: Trigger filter
    {
      tool: 'chronosphere',
      query: [`json_output.description = "event_trigger_trigger_filter"`,
              `json_output.company_id = "${accountId}"`,
              `json_output.filter_source_id = "${flowId}"`,
              ...(activityId ? [`message: "${activityId}"`] : [])].join('\n'),
      interpret(r) {
        if (r.noResults) return {
          status: 'warn', stopEarly: false,
          message: `<strong>No trigger filter log found</strong> — this flow has no trigger filter configured.<br>
            <br>Profiles enter the flow automatically when the metric fires.<br>
            <br><strong>What this means:</strong> This is expected and <em>not</em> the root cause of the issue.<br>
            <strong>Next steps:</strong>
            <ul>
              <li>Continue to Step 2 to check the flow's profile filter</li>
              <li>If both filters pass, check if the profile is email-suppressed or unsubscribed</li>
              <li>Check additional filters on specific flow messages (Step 3)</li>
            </ul>`
        };
        const qualified = detectQualified(r.summaries);
        if (qualified === false) return {
          status: 'fail', stopEarly: true,
          message: `<strong>Profile FAILED the trigger filter</strong> — <code>is_qualified = false</code><br>
            <br><strong>What this means:</strong> The event the profile triggered did not meet the filter conditions set on the flow's trigger.<br>
            <br><strong>Common causes:</strong>
            <ul>
              <li>Event property didn't match the filter value (e.g., wrong product category, revenue threshold)</li>
              <li>The event was triggered in a different currency or had an unexpected value</li>
              <li>A date/time condition on the trigger was not met</li>
            </ul>
            <strong>Next steps:</strong>
            <ul>
              <li>Expand the raw log and find <code>is_qualified: false</code> — the surrounding fields show exactly which condition failed</li>
              <li>Compare the log's field values against the trigger filter settings in the flow editor</li>
              <li>If the filter looks wrong, the customer may need to adjust the trigger filter or the event data being sent</li>
            </ul>`
        };
        if (qualified === null) return {
          status: 'warn',
          message: `<strong>Trigger filter log found but pass/fail could not be confirmed</strong><br>
            <br>A log was found but <code>is_qualified</code> wasn't readable from the extracted text.<br>
            <strong>Action:</strong> Click "View in Chronosphere" and manually check whether <code>is_qualified</code> is <code>true</code> or <code>false</code> in the log.`
        };
        return {
          status: 'pass',
          message: `<strong>Profile passed the trigger filter ✅</strong><br>
            <br>The triggering event met all the conditions on the flow's trigger filter.<br>
            <strong>Next step:</strong> Check the flow's profile filter (Step 2).`
        };
      }
    },
    // Step 2: Flow/Profile filter
    {
      tool: 'chronosphere',
      query: [`json_output.description = "event_trigger_profile_filter"`,
              `json_output.company_id = "${accountId}"`,
              `json_output.filter_source_id = "${flowId}"`,
              ...(activityId ? [`message: "${activityId}"`] : [])].join('\n'),
      interpret(r) {
        if (r.noResults) return {
          status: 'warn',
          message: `<strong>No flow filter log found</strong> — this flow has no profile filter configured.<br>
            <br>Profiles enter the flow unconditionally when the trigger fires.<br>
            <br><strong>Next steps:</strong>
            <ul>
              <li>Check Step 3: additional filters on specific flow messages</li>
              <li>Verify the profile is not suppressed or unsubscribed from email marketing</li>
              <li>Check for conditional splits in the flow that might route the profile away from messages</li>
            </ul>`
        };
        const qualified = detectQualified(r.summaries);
        if (qualified === false) {
          const failedGroups = parseFilterFailure(r.summaries);
          const detail = renderFilterFailureDetail(failedGroups);
          return {
            status: 'fail', stopEarly: true,
            message: `<strong>Profile FAILED the flow profile filter</strong> — <code>is_qualified = false</code>${detail}
              <br><strong>What this means:</strong> The profile's properties did not meet the conditions set on the flow's profile filter at the time the metric fired.<br>
              <br><strong>Next steps:</strong>
              <ul>
                <li>Check the profile's properties — do they match what the filter expects?</li>
                <li>Review the profile's activity timeline — a recent action may have changed their eligibility</li>
                <li>Review whether the flow filter is intentionally restrictive or a misconfiguration</li>
              </ul>`
          };
        }
        if (qualified === null) return {
          status: 'warn', stopEarly: false,
          message: `<strong>Profile filter log found but pass/fail could not be confirmed</strong><br>
            <br>A log was found but <code>is_qualified</code> wasn't readable from the extracted text. This may mean the profile was <strong>blocked</strong>.<br>
            <strong>Action:</strong> Click "View in Chronosphere" and check <code>is_qualified</code> directly — if it's <code>false</code>, the profile was blocked by the filter.`
        };
        return {
          status: 'pass',
          message: `<strong>Profile passed the flow profile filter ✅</strong><br>
            <br>The profile met all conditions and entered the flow.<br>
            <strong>Next step:</strong> If they still didn't receive a specific message, check Step 3 for additional filters on flow messages.`
        };
      }
    },
    // Step 3: Additional filter on specific flow messages
    // IMPORTANT: filter_source_id for send_message_profile_filter = Flow MESSAGE ID (not Flow ID).
    // The Flow Message ID is the unique ID of the specific message node inside the flow editor.
    // If the agent didn't provide it, we fall back to a broader profile-only search which may
    // still surface a log if the profile encountered any message filter, but it won't be scoped
    // to a specific message step.
    ...(flowMessageId ? [{
      tool: 'chronosphere',
      label: 'Additional message filter',
      query: [`json_output.description = "send_message_profile_filter"`,
              `json_output.company_id = "${accountId}"`,
              `json_output.filter_source_id = "${flowMessageId}"`,
              ...(profileId ? [`"${profileId}"`] : [])].join('\n'),
      interpret(r) {
        if (r.noResults) return {
          status: 'warn',
          message: `<strong>No additional message filter log found for this message step</strong><br>
            <br>No filter evaluation was logged for this profile against this specific flow message (ID: <code>${flowMessageId}</code>).<br>
            <br><strong>Possible reasons:</strong>
            <ul>
              <li>This message step has no additional filter configured — all profiles that reach this step receive it</li>
              <li>The profile hasn't reached this message step yet (they may still be in a time delay)</li>
              <li>The log is outside the current time range — try widening</li>
            </ul>
            <strong>If the profile entered the flow but didn't receive a message, also check:</strong>
            <ul>
              <li><strong>Suppression/unsubscribe</strong> — Check their subscription status on the profile in the account</li>
              <li><strong>Smart Sending</strong> — Was Smart Sending enabled on the flow?</li>
              <li><strong>Conditional splits</strong> — Did a split route them to a "Do nothing" branch?</li>
              <li><strong>Flow grace period</strong> — Search Chronosphere for <code>FLOW_GRACE_PERIOD_SKIP</code> with this profile ID</li>
            </ul>`
        };
        const qualified = detectQualified(r.summaries);
        if (qualified === false) return {
          status: 'fail', stopEarly: true,
          message: `<strong>Profile FAILED an additional filter on a flow message</strong> — <code>is_qualified = false</code><br>
            <br><strong>What this means:</strong> The profile entered the flow but was blocked from receiving message <code>${flowMessageId}</code> by an additional filter configured on that step.<br>
            <br><strong>Next steps:</strong>
            <ul>
              <li>Expand the raw log to see which condition returned <code>false</code></li>
              <li>Check the "Additional filters" setting on that message step in the flow editor</li>
              <li>Consider whether the filter is intentional (e.g., VIP-only) or a misconfiguration</li>
            </ul>`
        };
        if (qualified === null) return {
          status: 'warn',
          message: `<strong>Message filter log found but pass/fail could not be confirmed</strong><br>
            <br>A log exists for this message step but <code>is_qualified</code> wasn't readable from the extracted text.<br>
            <strong>Action:</strong> Click "View in Chronosphere" and check <code>is_qualified</code> directly.`
        };
        return {
          status: 'pass',
          message: `<strong>Profile passed the additional filter on this message step ✅</strong><br>
            <br>No additional filter blocked the profile from receiving message <code>${flowMessageId}</code>.<br>
            <strong>If they still didn't get an email, check:</strong> suppression status, Smart Sending, and conditional splits in the flow.`
        };
      }
    }] : [{
      // No flowMessageId provided — show manual guidance
      tool: 'chronosphere',
      label: 'Additional message filter',
      manual: true,
      manualNote: `<strong>No Flow Message ID provided</strong> — to auto-run this check, go back and add the Flow Message ID (optional field in the form). Find it by clicking the message step in the flow editor — it appears in the URL or settings panel.<br>
        <br><strong>To check manually in Chronosphere:</strong> search <code>send_message_profile_filter</code> + <code>${accountId}</code> + <code>${profileId}</code> — this finds all message filter logs for this profile across all flow steps.<br>
        <br><strong>If the profile entered the flow but didn't get a message, also check:</strong> suppression/unsubscribe status, Smart Sending, conditional splits routing to "Do nothing", or flow grace period (<code>FLOW_GRACE_PERIOD_SKIP</code>).`
    }])
  ];

  // ── LIST / SEGMENT TRIGGER ───────────────────────────────────────────────────
  if (flowType === 'list_segment') return [
    {
      // Step 1: Splunk — check if profile was added via a non-triggering pathway
      tool: 'splunk',
      label: 'List trigger path check',
      query: `add_customers_to_list_without_triggering_flows group_id: ${listSegId}, customer_id: ${profileId}`,
      interpret(r) {
        if (r.noResults) return {
          status: 'pass',
          message: `<strong>No non-triggering add found ✅</strong><br>
            <br>The profile was not added via a pathway that bypasses flow triggers (e.g., import, merge, admin add).<br>
            <strong>Next step:</strong> Continue to Step 2 to verify the trigger was sent to the Flows pipeline.`
        };
        return {
          status: 'fail', stopEarly: true,
          message: `<strong>Profile was added via a non-triggering pathway</strong><br>
            <br><strong>What this means:</strong> The profile was added to the list/segment through a method that deliberately does <em>not</em> trigger flows — such as a profile merge, backdated consent, or an admin "Add to list" action.<br>
            <br><strong>This is expected behaviour</strong> — Klaviyo intentionally does not fire flow triggers for these add methods.<br>
            <br><strong>Next steps:</strong>
            <ul>
              <li>Expand the raw logs to see the exact add method used</li>
              <li>If the customer expected the flow to fire, they'll need to add the profile via a method that does trigger flows (e.g., a form signup or API add with trigger_flows enabled)</li>
            </ul>`
        };
      }
    },
    {
      tool: 'chronosphere',
      query: [`message: "${profileId}"`, `message: "${listSegId}"`, `message: "Group trigger into Aggatha"`, `log.file.path = "FLOW_TRIGGERING"`].join('\n'),
      interpret(r) {
        if (r.noResults) return {
          status: 'fail', stopEarly: true,
          message: `<strong>Groups/Segments never sent the trigger to Flows</strong><br>
            <br><strong>What this means:</strong> The list/segment service didn't dispatch a trigger event to the Flows pipeline for this profile.<br>
            <br><strong>Common causes:</strong>
            <ul>
              <li>Profile was added via an import, merge, or admin action — these do <strong>not</strong> trigger flows</li>
              <li>Profile was added via API without the "trigger flows" flag</li>
              <li>The list/segment add event was processed but the trigger queue was not updated (service issue)</li>
              <li>Profile was already a member of the list — re-adding doesn't trigger flows</li>
            </ul>
            <strong>Next steps:</strong>
            <ul>
              <li>Check HOW the profile was added to the list (import, form signup, API, manual add?)</li>
              <li>Verify the profile is currently in the list in the account</li>
              <li>If added correctly and this looks like a bug, escalate to the <strong>Groups/Segments</strong> team</li>
            </ul>`,
          jiraTeam: 'Groups / Segments',
          jiraNote: 'No "Group trigger into Aggatha" log found for this profile + list/segment. Profile may have been added via a non-triggering pathway.'
        };
        return {
          status: 'pass',
          message: `<strong>Groups/Segments sent the trigger to Flows ✅</strong><br>
            <br>The trigger event was dispatched. Continue to Step 3 to verify the Flows pipeline received it.`
        };
      }
    },
    {
      tool: 'chronosphere',
      query: [`message: "${profileId}"`, `message: "${listSegId}"`, `message: "Group trigger read out of Aggatha"`, `log.file.path = "FLOW_TRIGGERING"`].join('\n'),
      interpret(r) {
        if (r.noResults) return {
          status: 'fail', stopEarly: true,
          message: `<strong>Flows pipeline never started processing the trigger</strong><br>
            <br><strong>What this means:</strong> The trigger was sent by Groups/Segments (Step 2 passed) but the Flows pipeline never picked it up to start evaluating the profile.<br>
            <br><strong>This is likely a Flows infrastructure issue.</strong><br>
            <br><strong>Next steps:</strong>
            <ul>
              <li>Check if other profiles in the same list/segment triggered the flow correctly around the same time</li>
              <li>Escalate to the <strong>Flows</strong> team with the profile ID, flow ID, account ID, and estimated timestamp</li>
            </ul>`,
          jiraTeam: 'Flows',
          jiraNote: '"Group trigger read out of Aggatha" not found — pipeline did not start after trigger was sent. Possible Flows queue processing issue.'
        };
        return {
          status: 'pass',
          message: `<strong>Flows pipeline started processing ✅</strong><br>
            <br>The trigger was received and the pipeline began evaluating the profile. Continue to Step 4.`
        };
      }
    },
    {
      tool: 'chronosphere',
      query: [`json_output.description = "group_trigger_trigger_filter"`, `message: "${accountId}"`, `message: "${flowId}"`, `message: "${profileId}"`].join('\n'),
      interpret(r) {
        if (r.noResults) return {
          status: 'warn',
          message: `<strong>No trigger filter log found</strong> — this flow has no trigger filter configured.<br>
            <br>Profiles enter unconditionally when they join the list/segment.<br>
            <strong>Next step:</strong> Check the flow's profile filter in Step 5.`
        };
        const qualified = detectQualified(r.summaries);
        if (qualified === false) return {
          status: 'fail', stopEarly: true,
          message: `<strong>Profile FAILED the trigger filter</strong> — <code>is_qualified = false</code><br>
            <br><strong>What this means:</strong> The profile didn't meet the conditions on the flow's trigger filter at the time they joined the list/segment.<br>
            <br><strong>Next steps:</strong>
            <ul>
              <li>Expand the raw log to find which condition returned <code>false</code></li>
              <li>Check the profile's properties at the time they joined the list — did they have the required property values?</li>
              <li>If the trigger filter uses a "Has done" condition, check the profile's activity timeline</li>
            </ul>`
        };
        if (qualified === null) return {
          status: 'warn',
          message: `<strong>Trigger filter log found but pass/fail could not be confirmed</strong><br>
            <br>A log was found but <code>is_qualified</code> wasn't readable from the extracted text.<br>
            <strong>Action:</strong> Click "View in Chronosphere" and manually check <code>is_qualified</code>.`
        };
        return {
          status: 'pass',
          message: `<strong>Profile passed the trigger filter ✅</strong><br>
            <strong>Next step:</strong> Check the flow's profile filter in Step 5.`
        };
      }
    },
    {
      tool: 'chronosphere',
      query: [`json_output.description = "group_trigger_profile_filter"`, `message: "${accountId}"`, `message: "${flowId}"`, `message: "${profileId}"`].join('\n'),
      interpret(r) {
        if (r.noResults) return {
          status: 'warn',
          message: `<strong>No flow profile filter log found</strong> — this flow has no profile filter configured.<br>
            <br>Profiles enter unconditionally. If they still didn't receive messages, check for:<br>
            <ul>
              <li>Email suppression / unsubscribe status on the profile</li>
              <li>Additional filters on specific flow messages</li>
              <li>Conditional splits routing them to "Do nothing"</li>
            </ul>`
        };
        const qualified = detectQualified(r.summaries);
        if (qualified === false) {
          const failedGroups = parseFilterFailure(r.summaries);
          const detail = renderFilterFailureDetail(failedGroups);
          return {
            status: 'fail', stopEarly: true,
            message: `<strong>Profile FAILED the flow profile filter</strong> — <code>is_qualified = false</code>${detail}
              <br><strong>What this means:</strong> The profile's properties did not meet the flow filter conditions at the time they joined the list/segment.<br>
              <br><strong>Next steps:</strong>
              <ul>
                <li>Check the profile's property values — do they match what the filter expects?</li>
                <li>Review whether the flow filter is intentionally restrictive or a misconfiguration</li>
              </ul>`
          };
        }
        if (qualified === null) return {
          status: 'warn', stopEarly: false,
          message: `<strong>Profile filter log found but pass/fail could not be confirmed</strong><br>
            <br>A log was found but <code>is_qualified</code> wasn't readable. This may mean the profile was blocked.<br>
            <strong>Action:</strong> Click "View in Chronosphere" and check <code>is_qualified</code> directly.`
        };
        return {
          status: 'pass',
          message: `<strong>Profile passed the flow profile filter ✅</strong><br>
            <br>Profile entered the flow. If messages weren't received, check for suppression, Smart Sending, and additional message filters.`
        };
      }
    }
  ];

  // ── DATE TRIGGER ─────────────────────────────────────────────────────────────
  if (flowType === 'date') return [
    // Step 1: Did the nightly queue create an internal event for this profile?
    {
      tool: 'chronosphere',
      label: 'Nightly queue — internal event created',
      query: [
        `json_output.description = "next date is within range of tomorrow, creating internal event"`,
        `json_output.customer_id = "${profileId}"`
      ].join('\n'),
      interpret(r) {
        if (r.noResults) return {
          status: 'fail', stopEarly: true,
          message: `<strong>Nightly queue did NOT create an internal event for this profile</strong><br>
            <br><strong>What this means:</strong> The nightly date queue ran but did not produce a trigger event for this profile — meaning their date property either wasn't within range of tomorrow, was missing, or they weren't considered eligible at queue time.<br>
            <br><strong>Common causes:</strong>
            <ul>
              <li>The profile's date property doesn't exist, is empty, or is in an unexpected format</li>
              <li>The date is more than 1 day in the future — they'll be picked up on a future nightly run</li>
              <li>The date has already passed — date-based flows do not backfill past dates</li>
              <li>The property name in the flow doesn't exactly match the name on the profile (capitalisation matters)</li>
            </ul>
            <strong>Next steps:</strong>
            <ul>
              <li>Check the profile's properties — does the date property exist and contain a valid value?</li>
              <li>Verify the property name in the flow settings matches exactly</li>
              <li>Try widening the time range to cover the expected nightly run window (runs around midnight UTC)</li>
            </ul>`
        };
        return {
          status: 'pass',
          message: `<strong>Nightly queue created an internal event for this profile ✅</strong><br>
            <br>The nightly job found this profile's date was within range of tomorrow and created an internal trigger event. Continue to Step 2 to confirm the flow/profile combo was eligible.`
        };
      }
    },
    // Step 2: Was the flow/profile combo eligible for date-trigger processing?
    {
      tool: 'chronosphere',
      label: 'Flow/profile eligibility check',
      query: [
        `log.file.path = "FLOW_NIGHTLY_QUEUE_DATE_BASED"`,
        `json_output.flow_id = "${flowId}"`,
        `json_output.customer_id = "${profileId}"`
      ].join('\n'),
      interpret(r) {
        if (r.noResults) return {
          status: 'fail', stopEarly: true,
          message: `<strong>Flow/profile combo was NOT eligible — no internal event created for this flow</strong><br>
            <br><strong>What this means:</strong> The nightly queue processed this profile (Step 1 passed) but did not create an internal event for this specific flow and profile combination. The trigger was never handed off to the flow.<br>
            <br><strong>Common causes:</strong>
            <ul>
              <li>The profile wasn't in the flow's target segment or list at the time the queue ran</li>
              <li>The flow was paused or the date trigger was misconfigured</li>
              <li>The profile was already in the flow's grace period or suppressed from re-entry</li>
            </ul>
            <strong>Next steps:</strong>
            <ul>
              <li>Confirm the profile was in the flow's trigger segment at midnight UTC on the expected date</li>
              <li>Check the flow's trigger settings — is the date property and operator configured correctly?</li>
              <li>If everything looks correct, escalate to the <strong>Flows</strong> team</li>
            </ul>`,
          jiraTeam: 'Flows',
          jiraNote: 'FLOW_NIGHTLY_QUEUE_DATE_BASED log not found for this flow/profile combo. Step 1 passed (internal event created) but Step 2 found no eligibility log.'
        };
        return {
          status: 'pass',
          message: `<strong>Flow/profile combo was eligible ✅</strong><br>
            <br>A <code>FLOW_NIGHTLY_QUEUE_DATE_BASED</code> log was found — the internal event was created for this flow and profile. Continue to Step 3 to check the trigger/flow filter stage.`
        };
      }
    },
    // Step 3: Did the profile pass the date trigger / flow filter evaluation?
    {
      tool: 'chronosphere',
      label: 'Date trigger / flow filter',
      query: [
        `log.file.path = "FLOW_CRITERIA_LOG"`,
        `json_output.description = "date_triggering_flow_filter"`,
        `message: "${flowId}"`,
        `message: "${profileId}"`
      ].join('\n'),
      interpret(r) {
        if (r.noResults) return {
          status: 'warn',
          message: `<strong>No trigger/flow filter log found</strong><br>
            <br><strong>Possible reasons:</strong>
            <ul>
              <li>This flow has no trigger filter or profile filter configured — profiles enter unconditionally once the internal event is created</li>
              <li>The log is outside the current time range — try widening to cover the nightly run date</li>
              <li>The internal event was created but processing hasn't completed yet</li>
            </ul>
            <strong>Next steps:</strong>
            <ul>
              <li>Check the flow editor — does it have a trigger filter or profile filter configured?</li>
              <li>If no filter exists, the profile should have entered — check for email suppression or Smart Sending</li>
              <li>Widen the time range and re-run if needed</li>
            </ul>`
        };
        const qualified = detectQualified(r.summaries);
        if (qualified === false) {
          const failedGroups = parseFilterFailure(r.summaries);
          const detail = renderFilterFailureDetail(failedGroups);
          return {
            status: 'fail', stopEarly: true,
            message: `<strong>Profile FAILED the date trigger/flow filter</strong> — <code>is_qualified = false</code>${detail}
              <br><strong>What this means:</strong> The profile's date was within range and the internal event was created, but they didn't meet the flow's filter conditions at evaluation time.<br>
              <br><strong>Next steps:</strong>
              <ul>
                <li>Check the profile's property values — do they match what the filter expects?</li>
                <li>Review the flow's filter settings in the flow editor</li>
              </ul>`
          };
        }
        if (qualified === null) return {
          status: 'warn', stopEarly: false,
          message: `<strong>Date filter log found but pass/fail could not be confirmed</strong><br>
            <br>A log was found but <code>is_qualified</code> wasn't readable.<br>
            <strong>Action:</strong> Click "View in Chronosphere" and check <code>is_qualified</code> directly.`
        };
        return {
          status: 'pass',
          message: `<strong>Profile passed the trigger/flow filter ✅</strong><br>
            <br>Profile entered the flow. If they didn't receive messages, check for email suppression, Smart Sending, and additional message filters.`
        };
      }
    }
  ];

  return [];
}

// ── CAMPAIGNS (Splunk) ────────────────────────────────────────────────────────
function buildCampaignSteps(scenario, fields, timeRange) {
  const { accountId, campaignId, profileId } = fields;

  const scenarios = {
    // KB: manual workflow via Staffside "View Splunk Logs" — no standalone query provided.
    // We mark this as a manual step and guide the agent through the Staffside approach.
    created: {
      manual: true,
      label: 'Who created this campaign?',
      manualNote: `<a href="https://www.klaviyo.com/staff/campaign/${campaignId}" target="_blank" class="step-action" style="display:inline-block;margin:0 0 10px">🔗 Open Campaign in Staffside</a>
        <strong>How to find who created it:</strong>
        <ol>
          <li>In Staffside, click <strong>"View Splunk Logs"</strong> on the left sidebar</li>
          <li>Adjust the Splunk date range to when the campaign was created</li>
          <li>Quick-find <strong>"user"</strong> in the results — you should see the responsible user's email</li>
          <li>If you can't find it by quick-find, click <strong>Export</strong> and search "user" in the exported file</li>
          <li>If no email appears, look for <strong>user_id</strong> instead — confirm it's the user_id for the campaign creation action</li>
          <li>Paste the user_id into: <code>https://www.klaviyo.com/staff/user/&lt;user_id&gt;</code> to look up their email</li>
          <li>Once found, look up the user in the <strong>Staffside Profile tab</strong> to see other campaigns they've scheduled or sent in the account</li>
        </ol>
        <strong>Note:</strong> Splunk logs are only retained for <strong>90 days</strong>.`
    },
    // KB query: event_type="delete" ACCOUNT_ID
    deleted: {
      query: `index=klaviyo event_type="delete" ${accountId}`,
      label: 'Who deleted this campaign?',
      interpret(r) {
        if (r.noResults) return {
          status: 'warn',
          message: `<strong>No campaign deletion log found</strong><br>
            <br><strong>Possible reasons:</strong>
            <ul>
              <li>The campaign was not deleted — it may be in draft, archived, or in another status</li>
              <li>Deletion occurred more than 90 days ago (Splunk retention limit)</li>
              <li>The Account ID may be incorrect</li>
            </ul>
            <strong>Next steps:</strong>
            <ul>
              <li>Check if the campaign still exists in Staffside under a different status</li>
              <li>Verify the Account ID is correct</li>
              <li>Try widening the time range to 90d</li>
            </ul>`
        };
        // Parse user_id, timestamp, and description from the raw log text
        let userId = null, deletedAt = null, description = null;
        for (const s of (r.summaries || [])) {
          if (!userId)     { const m = s.match(/"user_id"\s*:\s*"([^"]+)"/);     if (m) userId = m[1]; }
          if (!deletedAt)  { const m = s.match(/"timestamp"\s*:\s*"([^"]+)"/);   if (m) deletedAt = m[1].replace('T', ' ').replace(/\.\d+$/, ''); }
          if (!description){ const m = s.match(/"description"\s*:\s*"([^"]+)"/); if (m) description = m[1]; }
        }
        const userBlock = userId
          ? `<br><br>👤 <strong>Deleted by user_id:</strong> <code>${userId}</code>
             <br><a href="https://www.klaviyo.com/staff/search?q=${userId}" target="_blank" class="step-action" style="display:inline-block;margin:6px 0 2px">🔍 Look up user in Staffside →</a>`
          : `<br><br>⚠️ <strong>user_id not found in extracted text</strong> — expand the raw log below and search for <code>user_id</code> manually.`;
        const timeBlock  = deletedAt   ? `<br>🕐 <strong>Deleted at:</strong> <code>${deletedAt} UTC</code>` : '';
        const descBlock  = description ? `<br>📋 <strong>Action:</strong> ${description}` : '';
        return {
          status: 'pass',
          message: `<strong>Campaign deletion log found ✅</strong>${userBlock}${timeBlock}${descBlock}`
        };
      }
    },
    // KB query: CAMPAIGNS_CAMPAIGN_SKIP_FORWARDER company_id=ACCOUNT_ID
    skipped: {
      query: `index=klaviyo CAMPAIGNS_CAMPAIGN_SKIP_FORWARDER company_id=${accountId}${campaignId ? ` message_id=${campaignId}` : ''}`,
      label: 'campaign skip log',
      noResultsMsg: `<strong>No campaign skip log found</strong><br>
        <br><strong>Possible reasons:</strong>
        <ul>
          <li>The profile was not skipped — they may have been included in the send successfully</li>
          <li>The skip occurred outside the current time range</li>
          <li>The profile was excluded at the list level before the send started</li>
        </ul>
        <strong>Next steps:</strong>
        <ul>
          <li>Check if the profile is on the campaign's recipient list in the account</li>
          <li>Check for profile suppression in the Lists & Profiles section</li>
          <li>Check if Smart Sending was enabled — if yes, run the Smart Sending check</li>
          <li>Verify the profile's consent/subscription status for the sending channel</li>
        </ul>`,
      interpret(r) {
        if (r.noResults) return {
          status: 'warn',
          message: `<strong>No campaign skip log found</strong><br>
            <br><strong>Possible reasons:</strong>
            <ul>
              <li>The profile was not skipped — they may have been included in the send successfully</li>
              <li>The skip occurred outside the current time range</li>
              <li>The profile was excluded at the list level before the send started</li>
            </ul>
            <strong>Next steps:</strong>
            <ul>
              <li>Check if the profile is on the campaign's recipient list in the account</li>
              <li>Check for profile suppression in the Lists &amp; Profiles section</li>
              <li>Check if Smart Sending was enabled — if yes, run the Smart Sending check</li>
              <li>Verify the profile's consent/subscription status for the sending channel</li>
            </ul>`
        };

        // Count error_code occurrences across captured summaries
        const reasonCounts = {};
        let primaryDesc = null;
        for (const s of (r.summaries || [])) {
          const ec = s.match(/"error_code"\s*:\s*"([^"]+)"/);
          const key = ec ? ec[1] : 'Unknown';
          reasonCounts[key] = (reasonCounts[key] || 0) + 1;
          if (!primaryDesc) {
            const desc = s.match(/"description"\s*:\s*"([^"]+)"/);
            if (desc) primaryDesc = desc[1];
          }
        }

        const totalCount  = parseInt(r.count) || 0;
        const sampleSize  = (r.summaries || []).length;
        const sorted      = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]);
        const uniqueCount = sorted.length;

        let reasonsHtml = '';
        if (uniqueCount === 0) {
          reasonsHtml = `<br>⚠️ Could not parse skip reason — expand raw logs below.`;
        } else if (uniqueCount === 1) {
          const reason = sorted[0][0];
          const descLine = primaryDesc ? `<br>📋 <em>${primaryDesc}</em>` : '';
          reasonsHtml = `<br>❌ <strong>Skip reason:</strong> <code>${reason}</code> — <strong>${totalCount.toLocaleString()} occurrence${totalCount !== 1 ? 's' : ''}</strong>${descLine}`;
        } else {
          const sampleNote = totalCount > sampleSize
            ? `<br><em>⚠️ Counts from first ${sampleSize} of ${totalCount.toLocaleString()} total events — view in Splunk for full breakdown.</em>`
            : '';
          reasonsHtml = sampleNote;
          sorted.forEach(([reason, count], i) => {
            const icon  = i === 0 ? '❌' : '⚠️';
            const label = i === 0 ? '<strong>Primary reason:</strong>' : '<strong>Also found:</strong>';
            reasonsHtml += `<br>${icon} ${label} <code>${reason}</code> — <strong>${count}</strong> event${count !== 1 ? 's' : ''}`;
          });
        }

        return {
          status: 'fail',
          message: `<strong>Campaign skip log found</strong>${totalCount ? ` — <strong>${totalCount.toLocaleString()} total events</strong>` : ''}${reasonsHtml}`
        };
      }
    },
    // KB query: index="klaviyo" Company_ID "Updating Smart Sending"
    smart_sending: {
      query: `index="klaviyo" ${accountId} "Updating Smart Sending"`,
      label: 'Smart Sending setting change log',
      interpret(r) {
        if (r.noResults) return {
          status: 'warn',
          message: `<strong>No Smart Sending setting change log found</strong><br>
            <br><strong>What this checks:</strong> Whether the Smart Sending window was ever changed on this account.<br>
            <br><strong>Possible reasons:</strong>
            <ul>
              <li>Smart Sending settings haven't been changed within this time range — try widening to 90d or a full year</li>
              <li>Smart Sending is still at its default setting and was never manually updated</li>
            </ul>
            <strong>Next steps:</strong>
            <ul>
              <li>Check the account's sending settings directly in Staffside to see the current Smart Sending window</li>
              <li>Check the profile's send history — when did they last receive a Klaviyo message from this account?</li>
            </ul>`
        };
        // Parse key values from the log message
        // Format: Updating Smart Sending company_id=X message_type=sms flow_setting=48 campaign_setting=48
        let messageType = null, flowSetting = null, campaignSetting = null, changedAt = null;
        for (const s of (r.summaries || [])) {
          if (!messageType)    { const m = s.match(/message_type=(\S+)/);    if (m) messageType = m[1]; }
          if (!flowSetting)    { const m = s.match(/flow_setting=(\d+)/);    if (m) flowSetting = m[1]; }
          if (!campaignSetting){ const m = s.match(/campaign_setting=(\d+)/);if (m) campaignSetting = m[1]; }
          if (!changedAt)      { const m = s.match(/(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})/); if (m) changedAt = m[1]; }
        }
        const channel   = messageType   ? `<br>📡 <strong>Channel:</strong> <code>${messageType}</code>` : '';
        const flowWin   = flowSetting   ? `<br>⏱ <strong>Flow Smart Sending window:</strong> <code>${flowSetting} hours</code>` : '';
        const campWin   = campaignSetting ? `<br>⏱ <strong>Campaign Smart Sending window:</strong> <code>${campaignSetting} hours</code>` : '';
        const when      = changedAt     ? `<br>🕐 <strong>Setting changed at:</strong> <code>${changedAt} UTC</code>` : '';
        return {
          status: 'pass',
          message: `<strong>Smart Sending setting change log found ✅</strong>${channel}${flowWin}${campWin}${when}
            <br><br><strong>What this means:</strong> Use the window values above to determine if this profile was held back from receiving a message due to Smart Sending — check when they last received a message and whether it falls within the window.`
        };
      }
    },
    // KB query: index="klaviyo" "campaign_id" error
    sms_failure: {
      query: `index="klaviyo" "${campaignId}" error`,
      label: 'SMS send failure log',
      interpret(r) {
        if (r.noResults) return {
          status: 'warn',
          message: `<strong>No send failure log found for this campaign</strong><br>
            <br><strong>Possible reasons:</strong>
            <ul>
              <li>The campaign sent successfully with no errors</li>
              <li>The failure occurred outside the current time range — try widening to 90d or year to date</li>
              <li>The campaign has not yet been sent</li>
            </ul>
            <strong>Next steps:</strong>
            <ul>
              <li>Verify the Campaign ID is correct</li>
              <li>Check the campaign send status in the account</li>
              <li>If failures are expected but not showing, try a wider time range</li>
            </ul>`
        };
        // Collect unique error descriptions and codes across captured summaries
        const descriptions = new Set();
        const errorCodes   = new Set();
        const normKeys     = new Set();
        let errorAt = null;
        for (const s of (r.summaries || [])) {
          const desc = s.match(/"description"\s*:\s*"([^"]+)"/);  if (desc) descriptions.add(desc[1]);
          const ec   = s.match(/"error_code"\s*:\s*"([^"]+)"/);   if (ec)   errorCodes.add(ec[1]);
          const nk   = s.match(/"normalized_key"\s*:\s*"([^"]+)"/);if (nk)  normKeys.add(nk[1]);
          if (!errorAt) { const ts = s.match(/"timestamp"\s*:\s*"([^"]+)"/); if (ts) errorAt = ts[1].replace('T', ' ').replace(/\.\d+Z?$/, ''); }
        }
        const descBlock  = descriptions.size ? `<br>📋 <strong>Description:</strong> ${[...descriptions].map(d => `<code>${d}</code>`).join(', ')}` : '';
        const ecBlock    = errorCodes.size   ? `<br>❌ <strong>Error code:</strong> ${[...errorCodes].map(e => `<code>${e}</code>`).join(', ')}` : '';
        const nkBlock    = normKeys.size     ? `<br>🔑 <strong>Normalised key:</strong> ${[...normKeys].map(k => `<code>${k}</code>`).join(', ')}` : '';
        const whenBlock  = errorAt           ? `<br>🕐 <strong>First error at:</strong> <code>${errorAt} UTC</code>` : '';
        const countNote  = parseInt(r.count) > 8 ? `<br>⚠️ <strong>${r.count} total error events</strong> — raw logs below show the first 8. View in Splunk for the full list.` : '';
        return {
          status: 'fail',
          message: `<strong>Send failure log found</strong>${descBlock}${ecBlock}${nkBlock}${whenBlock}${countNote}
            <br><br>If the error is a carrier or infrastructure issue, escalate to the <strong>SMS/Messaging</strong> team.`
        };
      }
    }
  };

  const s = scenarios[scenario] || {
    query: `company_id="${accountId}" campaign_id="${campaignId}"`,
    label: 'campaign log',
    noResultsMsg: `<strong>No campaign log found in this time range.</strong><br>Try widening the time range to 30d or 90d.`,
    foundMsg: `<strong>Campaign logs found.</strong><br>Expand raw logs to review.`
  };

  // Manual steps (e.g. "created" — requires Staffside "View Splunk Logs" workflow)
  if (s.manual) {
    return [{
      tool: 'splunk',
      manual: true,
      label: s.label,
      manualNote: s.manualNote
    }];
  }

  return [{
    tool: 'splunk',
    label: s.label,
    query: s.query,
    interpret: s.interpret || function(r) {
      if (r.noResults) return { status: 'warn', message: s.noResultsMsg };
      return { status: 'pass', message: `${s.foundMsg}<br><br><em>Found ${r.count} log entries — expand raw logs below.</em>` };
    }
  }];
}

// ── LISTS & PROFILES (Splunk) ─────────────────────────────────────────────────
function buildListProfileSteps(scenario, fields, timeRange) {
  const { accountId, profileId, listId, segmentId } = fields;

  // ── SUPPRESSION — multi-step (one step per selected check) ─────────────────
  if (scenario === 'suppression') {
    const suppressionChecks = fields.suppressionChecks || ['account_level'];

    const checkDefs = {
      // 1. Account-level: broad account suppression log
      account_level: {
        label: 'Account-level suppression',
        query: `suppression ${accountId} index=prod`,
        interpret(r) {
          if (r.noResults) return {
            status: 'warn',
            message: `<strong>No account-level suppression log found</strong><br>
              <br><strong>Possible reasons:</strong>
              <ul>
                <li>No suppression events have been logged for this account in this time range</li>
                <li>The suppression occurred more than 90 days ago</li>
                <li>The Account ID may be incorrect</li>
              </ul>
              <strong>Next steps:</strong>
              <ul>
                <li>Try widening the time range to 90d</li>
                <li>Run the "Profile manual suppression" check with a Profile ID to narrow results</li>
                <li>Check the profile's current subscription status directly in the account</li>
              </ul>`
          };
          return {
            status: 'pass',
            message: `<strong>Account-level suppression log found ✅</strong><br>
              <br>Found <strong>${r.count}</strong> suppression event(s) for this account. Expand raw logs to see:<br>
              <ul>
                <li>Which profiles were suppressed and when</li>
                <li>The suppression reason (hard bounce, spam complaint, manual, Subscription Protection)</li>
                <li>Whether it was a user action, system action, or API call</li>
              </ul>
              <strong>Note:</strong> A suppressed profile will not receive any marketing emails regardless of flow/campaign settings.`
          };
        }
      },

      // 2. Profile manual: nginx access log — POST to /ajax/profile/PROFILEID/suppress
      //    sourcetype: access_combined_wcookie
      //    Fields available: timestamp, method, URI, HTTP status, referer, cid, IP
      //    Note: no username in this log — use "Who suppressed?" check for post-Oct 2025 user attribution
      profile_manual: {
        label: 'Profile manual suppression',
        query: `"${profileId}" index=prod suppress`,
        interpret(r) {
          if (r.noResults) return {
            status: 'warn',
            message: `<strong>No suppression request log found for this profile</strong><br>
              <br><strong>Possible reasons:</strong>
              <ul>
                <li>The profile was not manually suppressed via the Klaviyo UI or API — it may have been suppressed via a hard bounce or spam complaint</li>
                <li>The suppression occurred more than 90 days ago</li>
                <li>The Profile ID may be incorrect</li>
              </ul>
              <strong>Next steps:</strong>
              <ul>
                <li>Try widening the time range to 90d</li>
                <li>Run the <strong>Account-level suppression</strong> check to see all suppression events for this account</li>
                <li>Check the profile's activity timeline for "Email Bounced" or "Marked as Spam" events</li>
                <li>For post-October 2025 suppressions, run the <strong>Who suppressed?</strong> check which uses a newer log format</li>
              </ul>`
          };

          // This is a nginx access log (access_combined_wcookie).
          // Log format: IP - - [timestamp] "METHOD /path HTTP/x" STATUS BYTES "referer" "user-agent" cid=X
          let method = null, status = null, uri = null, referer = null, ip = null,
              cid = null, suppressedAt = null, uriProfileId = null;

          for (const s of (r.summaries || [])) {
            // Timestamp from Splunk-parsed log header (DD/Mon/YYYY:HH:MM:SS) or ISO
            if (!suppressedAt) {
              const m = s.match(/\[(\d{2}\/\w+\/\d{4}:\d{2}:\d{2}:\d{2})/);
              if (m) {
                // Convert "23/May/2026:11:10:52" → "2026-05-23 11:10:52"
                const months = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
                                Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};
                const p = m[1].match(/(\d{2})\/(\w+)\/(\d{4}):(\d{2}:\d{2}:\d{2})/);
                if (p) suppressedAt = `${p[3]}-${months[p[2]]||p[2]}-${p[1]} ${p[4]}`;
              }
              // Fallback: ISO timestamp
              if (!suppressedAt) { const m2 = s.match(/(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/); if (m2) suppressedAt = m2[1].replace('T',' '); }
            }
            // HTTP method and URI: "POST /ajax/profile/ID/suppress HTTP/1.1"
            if (!method) {
              const m = s.match(/"(GET|POST|PUT|DELETE|PATCH)\s+(\/[^\s"]+)/i);
              if (m) { method = m[1]; uri = m[2]; }
            }
            // HTTP status code (e.g. 200, 400)
            if (!status) { const m = s.match(/"[A-Z]+\s+\/[^"]*"\s+(\d{3})/); if (m) status = m[1]; }
            // Referer URL
            if (!referer) { const m = s.match(/"(https?:\/\/[^"]+)"\s+"Mozilla/i); if (m) referer = m[1]; }
            // Company ID from cid= field
            if (!cid)    { const m = s.match(/\bcid[=\s]+"?([A-Za-z0-9]+)/i); if (m) cid = m[1]; }
            // IP address (first token of access log)
            if (!ip)     { const m = s.match(/^(\d{1,3}(?:\.\d{1,3}){3})/); if (m) ip = m[1]; }
          }

          // Parse the suppressed profile ID from the URI if present
          if (uri) { const m = uri.match(/\/profile\/([^/]+)\/suppress/i); if (m) uriProfileId = m[1]; }

          // Build referer label — e.g. "profile lists and segments page"
          let refererLabel = referer || null;
          if (referer) {
            if (referer.includes('/lists')) refererLabel = 'Profile → Lists & Segments page';
            else if (referer.includes('/profile')) refererLabel = 'Profile detail page';
            else if (referer.includes('/people')) refererLabel = 'People / Profiles list';
          }

          const statusOk    = status === '200';
          const methodBlock = method ? `<br>📡 <strong>Request:</strong> <code>${method} /ajax/profile/.../suppress</code>` : '';
          const statusBlock = status ? `<br>${statusOk ? '✅' : '⚠️'} <strong>HTTP status:</strong> <code>${status}</code>${statusOk ? ' (success)' : ' — request may have failed'}` : '';
          const whenBlock   = suppressedAt ? `<br>🕐 <strong>Suppressed at:</strong> <code>${suppressedAt} UTC</code>` : '';
          const refBlock    = refererLabel  ? `<br>🖥️ <strong>Triggered from:</strong> ${refererLabel}` : '';
          const ipBlock     = ip            ? `<br>🌐 <strong>IP address:</strong> <code>${ip}</code>` : '';
          const cidBlock    = cid           ? `<br>🏢 <strong>Account ID (cid):</strong> <code>${cid}</code>` : '';
          const countNote   = parseInt(r.count) > 1
            ? `<br><br>⚠️ <strong>${r.count} events found</strong> — showing most recent. Expand raw logs for full history.`
            : '';

          return {
            status: 'pass',
            message: `<strong>Profile suppression request log found ✅</strong>
              ${whenBlock}${methodBlock}${statusBlock}${refBlock}${cidBlock}${ipBlock}${countNote}
              <br><br><em style="font-size:11px;color:var(--text-secondary)">ℹ️ This is an HTTP access log — it confirms a suppress action was made but does not record the user's name. Run the <strong>Who suppressed?</strong> check for user attribution (post-Oct 2025 only).</em>`
          };
        }
      },

      // 3. Who suppressed (post Oct 2025): add_global_manual_exclusion log
      who_suppressed: {
        label: 'Who suppressed? (post Oct 2025)',
        query: `"add_global_manual_exclusion" company_id=${accountId} "${profileId}"`,
        interpret(r) {
          if (r.noResults) return {
            status: 'warn',
            message: `<strong>No "add_global_manual_exclusion" log found</strong><br>
              <br><strong>What this checks:</strong> Suppression events logged with the new format introduced in October 2025.<br>
              <br><strong>Possible reasons:</strong>
              <ul>
                <li>The suppression happened before October 2025 — use the "Account-level" or "Profile manual" checks instead</li>
                <li>The profile was not manually suppressed — it may have been suppressed via a bounce or spam event</li>
                <li>The time range doesn't cover when the suppression occurred — try widening to 90d</li>
              </ul>`
          };
          // Parse who suppressed, when, and how
          let suppressor = null, suppressedAt = null, method = null;
          for (const s of (r.summaries || [])) {
            if (!suppressor)  { const m = s.match(/\buser(?:_id)?[=:\s]+"?([^"\s,}]+)/i); if (m) suppressor = m[1]; }
            if (!method)      { const m = s.match(/\bsource[=:\s]+"?([^"\s,}"]+)/i); if (m) method = m[1]; }
            if (!suppressedAt){ const m = s.match(/(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})/); if (m) suppressedAt = m[1]; }
          }
          const whoBlock  = suppressor  ? `<br>👤 <strong>Suppressed by user_id:</strong> <code>${suppressor}</code>
            <br><a href="https://www.klaviyo.com/staff/search?q=${suppressor}" target="_blank" class="step-action" style="display:inline-block;margin:6px 0 2px">🔍 Look up user in Staffside →</a>`
            : `<br>👤 <strong>Initiating user:</strong> not extracted — expand raw logs`;
          const whenBlock = suppressedAt? `<br>🕐 <strong>Suppressed at:</strong> <code>${suppressedAt} UTC</code>` : '';
          const howBlock  = method      ? `<br>⚙️ <strong>Source:</strong> <code>${method}</code>` : '';
          return {
            status: 'pass',
            message: `<strong>Manual suppression log found ✅ (post Oct 2025 format)</strong>${whoBlock}${whenBlock}${howBlock}
              <br><br>Expand raw logs for full details.`
          };
        }
      },

      // 4. Bulk suppression: spawn host log
      bulk: {
        label: 'Bulk suppression',
        query: `${accountId} host="qw-bulk-profile-suppression-spawn*" user`,
        interpret(r) {
          if (r.noResults) return {
            status: 'warn',
            message: `<strong>No bulk suppression log found</strong><br>
              <br><strong>What this checks:</strong> Bulk suppression jobs run for this account (e.g., from a CSV import of suppressed emails).<br>
              <br><strong>Possible reasons:</strong>
              <ul>
                <li>No bulk suppression job was run for this account in this time range</li>
                <li>The bulk suppression occurred more than 90 days ago</li>
              </ul>
              <strong>Next steps:</strong>
              <ul>
                <li>Try widening the time range to 90d</li>
                <li>Check if the customer uploaded a suppression list via the account settings recently</li>
              </ul>`
          };
          // Extract user who ran the bulk suppression and timestamp
          let userId = null, ranAt = null, profileCount = null;
          for (const s of (r.summaries || [])) {
            if (!userId)      { const m = s.match(/\buser(?:_id)?[=:\s]+"?([^"\s,}]+)/i); if (m) userId = m[1]; }
            if (!ranAt)       { const m = s.match(/(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})/); if (m) ranAt = m[1]; }
            if (!profileCount){ const m = s.match(/\bcount[=:\s]+(\d+)/i); if (m) profileCount = m[1]; }
          }
          const userBlock  = userId      ? `<br>👤 <strong>Initiated by user_id:</strong> <code>${userId}</code>
            <br><a href="https://www.klaviyo.com/staff/search?q=${userId}" target="_blank" class="step-action" style="display:inline-block;margin:6px 0 2px">🔍 Look up user in Staffside →</a>`
            : '';
          const whenBlock  = ranAt       ? `<br>🕐 <strong>Ran at:</strong> <code>${ranAt} UTC</code>` : '';
          const countBlock = profileCount? `<br>📊 <strong>Profiles in batch:</strong> <code>${profileCount}</code>` : '';
          return {
            status: 'pass',
            message: `<strong>Bulk suppression job found ✅</strong>${userBlock}${whenBlock}${countBlock}
              <br><br>Found <strong>${r.count}</strong> log event(s). Expand raw logs for full details.`
          };
        }
      },

      // 5. 90-day window: was suppression ignored because of an existing 90-day window?
      existing_90day: {
        label: '90-day suppression window',
        query: `"SUBSCRIPTIONS: Suppression request for customer=${profileId} in company=${accountId} ignored due to existing suppression in the last 90 days"`,
        interpret(r) {
          if (r.noResults) return {
            status: 'pass',
            message: `<strong>No 90-day suppression window hit ✅</strong><br>
              <br>No log found indicating a suppression request was ignored due to an existing suppression within the last 90 days.<br>
              <br><strong>What this means:</strong> The profile was not recently re-suppressed after being unsuppressed within 90 days. This is not the cause of their suppression issue.<br>
              <br><strong>Note:</strong> Klaviyo ignores new suppression requests for profiles that were already suppressed within the last 90 days to prevent re-suppression loops.`
          };
          let ignoredAt = null;
          for (const s of (r.summaries || [])) {
            if (!ignoredAt){ const m = s.match(/(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})/); if (m) ignoredAt = m[1]; }
          }
          const whenBlock = ignoredAt ? `<br>🕐 <strong>Request ignored at:</strong> <code>${ignoredAt} UTC</code>` : '';
          return {
            status: 'fail',
            message: `<strong>90-day suppression window triggered ⚠️</strong>${whenBlock}
              <br><br><strong>What this means:</strong> A suppression request for this profile was <em>ignored</em> because the profile was already suppressed within the last 90 days.<br>
              <br><strong>What this does NOT mean:</strong> The profile is not suppressed — they are still suppressed from the original event. This log just shows an attempt to suppress them again was blocked.<br>
              <br><strong>Next steps:</strong>
              <ul>
                <li>Check the original suppression event using the other checks</li>
                <li>If the customer wants to re-subscribe the profile, they should unsuppress them from the account and ensure they re-confirm consent</li>
              </ul>`
          };
        }
      },

      // 6. List growth: suppressed profiles removed from a list
      list_growth: {
        label: 'List growth — suppressed profiles',
        query: `"removing suppressed profiles" ${accountId} ${listId}`,
        interpret(r) {
          if (r.noResults) return {
            status: 'warn',
            message: `<strong>No "removing suppressed profiles" log found for this list</strong><br>
              <br><strong>What this checks:</strong> Whether Klaviyo removed suppressed profiles from the list during a list growth job — which can cause unexpected list size changes.<br>
              <br><strong>Possible reasons:</strong>
              <ul>
                <li>No suppressed profiles were removed from this list in the current time range</li>
                <li>The removal occurred more than 90 days ago</li>
                <li>The List ID may be incorrect</li>
              </ul>
              <strong>Next steps:</strong>
              <ul>
                <li>Try widening the time range to 90d</li>
                <li>Verify the List ID is correct</li>
                <li>If the list count dropped unexpectedly, also check for list merges and profile deletions</li>
              </ul>`
          };
          let removedCount = null, ranAt = null;
          for (const s of (r.summaries || [])) {
            if (!removedCount){ const m = s.match(/removing suppressed profiles.*?(\d+)/i); if (m) removedCount = m[1]; }
            if (!ranAt)       { const m = s.match(/(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})/); if (m) ranAt = m[1]; }
          }
          const countBlock = removedCount? `<br>📊 <strong>Profiles removed:</strong> <code>${removedCount}</code>` : '';
          const whenBlock  = ranAt       ? `<br>🕐 <strong>Job ran at:</strong> <code>${ranAt} UTC</code>` : '';
          return {
            status: 'pass',
            message: `<strong>Suppressed profiles removed from list ✅</strong>${countBlock}${whenBlock}
              <br><br>Found <strong>${r.count}</strong> log event(s). This explains why the list count decreased — Klaviyo removed suppressed profiles during a list growth job.<br>
              <br><strong>Note:</strong> This is expected behaviour — suppressed profiles are automatically removed to keep lists clean and compliant.`
          };
        }
      }
    };

    return suppressionChecks
      .filter(id => checkDefs[id])
      .map(id => ({
        tool: 'splunk',
        label: checkDefs[id].label,
        query: checkDefs[id].query,
        interpret: checkDefs[id].interpret
      }));
  }

  const scenarios = {
    // KB query: "profile_deletion_audit" "account=[account id]" plus optional profile ID
    profile_deleted: {
      query: `"profile_deletion_audit" "account=${accountId}"${profileId ? ` "${profileId}"` : ''}`,
      label: 'Profile deletion log',
      interpret(r) {
        if (r.noResults) return {
          status: 'warn',
          message: `<strong>No profile deletion log found</strong><br>
            <br><strong>Possible reasons:</strong>
            <ul>
              <li>The profile was not deleted — it may still exist under a different ID (check for email or phone merges)</li>
              <li>Deletion occurred more than 90 days ago — Splunk only retains logs for 90 days</li>
              ${profileId ? `<li>The Profile ID may be incorrect — try searching with Account ID only to see all deletions</li>` : ''}
            </ul>
            <strong>Next steps:</strong>
            <ul>
              <li>Try widening the time range to 90d</li>
              <li>Search with Account ID only to see all recent deletions for this account</li>
              ${profileId ? `<li>Try the alternate query: <code>"profile_deleted_pipeline" "${profileId}"</code></li>` : ''}
            </ul>`
        };
        // Parse all key fields from the log: category=X command=X user=X profile=X account=X comment=X
        const categoryLabels = {
          view:             'Deleted via Klaviyo UI',
          api:              'Deleted via private API (privacy deletion request)',
          mgmt_command:     'Deleted by dev team via management command',
          staffside:        'Deleted by Klaviyo staff via Staffside tool',
          profile_merging:  'Deleted as result of a profile merge'
        };
        let category = null, command = null, userId = null, profileFound = null, comment = null, deletedAt = null;
        for (const s of (r.summaries || [])) {
          if (!category)     { const m = s.match(/\bcategory=(\S+)/);  if (m) category = m[1]; }
          if (!command)      { const m = s.match(/\bcommand=(\S+)/);   if (m) command = m[1]; }
          if (!userId)       { const m = s.match(/\buser=(\S+)/);      if (m) userId = m[1]; }
          if (!profileFound) { const m = s.match(/\bprofile=(\S+)/);   if (m) profileFound = m[1]; }
          if (!comment)      { const m = s.match(/\bcomment=(\S+)/);   if (m) comment = m[1]; }
          if (!deletedAt)    { const m = s.match(/(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})/); if (m) deletedAt = m[1]; }
        }
        const catLabel    = categoryLabels[category] || (category ? `<code>${category}</code>` : null);
        const howBlock    = catLabel    ? `<br>🗂 <strong>Deletion type:</strong> ${catLabel}` : '';
        const profileBlock= profileFound? `<br>🆔 <strong>Profile ID:</strong> <code>${profileFound}</code>` : '';
        const cmdBlock    = command     ? `<br>⚙️ <strong>Command:</strong> <code>${command}</code>` : '';
        const commentBlock= comment     ? `<br>💬 <strong>Comment:</strong> <code>${comment}</code>${comment === 'non-gdpr' ? ' (standard deletion, not a GDPR request)' : comment === 'gdpr' ? ' ⚠️ GDPR/privacy deletion' : ''}` : '';
        const timeBlock   = deletedAt   ? `<br>🕐 <strong>Deleted at:</strong> <code>${deletedAt} UTC</code>` : '';
        const userBlock   = userId
          ? `<br>👤 <strong>Initiated by user_id:</strong> <code>${userId}</code>
             <br><a href="https://www.klaviyo.com/staff/search?q=${userId}" target="_blank" class="step-action" style="display:inline-block;margin:6px 0 2px">🔍 Look up user in Staffside →</a>
             <br><em style="font-size:11px;color:var(--text-secondary)">If this user's company ID is 9BX3wh in Staffside, a Klaviyo staff member performed the deletion.</em>`
          : `<br>👤 <strong>User:</strong> not recorded (API or management command)`;
        const countNote   = parseInt(r.count) > 1 ? `<br><br>⚠️ <strong>${r.count} deletion events found</strong> — showing the most recent. Expand raw logs to see all.` : '';
        return {
          status: 'pass',
          message: `<strong>Profile deletion log found ✅</strong>${howBlock}${userBlock}${profileBlock}${cmdBlock}${commentBlock}${timeBlock}${countNote}`
        };
      }
    },
    // Log format: "Setting to Single Opt In: List Settings change launched by User: XvddZs for list UKfguL with company_id RuUwRn"
    // List ID is required for this scenario — query scoped directly to the list
    optin_log: {
      query: `("Setting to Single Opt" OR "Setting to Double Opt") ${listId}`,
      interpret(r) {
        if (r.noResults) return {
          status: 'warn',
          message: `<strong>No list opt-in setting change log found</strong><br>
            <br><strong>Possible reasons:</strong>
            <ul>
              <li>The opt-in setting has not been changed within this time range</li>
              <li>The List ID may be incorrect, or the list was deleted</li>
              <li>The change occurred more than 90 days ago</li>
            </ul>
            <strong>Next steps:</strong>
            <ul>
              <li>Check the current opt-in setting on the list in the account</li>
              <li>Try widening the time range to 90d</li>
              ${listId ? `<li>Verify the List ID <code>${listId}</code> is correct</li>` : `<li>Add a List ID to narrow the results to a specific list</li>`}
            </ul>`
        };

        // Full raw log line format (django:app, supervisord):
        // "YYYY-MM-DD HH:MM:SS,mmm INFO tx_id=UUID Setting to Single Opt In: List Settings change launched by User: USERID for list LISTID with company_id ACCOUNTID"
        let optType = null, userId = null, listFound = null, companyFound = null, changedAt = null, txId = null;
        for (const s of (r.summaries || [])) {
          if (!optType)     { const m = s.match(/Setting to (Single Opt(?:\s*In)?|Double Opt(?:\s*In)?)/i); if (m) optType = m[1].replace(/\s*In\s*$/i, ' In'); }
          if (!userId)      { const m = s.match(/launched by User:\s*(\S+)/i); if (m) userId = m[1]; }
          if (!listFound)   { const m = s.match(/for list\s+(\S+)/i); if (m) listFound = m[1]; }
          if (!companyFound){ const m = s.match(/company_id\s+(\S+)/i); if (m) companyFound = m[1]; }
          if (!txId)        { const m = s.match(/tx_id=([\w-]+)/i); if (m) txId = m[1]; }
          if (!changedAt)   {
            // Raw line starts with "YYYY-MM-DD HH:MM:SS,mmm" — capture date + time
            const m = s.match(/(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/);
            if (m) changedAt = m[1].replace('T', ' ');
          }
        }

        const optEmoji    = optType && optType.toLowerCase().includes('double') ? '🔒' : '🔓';
        const optLabel    = optType ? `${optEmoji} <strong>Changed to:</strong> <code>${optType}</code>` : '';
        const whenBlock   = changedAt    ? `<br>🕐 <strong>Changed at:</strong> <code>${changedAt} UTC</code>` : '';
        const listBlock   = listFound    ? `<br>📋 <strong>List ID:</strong> <code>${listFound}</code>` : '';
        const compBlock   = companyFound ? `<br>🏢 <strong>Account ID:</strong> <code>${companyFound}</code>` : '';
        const txBlock     = txId         ? `<br>🔑 <strong>Transaction ID:</strong> <code>${txId}</code>` : '';
        const userBlock   = userId
          ? `<br>👤 <strong>Changed by user_id:</strong> <code>${userId}</code>
             <br><a href="https://www.klaviyo.com/staff/search?q=${userId}" target="_blank" class="step-action" style="display:inline-block;margin:6px 0 2px">🔍 Look up user in Staffside →</a>
             <br><em style="font-size:11px;color:var(--text-secondary)">If this user's company ID is 9BX3wh in Staffside, a Klaviyo staff member made the change.</em>`
          : `<br>👤 <strong>Changed by:</strong> not recorded`;
        const countNote   = parseInt(r.count) > 1
          ? `<br><br>⚠️ <strong>${r.count} change events found</strong> — showing the most recent. Expand raw logs to see full history.`
          : '';

        return {
          status: 'pass',
          message: `<strong>List opt-in setting change log found ✅</strong>
            <br>${optLabel}${whenBlock}${listBlock}${compBlock}${userBlock}${txBlock}${countNote}
            <br><br><strong>What this means:</strong>
            <ul>
              ${optType && optType.toLowerCase().includes('double')
                ? `<li><strong>Double Opt-In</strong>: new subscribers must confirm via email before being added to the list. Profiles that don't confirm will show as "Pending" and will not receive messages.</li>`
                : `<li><strong>Single Opt-In</strong>: subscribers are added to the list immediately without a confirmation step.</li>`}
            </ul>`
        };
      }
    },
    // Log format (django:app): "tx_id=UUID Updating segment definition for group SEGID in company ACCOUNTID"
    // Segment ID is required — query scoped directly to the segment
    segment_change: {
      query: `"Updating segment definition for group" "${segmentId}"`,
      interpret(r) {
        if (r.noResults) return {
          status: 'warn',
          message: `<strong>No segment definition change log found</strong><br>
            <br><strong>Possible reasons:</strong>
            <ul>
              <li>The segment definition has not been changed within this time range</li>
              <li>The change occurred more than 90 days ago</li>
              <li>The Segment ID may be incorrect</li>
            </ul>
            <strong>Next steps:</strong>
            <ul>
              <li>Try widening the time range to 90d</li>
              ${segmentId ? `<li>Verify the Segment ID <code>${segmentId}</code> is correct</li>` : ''}
              <li>Use the <strong>Segment Membership Debugger</strong> to check if the profile currently qualifies: <a href="https://www.klaviyo.com/staff/segment-debugger" target="_blank">staff/segment-debugger</a></li>
              <li>Note: these logs only show WHEN a definition change was made — not what it was before</li>
            </ul>`
        };

        // Parse from message field: "tx_id=UUID Updating segment definition for group SEGID in company ACCOUNTID"
        let segFound = null, companyFound = null, txId = null, changedAt = null;
        for (const s of (r.summaries || [])) {
          if (!txId)        { const m = s.match(/tx_id=([\w-]+)/);                               if (m) txId = m[1]; }
          if (!segFound)    { const m = s.match(/for group\s+(\S+)/i);                           if (m) segFound = m[1]; }
          if (!companyFound){ const m = s.match(/in company\s+(\S+)/i);                          if (m) companyFound = m[1]; }
          if (!changedAt)   { const m = s.match(/(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/);  if (m) changedAt = m[1].replace('T', ' ').replace('.', ' ').slice(0, 19); }
        }

        const segBlock     = segFound     ? `<br>🔲 <strong>Segment ID:</strong> <code>${segFound}</code>` : '';
        const compBlock    = companyFound  ? `<br>🏢 <strong>Account ID:</strong> <code>${companyFound}</code>` : '';
        const txBlock      = txId          ? `<br>🔑 <strong>Transaction ID:</strong> <code>${txId}</code>` : '';
        const whenBlock    = changedAt     ? `<br>🕐 <strong>Changed at:</strong> <code>${changedAt} UTC</code>` : '';
        const countNote    = parseInt(r.count) > 1
          ? `<br><br>⚠️ <strong>${r.count} change events found</strong> — showing the most recent. Expand raw logs to see full history.`
          : '';

        return {
          status: 'pass',
          message: `<strong>Segment definition change log found ✅</strong>${whenBlock}${segBlock}${compBlock}${txBlock}${countNote}
            <br><br>⚠️ <strong>Note:</strong> This log confirms <em>that</em> the segment definition was changed, but does not record <em>what</em> it was before the change, or which user made it.
            <br><br>To check if a specific profile currently qualifies, use the <a href="https://www.klaviyo.com/staff/segment-debugger" target="_blank">Segment Membership Debugger →</a>`
        };
      }
    },
    // Log format (django:app): "YYYY-MM-DD HH:MM:SS,mmm INFO tx_id=UUID Starting list merge with company=ACCOUNTID task_id=TASKID source_list_ids=SOURCEID destination_list_id=DESTID initiated_by=USERID delete_source_lists=True/False"
    // Splunk also extracts: campaign, company, delete_source_lists, destination_list_id, initiated_by, source_list_ids, task_id, tx_id
    list_merge: {
      query: `index=klaviyo "Starting list merge with" company=${accountId}`,
      interpret(r) {
        if (r.noResults) return {
          status: 'warn',
          message: `<strong>No list merge log found in this time range</strong><br>
            <br><strong>Next steps:</strong>
            <ul>
              <li>Try widening the time range to 90d</li>
              <li>Check if the profile appears in unexpected lists — this can indicate a merge occurred outside this window</li>
              <li>A list merge moves all profiles from the source list(s) to the destination list</li>
            </ul>`
        };

        // Parse from raw log line:
        // "YYYY-MM-DD HH:MM:SS,mmm INFO tx_id=UUID Starting list merge with company=ACCOUNTID task_id=TASKID source_list_ids=SOURCEID destination_list_id=DESTID initiated_by=USERID delete_source_lists=True/False"
        let mergedAt = null, txId = null, companyFound = null, taskId = null;
        let sourceListIds = null, destListId = null, initiatedBy = null, deleteSource = null;

        for (const s of (r.summaries || [])) {
          if (!mergedAt)     { const m = s.match(/(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/);  if (m) mergedAt = m[1].replace('T', ' '); }
          if (!txId)         { const m = s.match(/tx_id=([\w-]+)/);                               if (m) txId = m[1]; }
          if (!companyFound) { const m = s.match(/company=(\S+)/);                                if (m) companyFound = m[1]; }
          if (!taskId)       { const m = s.match(/task_id=(\d+)/);                                if (m) taskId = m[1]; }
          if (!sourceListIds){ const m = s.match(/source_list_ids=(\S+)/);                        if (m) sourceListIds = m[1]; }
          if (!destListId)   { const m = s.match(/destination_list_id=(\S+)/);                    if (m) destListId = m[1]; }
          if (!initiatedBy)  { const m = s.match(/initiated_by=(\S+)/);                           if (m) initiatedBy = m[1]; }
          if (!deleteSource) { const m = s.match(/delete_source_lists=(True|False)/i);            if (m) deleteSource = m[1]; }
        }

        const whenBlock    = mergedAt     ? `<br>🕐 <strong>Merged at:</strong> <code>${mergedAt} UTC</code>` : '';
        const sourceBlock  = sourceListIds? `<br>📤 <strong>Source list(s):</strong> <code>${sourceListIds}</code> <em style="color:var(--text-secondary);font-size:11px">(merged FROM)</em>` : '';
        const destBlock    = destListId   ? `<br>📥 <strong>Destination list:</strong> <code>${destListId}</code> <em style="color:var(--text-secondary);font-size:11px">(merged INTO)</em>` : '';
        const compBlock    = companyFound  ? `<br>🏢 <strong>Account ID:</strong> <code>${companyFound}</code>` : '';
        const deleteBlock  = deleteSource  ? `<br>${deleteSource === 'True' ? '🗑' : '📌'} <strong>Source list deleted after merge:</strong> <code>${deleteSource}</code>` : '';
        const taskBlock    = taskId        ? `<br>⚙️ <strong>Task ID:</strong> <code>${taskId}</code>` : '';
        const txBlock      = txId          ? `<br>🔑 <strong>Transaction ID:</strong> <code>${txId}</code>` : '';
        const userBlock    = initiatedBy
          ? `<br>👤 <strong>Initiated by user_id:</strong> <code>${initiatedBy}</code>
             <br><a href="https://www.klaviyo.com/staff/search?q=${initiatedBy}" target="_blank" class="step-action" style="display:inline-block;margin:6px 0 2px">🔍 Look up user in Staffside →</a>
             <br><em style="font-size:11px;color:var(--text-secondary)">If this user's company ID is 9BX3wh in Staffside, a Klaviyo staff member initiated the merge.</em>`
          : '';
        const countNote    = parseInt(r.count) > 1
          ? `<br><br>⚠️ <strong>${r.count} merge events found</strong> — showing the most recent. Expand raw logs to see full history.`
          : '';

        return {
          status: 'pass',
          message: `<strong>List merge log found ✅</strong>${whenBlock}${sourceBlock}${destBlock}${compBlock}${userBlock}${deleteBlock}${taskBlock}${txBlock}${countNote}
            <br><br>⚠️ <strong>Important:</strong> Profiles added via a list merge will <strong>not</strong> trigger list-based flows on the destination list — this is by design.`
        };
      }
    }
  };

  const s = scenarios[scenario] || {
    query: `company_id="${accountId}" profile_id="${profileId}"`,
    noResultsMsg: `<strong>No log found in this time range.</strong><br>Try widening the time range.`,
    foundMsg: `<strong>Logs found.</strong><br>Expand raw logs to review.`
  };

  return [{
    tool: 'splunk',
    label: s.label || 'Profile / List log check',
    query: s.query,
    interpret: s.interpret || function(r) {
      if (r.noResults) return { status: 'warn', message: s.noResultsMsg };
      return { status: 'pass', message: `${s.foundMsg}<br><br><em>Found ${r.count} log entries — expand raw logs below.</em>` };
    }
  }];
}

// ── BILLING (Splunk) ──────────────────────────────────────────────────────────
function buildBillingSteps(scenario, fields, timeRange) {
  const { accountId } = fields;

  if (scenario === 'back_in_stock') {
    return [{
      tool: 'splunk',
      query: `company_id="${accountId}" "back_in_stock_min_inventory" OR "back_in_stock_settings"`,
      interpret(r) {
        if (r.noResults) return {
          status: 'warn',
          message: `<strong>No Back in Stock inventory setting change log found</strong><br>
            <br><strong>Possible reasons:</strong>
            <ul>
              <li>The Back in Stock minimum inventory setting has not been changed within this time range</li>
              <li>Try widening to 90d</li>
            </ul>
            <strong>Next steps:</strong>
            <ul>
              <li>Check the current Back in Stock settings in the account's settings page</li>
              <li>Verify the integration that manages back-in-stock inventory signals is active</li>
            </ul>`
        };
        return {
          status: 'pass',
          message: `<strong>Back in Stock setting change log found ✅</strong><br>
            <br>Expand the raw logs to see when the minimum inventory setting was changed and by whom.<br>
            <em>Found ${r.count} log entries.</em>`
        };
      }
    }];
  }

  // ── AUTO-UPGRADE: 2 steps, one per dashboard ────────────────────────────
  const auDashUrl      = `${SPLUNK_AUTO_UPGRADE_DASHBOARD_BASE}${accountId}${SPLUNK_AU_DASH_PARAMS}`;
  const planChangesUrl = `${SPLUNK_BILLING_PLAN_CHANGES_BASE}${accountId}${SPLUNK_PC_DASH_PARAMS}`;

  return [
    // ── Step 1: qw_auto_upgrade_logs ──────────────────────────────────────
    {
      tool: 'splunk',
      label: 'Auto-upgrade events',
      // Mirrors the "Schedule w/ AU (email/sms)" panels on qw_auto_upgrade_logs
      query: `index=klaviyo sourcetype=django:billing ("Auto-upgrade allowed for message" OR "Auto-upgrade not allowed for message" OR "Auto-upgrade failed for message" OR "Auto-upgrade succeeded for message" OR "Auto-upgrade payment succeeded" OR "Attempting auto-upgrade" OR "triggering an auto-upgrade" OR "flex_overage") ${accountId}`,
      interpret(r) {
        const dashLink = `<a href="${auDashUrl}" target="_blank" class="step-action" style="display:inline-block;margin:4px 0">📊 Open Auto-Upgrade Debugging Dash</a>`;

        if (r.noResults) return {
          status: 'pass',
          message: `<strong>No auto-upgrade trigger events found ✅</strong><br>
            <br>No auto-upgrade signals in this time range — the account was not at a send/profile limit that would have triggered an upgrade.<br>
            <br>${dashLink}`
        };

        const auTriggers   = [];
        const flexOverages = [];

        for (const s of (r.summaries || [])) {
          if (/Auto-upgrade (?:allowed|not allowed|failed|succeeded) for message|Attempting auto-upgrade|triggering an auto-upgrade|Auto-upgrade payment succeeded/i.test(s)) {
            const msgM    = s.match(/Auto-upgrade \S+\s+for message\s+(\S+)/i);
            const profM   = s.match(/for ([\d,]+) profiles,?\s+which is over the current profile limit of ([\d,]+)/i);
            const sendM   = s.match(/BillingUsage:\s*(\d+)\s*\/\s*UsageLimitType\.\w+,\s*(\d+),\s*BillingProductType\.(\w+)/i);
            const timeM   = s.match(/(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/);
            const failed     = /Auto-upgrade failed/i.test(s);
            const success    = /payment succeeded|succeeded for/i.test(s);
            const notAllowed = /not allowed/i.test(s);
            auTriggers.push({
              msgId:          msgM  ? msgM[1] : null,
              actualProfiles: profM ? profM[1].replace(/,/g, '') : null,
              profileLimit:   profM ? profM[2].replace(/,/g, '') : null,
              actualSends:    sendM ? sendM[1] : null,
              sendLimit:      sendM ? sendM[2] : null,
              channel:        sendM ? sendM[3].toLowerCase() : (profM ? 'email' : null),
              at:             timeM ? timeM[1].replace('T', ' ') : null,
              failed, success, notAllowed
            });
            continue;
          }
          if (/flex_overage/i.test(s)) {
            const usageM = s.match(/usage_type['"]*\s*[:=]\s*['"]*(\S+?)['"\s,}]/i);
            const valM   = s.match(/['"]*current_value['"]*\s*[:=]\s*(\d+)/i);
            const costM  = s.match(/overage_cost_per_unit_price['"]*\s*[:=]\s*['"]*([0-9.]+)/i);
            const timeM  = s.match(/(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/);
            flexOverages.push({
              usageType:    usageM ? usageM[1] : null,
              currentValue: valM   ? valM[1] : null,
              costPerUnit:  costM  ? costM[1] : null,
              at:           timeM  ? timeM[1].replace('T', ' ') : null
            });
          }
        }

        let html = '';
        let overallStatus = 'pass';

        if (auTriggers.length > 0) {
          overallStatus = 'fail';
          html += `<br>⚡ <strong>Auto-upgrade trigger events (${auTriggers.length}):</strong>`;
          for (const t of auTriggers) {
            const icon  = t.success ? '✅' : t.failed ? '❌' : t.notAllowed ? '🚫' : '⚠️';
            const label = t.success ? 'Payment succeeded' : t.failed ? 'FAILED' : t.notAllowed ? 'Not allowed' : 'Triggered';
            const chanEmoji = t.channel === 'sms' ? '💬' : '📧';
            let detail = '';
            if (t.actualProfiles && t.profileLimit) {
              const over = Number(t.actualProfiles) - Number(t.profileLimit);
              detail = ` — ${chanEmoji} ${Number(t.actualProfiles).toLocaleString()} profiles vs limit ${Number(t.profileLimit).toLocaleString()} (+${Number(over).toLocaleString()} over)`;
            } else if (t.actualSends && t.sendLimit) {
              const over = Number(t.actualSends) - Number(t.sendLimit);
              detail = ` — ${chanEmoji} ${Number(t.actualSends).toLocaleString()} sends vs limit ${Number(t.sendLimit).toLocaleString()} (+${Number(over).toLocaleString()} over)`;
            }
            html += `<br>&nbsp;&nbsp;${icon} ${label}${detail}`;
            if (t.msgId) html += ` (msg: <code>${t.msgId}</code>)`;
            if (t.at)    html += ` <span style="color:var(--text-secondary)">${t.at} UTC</span>`;
          }
        }

        if (flexOverages.length > 0) {
          overallStatus = 'fail';
          html += `<br><br>💰 <strong>Flex overage charges (${flexOverages.length}):</strong>`;
          for (const fo of flexOverages) {
            const chanEmoji = fo.usageType?.includes('sms') ? '💬' : '📧';
            html += `<br>&nbsp;&nbsp;${chanEmoji} ${fo.usageType || 'unknown'}: ${fo.currentValue ? Number(fo.currentValue).toLocaleString() + ' used' : ''}`;
            if (fo.costPerUnit) html += `, $${fo.costPerUnit}/unit`;
            if (fo.at) html += ` <span style="color:var(--text-secondary)">${fo.at} UTC</span>`;
          }
        }

        if (auTriggers.length === 0 && flexOverages.length === 0) {
          html += `<br>Results returned but no recognisable trigger or flex-overage patterns found — check the raw logs.`;
        }

        const statusLabel = overallStatus === 'fail' ? 'Auto-upgrade activity found' : 'No auto-upgrade triggers found';
        const statusIcon  = overallStatus === 'fail' ? '⚠️' : '✅';
        return {
          status: overallStatus,
          message: `<strong>${statusLabel} ${statusIcon}</strong>${html}<br><br>${dashLink}`
        };
      }
    },

    // ── Step 2: billing_plan_changes ──────────────────────────────────────
    {
      tool: 'splunk',
      label: 'Billing plan changes',
      // Mirrors the "Billing Plan Change Table" / "Logs of Billing Plan Changes" panels
      query: `index=klaviyo sourcetype=django:billing "BILLING_PLAN_CHANGE_SERVICE" ${accountId}`,
      interpret(r) {
        const dashLink = `<a href="${planChangesUrl}" target="_blank" class="step-action" style="display:inline-block;margin:4px 0">📋 Open Billing Plan Changes Dash</a>`;

        if (r.noResults) return {
          status: 'pass',
          message: `<strong>No billing plan changes found ✅</strong><br>
            <br>No plan changes recorded for this account in this time range.<br>
            <br>${dashLink}`
        };

        const planChanges = [];
        for (const s of (r.summaries || [])) {
          if (!/BILLING_PLAN_CHANGE_SERVICE/i.test(s)) continue;
          const planM   = s.match(/Set billing plan to\s+(\S+)\s+locally for\s+\S+/i);
          const ctxM    = s.match(/context=(\S+)/i);
          const ctxPurM = s.match(/context_purpose=(\S+)/i);
          const timeM   = s.match(/(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/);
          planChanges.push({
            plan:    planM    ? planM[1]    : null,
            context: ctxM    ? ctxM[1]    : null,
            purpose: ctxPurM ? ctxPurM[1] : null,
            at:      timeM   ? timeM[1].replace('T', ' ') : null
          });
        }

        const hasAutoUpgrade = planChanges.some(pc => /auto_upgrade|auto/i.test(pc.purpose || ''));
        const overallStatus  = hasAutoUpgrade ? 'fail' : 'warn';

        let html = `<br>📋 <strong>Plan changes found (${planChanges.length}):</strong>`;
        for (const pc of planChanges) {
          const isAuto    = /auto_upgrade|auto/i.test(pc.purpose || '');
          const isMPC     = /mpc|manual/i.test(pc.context || '');
          const typeLabel = isAuto ? '🤖 Auto-upgrade' : isMPC ? '🧑 Manual (MPC)' : `📦 ${pc.context || 'unknown'}`;
          html += `<br>&nbsp;&nbsp;${typeLabel} → <code>${pc.plan || 'unknown plan'}</code>`;
          if (pc.at) html += ` <span style="color:var(--text-secondary)">${pc.at} UTC</span>`;
        }

        const statusLabel = hasAutoUpgrade ? 'Auto-upgrade plan change confirmed' : `${planChanges.length} manual plan change(s) found`;
        const statusIcon  = hasAutoUpgrade ? '⚠️' : 'ℹ️';
        return {
          status: overallStatus,
          message: `<strong>${statusLabel} ${statusIcon}</strong>${html}<br><br>${dashLink}`
        };
      }
    }
  ];
}

// ── FORMS (Splunk) ────────────────────────────────────────────────────────────
function buildFormSteps(scenario, fields, timeRange) {
  const { accountId, formId } = fields;

  // ── set_draft: "unpublished form for company" logs ───────────────────────
  if (scenario === 'set_draft') {
    // Actual query pattern from Splunk: search unpublished form {accountId}
    // Logs: sourcetype=django:content_team  ScheduledFormsTask form {formId} company {accountId} event Unpublished form for company
    const query = formId
      ? `sourcetype=django:content_team "Unpublished form for company" ${accountId} form_id="${formId}"`
      : `sourcetype=django:content_team "Unpublished form for company" ${accountId}`;
    return [{
      tool: 'splunk',
      label: 'Form unpublished / set to draft',
      query,
      interpret(r) {
        if (r.noResults) return {
          status: 'warn',
          message: `<strong>No form unpublish log found</strong><br>
            <br><strong>Possible reasons:</strong>
            <ul>
              <li>The form has not been set to draft/unpublished in this time range</li>
              <li>Try widening the time range to 90d</li>
              ${formId ? `<li>Try searching without the Form ID to see all unpublish events for this account</li>` : ''}
            </ul>
            <strong>Next steps:</strong>
            <ul>
              <li>Check the form's current status in the Forms dashboard</li>
              <li>If the form is unexpectedly inactive, widen to 90d — scheduled tasks can unpublish forms automatically</li>
            </ul>`
        };

        // Real log format: [ScheduledFormsTask] ---- {"form_id":"...","company_id":"...","event":"Unpublished form for company","app_log_uuid":"..."}
        // sourcetype=django:content_team, source=/var/log/django/supervisord/chariot_out.log
        // event_type is always ScheduledFormsTask — this is always an automated forms scheduler action, never manual
        const events = [];
        for (const s of (r.summaries || [])) {
          if (!/unpublished form for company/i.test(s)) continue;
          // Parse JSON body from the log line
          const jsonMatch = s.match(/\{[^{}]+\}/);
          let body = null;
          try { body = jsonMatch ? JSON.parse(jsonMatch[0]) : null; } catch(e) {}
          const timeM = s.match(/(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/);
          events.push({
            formId:  body?.form_id   || null,
            company: body?.company_id || null,
            uuid:    body?.app_log_uuid || null,
            at:      timeM ? timeM[1].replace('T', ' ') : null
          });
        }

        let html = '';
        if (events.length > 0) {
          // Group events by batch run (events within 60s of each other = same scheduled run)
          const uniqueForms = [...new Set(events.map(e => e.formId).filter(Boolean))];
          html += `<br>📋 <strong>${events.length} unpublish event${events.length !== 1 ? 's' : ''} — ${uniqueForms.length} unique form${uniqueForms.length !== 1 ? 's' : ''}</strong>`;
          html += `<br><span style="font-size:11px;color:var(--text-secondary)">🤖 All triggered by <strong>ScheduledFormsTask</strong> (automated forms scheduler — not a human action)</span>`;
          for (const e of events) {
            html += `<br>&nbsp;&nbsp;• form <code>${e.formId || '?'}</code>`;
            if (e.at)   html += ` <span style="color:var(--text-secondary)">${e.at} UTC</span>`;
            if (e.uuid) html += `<br>&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:var(--text-secondary);font-size:11px">uuid: ${e.uuid}</span>`;
          }
        }

        return {
          status: 'pass',
          message: `<strong>Form unpublish log found ✅</strong>${html}`
        };
      }
    }];
  }

  // ── deleted: "FORM DELETION REQUEST" logs ────────────────────────────────
  if (scenario === 'deleted') {
    // Actual query pattern from Splunk: "FORM DELETION REQUEST" company_id="RuUwRn"
    // Logs: FORM DELETION REQUEST company {accountId} form {formId} user email {email} app log uuid {uuid}
    const query = formId
      ? `"FORM DELETION REQUEST" company_id="${accountId}" form_id="${formId}"`
      : `"FORM DELETION REQUEST" company_id="${accountId}"`;
    return [{
      tool: 'splunk',
      label: 'Form deletion log',
      query,
      interpret(r) {
        if (r.noResults) return {
          status: 'warn',
          message: `<strong>No form deletion log found</strong><br>
            <br><strong>Possible reasons:</strong>
            <ul>
              <li>The form was not deleted — check its current status in the Forms dashboard</li>
              <li>Deletion occurred more than 90 days ago</li>
              ${formId ? `<li>Try searching without the Form ID to see all deletions for this account</li>` : ''}
            </ul>
            <strong>Next steps:</strong>
            <ul>
              <li>Confirm the form is actually missing from the account</li>
              <li>Try widening the time range to 90d</li>
              <li>Note: deleted forms cannot be recovered — if this is a customer request, inform them accordingly</li>
            </ul>`
        };

        // Parse events: FORM DELETION REQUEST company {accountId} form {formId} user email {email} app log uuid {uuid}
        const deletions = [];
        for (const s of (r.summaries || [])) {
          if (!/FORM DELETION REQUEST/i.test(s)) continue;
          const fIdM   = s.match(/\bform[_\s=:"']+([A-Za-z0-9]{5,8})\b/i);
          const emailM = s.match(/user[_\s]+email[_\s=:"']+([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i);
          const timeM  = s.match(/(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/);
          deletions.push({
            formId: fIdM   ? fIdM[1]   : null,
            email:  emailM ? emailM[1] : null,
            at:     timeM  ? timeM[1].replace('T', ' ') : null
          });
        }

        let html = '';
        if (deletions.length > 0) {
          html += `<br>🗑️ <strong>Deletion events (${deletions.length}):</strong>`;
          for (const d of deletions) {
            html += `<br>&nbsp;&nbsp;❌ Form deleted`;
            if (d.formId) html += ` — <code>${d.formId}</code>`;
            if (d.email)  html += `<br>&nbsp;&nbsp;&nbsp;&nbsp;👤 Deleted by: <code>${d.email}</code>`;
            if (d.at)     html += ` <span style="color:var(--text-secondary)">at ${d.at} UTC</span>`;
          }
          html += `<br><br><em style="color:var(--text-secondary);font-size:11px">Deleted forms cannot be recovered — inform the customer if this is their concern.</em>`;
        }

        return {
          status: 'fail',
          message: `<strong>Form deletion confirmed ❌</strong>${html}`
        };
      }
    }];
  }

  // ── published/unpublished: search by form ID ─────────────────────────────
  // Exact query pattern: search unpublished form {formId}
  // Log: ScheduledFormsTask form {formId} company {companyId} event Unpublished form for company
  return [{
    tool: 'splunk',
    label: 'Form published / unpublished history',
    query: `unpublished form ${formId}`,
    interpret(r) {
      if (r.noResults) return {
        status: 'warn',
        message: `<strong>No unpublish events found for this form</strong><br>
          <br><strong>Possible reasons:</strong>
          <ul>
            <li>This form has not been unpublished/set to draft within this time range</li>
            <li>Try widening the time range to 90d</li>
            <li>Verify the Form ID is correct</li>
          </ul>`
      };

      // Real log format: [ScheduledFormsTask] ---- {"form_id":"...","company_id":"...","event":"Unpublished form for company","app_log_uuid":"..."}
      // sourcetype=django:content_team, source=/var/log/django/supervisord/chariot_out.log
      // host: qw-kms-forms-schedule-*.servers.clovesoftware.com (forms scheduling service)
      // event_type is always ScheduledFormsTask — automated scheduler, never a human action
      const events = [];
      for (const s of (r.summaries || [])) {
        if (!/unpublished form for company/i.test(s)) continue;
        const jsonMatch = s.match(/\{[^{}]+\}/);
        let body = null;
        try { body = jsonMatch ? JSON.parse(jsonMatch[0]) : null; } catch(e) {}
        const timeM = s.match(/(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/);
        events.push({
          formId:  body?.form_id    || null,
          company: body?.company_id || null,
          uuid:    body?.app_log_uuid || null,
          at:      timeM ? timeM[1].replace('T', ' ') : null
        });
      }

      let html = '';
      if (events.length > 0) {
        // Show which account(s) this form belongs to
        const companies = [...new Set(events.map(e => e.company).filter(Boolean))];
        if (companies.length) {
          html += `<br>🏢 <strong>Account:</strong> ${companies.map(c => `<code>${c}</code>`).join(', ')}`;
        }
        html += `<br><br>📋 <strong>${events.length} unpublish event${events.length !== 1 ? 's' : ''} found:</strong>`;
        html += `<br><span style="font-size:11px;color:var(--text-secondary)">🤖 All triggered by <strong>ScheduledFormsTask</strong> (automated forms scheduler — not a human action)</span>`;
        for (const e of events) {
          html += `<br>&nbsp;&nbsp;•`;
          if (e.formId) html += ` form <code>${e.formId}</code>`;
          if (e.at)     html += ` <span style="color:var(--text-secondary)">${e.at} UTC</span>`;
          if (e.uuid)   html += `<br>&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:var(--text-secondary);font-size:11px">uuid: ${e.uuid}</span>`;
        }
      }

      return {
        status: 'pass',
        message: `<strong>Unpublish history found ✅</strong>${html}`
      };
    }
  }];
}

// ── PUSH NOTIFICATIONS (Splunk) ───────────────────────────────────────────────
// Real query format: search Push Consent {profileId}
// Real log format:   [SIDE_EFFECT_EVENT_DROPPED] ---- { "company_id": "...", "payload": { "pushTokenData": { "platform": "ios", "enablementStatus": "DENIED" }, "deviceMetadata": { "deviceId": "...", "klaviyoSdk": "swift", "sdkVersion": "3.1.0", "deviceModel": "iPhone15,5", "osName": "ios", "osVersion": "18.3.1", "manufacturer": "Apple", "appName": "...", "appVersion": "..." } } }
// sourcetype=django:push, host=qw-push-transmission-side-effect-*.servers.clovesoftware.com
// Key event type: SIDE_EFFECT_EVENT_DROPPED (push dropped — check enablementStatus)
// Ignore: PROCESSING_MESSAGE_BATCH (batch noise, not profile-specific)
function buildPushSteps(fields, timeRange) {
  const { profileId } = fields;
  return [{
    tool: 'splunk',
    label: 'Push consent log',
    query: `index=klaviyo sourcetype="django:push" Push Consent ${profileId}`,
    interpret(r) {
      if (r.noResults) return {
        status: 'warn',
        message: `<strong>No push consent log found for this profile</strong><br>
          <br><strong>Possible reasons:</strong>
          <ul>
            <li>The profile never registered a push token (app was never opened / notifications never enabled)</li>
            <li>The profile's push activity is outside the selected time range — try 90d</li>
            <li>Verify the Profile ID is correct</li>
          </ul>
          <strong>Next steps:</strong>
          <ul>
            <li>Check the profile's current push consent status directly in the account</li>
            <li>Without a registered token, push notifications cannot be delivered</li>
            <li>Ask the customer to confirm they have the app installed and notifications enabled at the OS level</li>
          </ul>`
      };

      // Parse SIDE_EFFECT_EVENT_DROPPED events — these are the consent-relevant logs
      // PROCESSING_MESSAGE_BATCH is batch noise (profile appears in a 400-message batch) — skip it
      const events = [];
      for (const s of (r.summaries || [])) {
        if (!/SIDE_EFFECT_EVENT_DROPPED/i.test(s)) continue;
        const get = (key) => { const m = s.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`)); return m ? m[1] : null; };
        const timeM = s.match(/(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})/);
        events.push({
          at:               timeM ? timeM[1].replace('T', ' ') : null,
          company:          get('company_id') || get('companyId'),
          platform:         get('platform'),
          enablementStatus: get('enablementStatus'),
          appName:          get('appName'),
          appVersion:       get('appVersion'),
          deviceModel:      get('deviceModel'),
          osName:           get('osName'),
          osVersion:        get('osVersion'),
          klaviyoSdk:       get('klaviyoSdk'),
          sdkVersion:       get('sdkVersion'),
          deviceId:         get('deviceId'),
        });
      }

      let html = '';

      if (events.length > 0) {
        // Summarise consent status — get unique enablementStatus values
        const statuses   = [...new Set(events.map(e => e.enablementStatus).filter(Boolean))];
        const companies  = [...new Set(events.map(e => e.company).filter(Boolean))];
        const platforms  = [...new Set(events.map(e => e.platform).filter(Boolean))];
        const appNames   = [...new Set(events.map(e => e.appName).filter(Boolean))];
        const devices    = [...new Set(events.map(e => e.deviceModel).filter(Boolean))];
        const osList     = [...new Set(events.map(e => e.osName && e.osVersion ? `${e.osName} ${e.osVersion}` : null).filter(Boolean))];
        const sdks       = [...new Set(events.map(e => e.klaviyoSdk && e.sdkVersion ? `${e.klaviyoSdk} v${e.sdkVersion}` : null).filter(Boolean))];

        const statusIcon = statuses.includes('DENIED') && !statuses.includes('AUTHORIZED') ? '🔴' :
                           statuses.includes('AUTHORIZED') && !statuses.includes('DENIED')  ? '🟢' : '🟡';

        if (companies.length)  html += `<br>🏢 <strong>Account:</strong> ${companies.map(c => `<code>${c}</code>`).join(', ')}`;
        html += `<br>📱 <strong>Platform:</strong> ${platforms.join(', ') || '?'}`;
        html += `<br>🔔 <strong>Consent status:</strong> ${statusIcon} ${statuses.join(' / ') || '?'}`;
        if (appNames.length)   html += `<br>📦 <strong>App:</strong> ${appNames.join(', ')}`;
        if (devices.length)    html += `<br>📲 <strong>Device:</strong> ${devices.join(', ')}`;
        if (osList.length)     html += `<br>⚙️ <strong>OS:</strong> ${osList.join(', ')}`;
        if (sdks.length)       html += `<br>🛠 <strong>Klaviyo SDK:</strong> ${sdks.join(', ')}`;
        html += `<br><br>📋 <strong>${events.length} event${events.length !== 1 ? 's' : ''} (SIDE_EFFECT_EVENT_DROPPED):</strong>`;
        for (const e of events) {
          const icon = e.enablementStatus === 'DENIED' ? '🔴' : e.enablementStatus === 'AUTHORIZED' ? '🟢' : '⚪';
          html += `<br>&nbsp;&nbsp;${icon} ${e.enablementStatus || '?'}`;
          if (e.at) html += ` <span style="color:var(--text-secondary)">${e.at} UTC</span>`;
        }
        if (statuses.includes('DENIED')) {
          html += `<br><br><em style="color:var(--text-secondary);font-size:11px">DENIED = push notifications are disabled at the OS level on the device. The customer needs to re-enable notifications in their phone settings.</em>`;
        }
      } else {
        // Results returned but no SIDE_EFFECT_EVENT_DROPPED — only batch noise
        html += `<br>Results found but only batch processing events (PROCESSING_MESSAGE_BATCH) — no direct consent change logs for this profile.`;
        html += `<br><br>Check the raw Splunk results directly for more detail.`;
      }

      return {
        status: 'pass',
        message: `<strong>Push consent log found ✅</strong>${html}`
      };
    }
  }];
}

// ── REVIEWS (Chronosphere) ────────────────────────────────────────────────────
// Reviews-app logs are in Chronosphere ONLY — not Splunk. index=k8 k8s_namespace=reviews is outdated.
// CRITICAL: Escape brackets in Chronosphere regex — use \[TAG\] not [TAG]. Unescaped = character class = 20M+ junk results.
function buildReviewSteps(scenario, fields, timeRange) {
  const { accountId } = fields;

  if (scenario === 'not_triggering') {
    return [{
      tool: 'chronosphere',
      label: 'Reviews billing limit check',
      query: `service = "reviews-app" AND message =~ "\\[REVIEWS_GENERIC\\]" AND message =~ "fulfilled_beat_v2" AND message =~ '"company_id": "${accountId}"'`,
      interpret(r) {
        if (r.noResults) return {
          status: 'warn',
          message: `<strong>No Reviews billing limit log found</strong><br>
            <br><strong>Possible reasons:</strong>
            <ul>
              <li>The account has not hit its Reviews plan limit in this time range</li>
              <li>The Reviews "Ready to Review" flow isn't triggering for a different reason</li>
            </ul>
            <strong>Other things to check if Reviews isn't triggering:</strong>
            <ul>
              <li>Is the account on a plan that <strong>includes Reviews</strong>? Reviews requires a paid add-on or specific plan tier</li>
              <li>Is the product linked to a <strong>verified purchase</strong>? Reviews only triggers after a confirmed order</li>
              <li>Is the Reviews integration properly configured in the account settings?</li>
              <li>Check if the "Ready to Review" event appears in the profile's activity timeline</li>
              <li>Verify the Reviews flow is active and targeting the correct trigger metric</li>
            </ul>`
        };
        let markedSkipped = null, capacityRemaining = null;
        for (const s of (r.summaries || [])) {
          if (markedSkipped === null)     { const m = s.match(/"marked_skipped_count"\s*:\s*(\d+)/);  if (m) markedSkipped = parseInt(m[1]); }
          if (capacityRemaining === null) { const m = s.match(/"capacity_remaining"\s*:\s*(\d+)/);    if (m) capacityRemaining = parseInt(m[1]); }
        }
        const hitLimit = markedSkipped > 0 || capacityRemaining === 0;
        const skippedBlock   = markedSkipped !== null    ? `<br>⚠️ <strong>Skipped count:</strong> <code>${markedSkipped}</code>` : '';
        const capacityBlock  = capacityRemaining !== null ? `<br>📊 <strong>Capacity remaining:</strong> <code>${capacityRemaining}</code>` : '';
        return {
          status: hitLimit ? 'fail' : 'pass',
          message: hitLimit
            ? `<strong>Reviews billing limit hit ⚠️</strong>${skippedBlock}${capacityBlock}<br>
               <br><strong>What this means:</strong> The account has reached its plan limit for "Ready to Review" events and Reviews flows are no longer triggering.<br>
               <br><strong>Resolution:</strong>
               <ul>
                 <li>The customer needs to <strong>upgrade their plan</strong> to increase their Reviews limit</li>
                 <li>Inform the customer that their Reviews campaigns have been paused due to plan limits</li>
                 <li>Direct them to their Billing settings to upgrade</li>
               </ul>`
            : `<strong>Reviews batch log found (no billing limit detected)</strong>${skippedBlock}${capacityBlock}<br>
               <br>Reviews are processing but no billing limit was detected in this batch. Expand raw logs to verify.<br>
               <em>Found ${r.count} log entries.</em>`
        };
      }
    }];
  }

  if (scenario === 'exported') {
    return [{
      tool: 'chronosphere',
      label: 'Reviews export log',
      query: `service = "reviews-app" AND message =~ "\\[REVIEWS_EXPORT\\]" AND message =~ '"company_id": "${accountId}"'`,
      interpret(r) {
        if (r.noResults) return {
          status: 'warn',
          message: `<strong>No Reviews export log found in this time range</strong><br>
            <br>No reviews were exported from this account in the selected time range. Try widening to 90d.`
        };
        let exportCount = null;
        for (const s of (r.summaries || [])) {
          const m = s.match(/Exported (\d+) reviews/);
          if (m) { exportCount = m[1]; break; }
        }
        const countBlock = exportCount ? `<br>📦 <strong>Reviews exported:</strong> <code>${exportCount}</code>` : '';
        return {
          status: 'pass',
          message: `<strong>Reviews export log found ✅</strong>${countBlock}<br>
            <br>Expand the raw logs to see when reviews were exported and which user initiated the export.<br>
            <em>Found ${r.count} log entries.</em>`
        };
      }
    }];
  }

  if (scenario === 'settings_change') {
    return [{
      tool: 'chronosphere',
      label: 'Reviews settings change log',
      query: `service = "reviews-app" AND message =~ "\\[REVIEWS_GENERIC\\]" AND message =~ "Settings changed" AND message =~ '"company_id": "${accountId}"'`,
      interpret(r) {
        if (r.noResults) return {
          status: 'warn',
          message: `<strong>No Reviews settings change log found in this time range</strong><br>
            <br>No Reviews settings changes were logged for this account. Try widening to 90d.`
        };
        return {
          status: 'pass',
          message: `<strong>Reviews settings change log found ✅</strong><br>
            <br>Expand the raw logs to see when Reviews settings were changed — the <code>changes</code> field shows exactly what was modified.<br>
            <em>Found ${r.count} log entries.</em>`
        };
      }
    }];
  }

  // Fallback
  return [{
    tool: 'chronosphere',
    query: `service = "reviews-app" AND message =~ '"company_id": "${accountId}"'`,
    interpret(r) {
      if (r.noResults) return { status: 'warn', message: `<strong>No Reviews log found.</strong><br>Try widening the time range.` };
      return { status: 'pass', message: `<strong>Reviews logs found.</strong><br>Expand raw logs to review.<br><em>Found ${r.count} log entries.</em>` };
    }
  }];
}

// ── INTEGRATIONS (Splunk) ─────────────────────────────────────────────────────
function buildIntegrationSteps(fields, timeRange) {
  const { accountId } = fields;

  return [{
    tool: 'splunk',
    query: `index=klaviyo sourcetype="django:integrations" company_id="${accountId}" "integration"`,
    interpret(r) {
      if (r.noResults) return {
        status: 'warn',
        message: `<strong>No integration error logs found in this time range</strong><br>
          <br><strong>Possible reasons:</strong>
          <ul>
            <li>The integration is functioning correctly with no errors</li>
            <li>The issue is on the external service's side, not logged in Klaviyo</li>
            <li>Try widening the time range to 30d or 90d</li>
          </ul>
          <strong>General troubleshooting steps:</strong>
          <ul>
            <li>Verify the integration is <strong>active</strong> and credentials are valid in the account's Integration settings</li>
            <li>Check if webhooks are properly registered and pointing to the correct Klaviyo endpoints</li>
            <li>For API integrations, check for 403 errors (Cloudflare blocks) — these are caused by IP reputation issues and are not logged in Klaviyo</li>
            <li>For Sync 2.0 integrations, check the sync task logs for <code>sync_key</code>, <code>sync_type</code>, and <code>execution_seconds</code></li>
          </ul>
`
      };
      // ── Parse log details ──────────────────────────────────────────────────
      const integrationKeys   = new Set();
      const exceptionTypes    = new Set();
      const taskNames         = new Set();
      const queueNames        = new Set();
      const msgs              = new Set();
      let retryCount  = 0;
      let totalCount  = 0;
      let firstSeen   = null;
      let lastSeen    = null;

      for (const s of (r.summaries || [])) {
        totalCount++;
        const jsonMatch = s.match(/\{[\s\S]*?\}/);
        let data = {};
        if (jsonMatch) { try { data = JSON.parse(jsonMatch[0]); } catch(e) {} }

        if (data.integration_key) integrationKeys.add(data.integration_key);
        if (data.exception_type)  exceptionTypes.add(data.exception_type);
        if (data.task_name)       taskNames.add(data.task_name);
        if (data.queue_name)      queueNames.add(data.queue_name.replace(/\.r\d+\./, '.rXX.'));
        if (data.msg)             msgs.add(data.msg);
        if (data.is_retry)        retryCount++;

        if (data.timestamp) {
          if (!firstSeen || data.timestamp < firstSeen) firstSeen = data.timestamp;
          if (!lastSeen  || data.timestamp > lastSeen)  lastSeen  = data.timestamp;
        }
      }

      // ── Build structured output ─────────────────────────────────────────────
      const integBlock = integrationKeys.size
        ? `<br>🔗 <strong>Integration:</strong> ${[...integrationKeys].map(k => `<code>${k}</code>`).join(', ')}`
        : '';
      const exBlock = exceptionTypes.size
        ? `<br>❌ <strong>Exception type:</strong> ${[...exceptionTypes].map(e => `<code>${e}</code>`).join(', ')}`
        : '';
      const retryBlock = retryCount > 0
        ? `<br>🔁 <strong>Retry events:</strong> <code>${retryCount}</code> of ${r.count} — webhook tasks failing on first attempt, retrying with 2s backoff`
        : '';
      const taskBlock = taskNames.size
        ? `<br>⚙️ <strong>Task:</strong> ${[...taskNames].map(t => `<code>${t}</code>`).join(', ')}`
        : '';
      const queueBlock = queueNames.size
        ? `<br>📬 <strong>Queue pattern:</strong> ${[...queueNames].values().next().value ? `<code>${[...queueNames].values().next().value}</code> (${queueNames.size} worker${queueNames.size > 1 ? 's' : ''})` : ''}`
        : '';
      const msgBlock = msgs.size
        ? `<br>📋 <strong>Log messages:</strong><ul style="margin:4px 0 0">${[...msgs].map(m => `<li>${m}</li>`).join('')}</ul>`
        : '';
      const timeBlock = firstSeen
        ? `<br>🕐 <strong>First seen:</strong> <code>${firstSeen.replace('T',' ')}</code>${lastSeen && lastSeen !== firstSeen ? `&nbsp;&nbsp;<strong>Last seen:</strong> <code>${lastSeen.replace('T',' ')}</code>` : ''}`
        : '';

      // ── Retry-heavy diagnosis ───────────────────────────────────────────────
      const isRetryHeavy = retryCount > 0 && (retryCount / Math.max(parseInt(r.count)||1, 1)) > 0.3;
      const retryDiagnosis = isRetryHeavy
        ? `<br><br>⚠️ <strong>High retry rate detected</strong> — ${retryCount} retries across ${queueNames.size} worker queues suggests a persistent processing issue with incoming webhooks, not a transient blip. Common causes: Shopify sending malformed/unexpected payloads, a downstream service being slow, or rate limiting.`
        : '';

      return {
        status: 'pass',
        message: `<strong>Logs found</strong>${integBlock}${exBlock}${retryBlock}${taskBlock}${queueBlock}${timeBlock}${msgBlock}${retryDiagnosis}
          <br><br><strong>What to look for in the raw logs:</strong>
          <ul>
            <li><strong>RetryItemException</strong> — Webhook task failing on first attempt; if retries = 0 and count is high, it's a persistent payload or service issue</li>
            <li><strong>Authentication failures</strong> — Expired/invalid API keys. Customer needs to reconnect the integration</li>
            <li><strong>Webhook failures</strong> — Payload format issues or endpoint unreachable</li>
            <li><strong>403 Cloudflare blocks</strong> — IP reputation; Klaviyo can't change these — customer may need to rotate IP</li>
            <li><strong>Bypassing webhook repair</strong> — Webhooks ARE registered correctly (normal/healthy log)</li>
          </ul>
          <br>If errors are persistent, escalate to the <strong>Integrations</strong> team with the exception type, company_id, and timeframe.`,
        jiraTeam: (parseInt(r.count) > 10 || isRetryHeavy) ? 'Integrations' : null,
        jiraNote: `Integration errors found: ${[...exceptionTypes].join(', ') || 'see logs'}. Integration: ${[...integrationKeys].join(', ') || 'unknown'}. ${retryCount} retry events across ${queueNames.size} queues.`
      };
    }
  }];
}

// ══════════════════════════════════════════════════════════════════════════════
// ─── CHRONOSPHERE HELPERS ─────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function buildChronoUrl(query, timeRange) {
  if (timeRange.startsWith('daterange:')) {
    // format: daterange:YYYY-MM-DD:YYYY-MM-DD
    const parts   = timeRange.slice(10).split(':');
    const startMs = new Date(parts[0] + 'T00:00:00Z').getTime();
    const endMs   = new Date(parts[1] + 'T23:59:59Z').getTime();
    return `${CHRONO_BASE}?start=${startMs}&end=${endMs}&query=${encodeURIComponent(query)}`;
  }
  if (timeRange.startsWith('date:')) {
    const dateStr = timeRange.slice(5);          // 'YYYY-MM-DD'
    const startMs = new Date(dateStr + 'T00:00:00Z').getTime();
    const endMs   = new Date(dateStr + 'T23:59:59Z').getTime();
    return `${CHRONO_BASE}?start=${startMs}&end=${endMs}&query=${encodeURIComponent(query)}`;
  }
  return `${CHRONO_BASE}?start=${timeRange}&query=${encodeURIComponent(query)}`;
}

async function findOrCreateChronosphereTab() {
  const tabs = await chrome.tabs.query({ url: 'https://klaviyo.chronosphere.io/*' });
  if (tabs.length) return tabs[0].id;
  const tab = await chrome.tabs.create({ url: CHRONO_BASE, active: false });
  return tab.id;
}

async function readChronosphereResults(tabId) {
  const res = await chrome.scripting.executeScript({ target: { tabId }, func: extractChronoLogs });
  return res[0]?.result ?? { noResults: true, count: '0', summaries: [] };
}

// Injected into Chronosphere tab — must be self-contained
// Waits for BOTH the query to finish AND the skeleton to clear before trusting
// the result count. Uses semantic heading selectors since Chronosphere renders
// the count as <h3> (not role="heading"). Hard 2-min timeout returns
// { timeout: true } which runDiagnostic shows as "check manually" — not a false
// "no results" negative.
function extractChronoLogs() {
  return new Promise((resolve) => {
    const HARD_TIMEOUT = 420000; // 7 minutes — safety net so the Promise never hangs forever
    const t0 = Date.now();
    let queryHasStarted = false; // true once we've seen the progressbar at least once

    function poll() {
      // ── Hard timeout ──────────────────────────────────────────────────────
      if (Date.now() - t0 > HARD_TIMEOUT) {
        return resolve({ timeout: true });
      }

      // ── Wait for query to finish ──────────────────────────────────────────
      // Chronosphere shows a progressbar INSIDE the Run/Cancel button group
      // while the query is still executing. Once gone, the query is done.
      const runGroup = document.querySelector('[role="group"]');
      const queryRunning = !!runGroup?.querySelector('[role="progressbar"]');

      // Track whether the query has ever started — we use this below to avoid
      // trusting a "0 Logs" count that appears before the query has even run.
      if (queryRunning) queryHasStarted = true;

      // ── Wait for row skeleton to clear ───────────────────────────────────
      // Even after the query finishes, MuiDataGrid renders a loading skeleton
      // while it paints the virtual rows. Don't read until this is gone too.
      const skeleton = !!document.querySelector('[aria-label="Table loading skeleton"]');

      if (queryRunning || skeleton) {
        return setTimeout(poll, 700);
      }

      // ── Both done — read the result count ─────────────────────────────────
      // Chronosphere renders "N Logs" somewhere in the page — element type varies
      // across versions (h3, div, span, etc.). Search ALL leaf-ish elements so
      // we find it regardless of where it lands in the DOM.
      const COUNT_RE = /^\d+\s+Logs?$/i;
      let countEl = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')]
        .find(el => COUNT_RE.test(el.textContent.trim()));
      if (!countEl) {
        // Broader fallback: any element whose own text matches (not just headings)
        countEl = [...document.querySelectorAll('*')].find(el => {
          const t = el.textContent.trim();
          return COUNT_RE.test(t) && !el.querySelector('*:not(br)');
          // The !querySelector check avoids matching a parent whose
          // full concatenated text just happens to match.
        });
      }
      const countText = countEl?.textContent.trim() ?? null;

      // ── Read visible rows regardless of count ─────────────────────────────
      // Chronosphere uses MuiDataGrid with a virtual scroller (Virtuoso).
      // After the skeleton clears, the currently visible rows ARE in the DOM
      // as [role="row"] elements. gridcells are NOT used — the full log line
      // appears as row.textContent. We filter for rows that contain log JSON.
      const allRows = [...document.querySelectorAll('[role="row"]')];
      const dataRows = allRows.filter(r => {
        const t = r.textContent;
        return t.includes('FLOW_CRITERIA_LOG') ||
               (t.includes('"description"') && t.includes('"company_id"'));
      });

      // ── Zero confirmed ────────────────────────────────────────────────────
      // Only trust "no results" when BOTH the count says 0 AND no data rows found.
      // If count is missing but rows are present → results exist, proceed.
      // If count says 0 but rows haven't rendered yet → poll a few more times.
      const countIsZero = countText === '0 Logs' || countText === '0 Log';
      const countNotFound = !countText;

      if (countIsZero && dataRows.length === 0) {
        // Only trust "0 Logs" after the query has actually run (progressbar seen).
        // Chronosphere can transiently render "0 Logs" while the page initialises,
        // before the query has even started — reading it here would be a false zero.
        if (!queryHasStarted) return setTimeout(poll, 700);
        return resolve({ noResults: true, count: '0', summaries: [] });
      }

      if (countNotFound && dataRows.length === 0) {
        // Rows haven't rendered yet — poll a few more times before giving up
        if (Date.now() - t0 < 30000) {
          return setTimeout(poll, 800);
        }
        // After 30 s of no count AND no rows → genuinely no results
        return resolve({ noResults: true, count: '0', summaries: [] });
      }

      // ── Has results — rows may still be rendering ─────────────────────────
      if (dataRows.length === 0) {
        // Count says results exist but virtual rows haven't painted yet — wait
        if (Date.now() - t0 < 30000) {
          return setTimeout(poll, 800);
        }
        // After 30 s still no rows → resolve with count but empty summaries
        // (agent can click View in Chronosphere to inspect manually)
        return resolve({ noResults: false, count: countText || '?', summaries: [] });
      }

      const summaries = dataRows.slice(0, 10).map(r => r.textContent.trim().substring(0, 3000));
      return resolve({ noResults: false, count: countText || String(dataRows.length), summaries });
    }

    // Give Chronosphere 3 s to start the query before first check
    setTimeout(poll, 3000);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// ─── SPLUNK HELPERS ───────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function buildSplunkUrl(query, timeRange) {
  const q = encodeURIComponent('search ' + query);
  if (timeRange.startsWith('daterange:')) {
    // format: daterange:YYYY-MM-DD:YYYY-MM-DD
    const parts      = timeRange.slice(10).split(':');
    const startEpoch = Math.floor(new Date(parts[0] + 'T00:00:00Z').getTime() / 1000);
    const endEpoch   = Math.floor(new Date(parts[1] + 'T23:59:59Z').getTime() / 1000);
    return `${SPLUNK_BASE}?q=${q}&earliest=${startEpoch}&latest=${endEpoch}&display.page.search.mode=verbose&dispatch.sample_ratio=1`;
  }
  if (timeRange.startsWith('date:')) {
    const dateStr = timeRange.slice(5);          // 'YYYY-MM-DD'
    const startEpoch = Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 1000);
    const endEpoch   = startEpoch + 86400;       // +24 h
    return `${SPLUNK_BASE}?q=${q}&earliest=${startEpoch}&latest=${endEpoch}&display.page.search.mode=verbose&dispatch.sample_ratio=1`;
  }
  // Relative: timeRange is e.g. "2d", "30m", "4h" — prepend "-"
  // For day-based ranges, add @d rounding to match Splunk dashboard behaviour
  const earliest = /^\d+d$/.test(timeRange) ? `-${timeRange}%40d` : `-${timeRange}`;
  return `${SPLUNK_BASE}?q=${q}&earliest=${earliest}&latest=now&display.page.search.mode=verbose&dispatch.sample_ratio=1`;
}

async function findOrCreateSplunkTab() {
  const tabs = await chrome.tabs.query({ url: 'https://klaviyo.splunkcloud.com/*' });
  if (tabs.length) return tabs[0].id;
  const tab = await chrome.tabs.create({ url: SPLUNK_BASE, active: false });
  return tab.id;
}

async function readSplunkResults(tabId) {
  const res = await chrome.scripting.executeScript({ target: { tabId }, func: extractSplunkLogs });
  return res[0]?.result ?? { noResults: true, count: '0', summaries: [] };
}

// Injected into Splunk tab — must be self-contained
// Polls until search is confirmed complete (with or without results), or 2-min hard timeout.
function extractSplunkLogs() {
  return new Promise((resolve) => {
    const HARD_TIMEOUT = 420000; // 7 minutes
    const t0 = Date.now();

    function poll() {
      // ── Hard timeout ──────────────────────────────────────────────────────
      if (Date.now() - t0 > HARD_TIMEOUT) return resolve({ timeout: true });

      // Completion signal from Splunk's status alerts
      const alerts = [...document.querySelectorAll('[role="alert"]')];
      const done = alerts.some(a => a.textContent.includes('completed'));

      // Event count from the "Events (N)" tab label
      const tabs = [...document.querySelectorAll('[role="tab"]')];
      const eTab = tabs.find(t => /Events/.test(t.textContent));
      const cm = eTab ? eTab.textContent.match(/Events\s*\((\d+)/) : null;
      const count = cm ? parseInt(cm[1]) : null;

      // ── Confirmed zero ────────────────────────────────────────────────────
      // ONLY declare no results after the search is fully done — count starts
      // at 0 while the search is still running and would cause a false negative.
      // tr.noresults is always in the DOM but hidden when there ARE results —
      // only treat as zero when it is actually visible (offsetParent !== null).
      if (done) {
        const noResTr = document.querySelector('tr.noresults');
        const genuinelyNoResults = noResTr && noResTr.offsetParent !== null;
        if (genuinelyNoResults || count === 0) return resolve({ noResults: true, count: '0', summaries: [] });
      }

      // ── Confirmed results ─────────────────────────────────────────────────
      if (done && count && count > 0) {
        const rows = [...document.querySelectorAll('tr.shared-eventsviewer-list-body-row')];
        const summaries = rows.slice(0, 8).map(row => {
          const cell = row.querySelector('td.event') || row.querySelector('td');
          return (cell || row).textContent.trim().substring(0, 600);
        }).filter(Boolean);
        return resolve({ noResults: false, count: String(count), summaries });
      }

      // ── Still running — keep polling ──────────────────────────────────────
      setTimeout(poll, 800);
    }
    setTimeout(poll, 3000); // give Splunk 3 s to start the search before first poll
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// ─── SHARED HELPERS ───────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function navigateAndWait(tabId, url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Navigation timeout (420s)')), 420000);
    const onUpdated = function(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timeout);
        setTimeout(resolve, 2000);
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    // Use window.location.replace() via script injection to force a true full-page
    // reload, bypassing Chronosphere/Splunk SPA router interception that chrome.tabs.update
    // alone may not trigger.
    chrome.scripting.executeScript({
      target: { tabId },
      func: (targetUrl) => { window.location.replace(targetUrl); },
      args: [url]
    }).catch(() => {
      // Fallback: if scripting injection fails (e.g. on a restricted page), fall back
      // to chrome.tabs.update which will still work for cold navigations.
      chrome.tabs.update(tabId, { url });
    });
  });
}

function sendToPanel(msg) {
  if (panelPort) {
    try { panelPort.postMessage(msg); } catch (_) {}
  }
}
