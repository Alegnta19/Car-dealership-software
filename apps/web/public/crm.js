/**
 * RT3 — the CRM, BDC and marketing screens of the staff console.
 *
 * Loaded after app.js, which owns the shell, the router and the fetch wrapper.
 * A classic script's top-level `const` is visible to the scripts that follow
 * it, so this file registers its screens by extending the same ROUTES map the
 * shell renders from — no bundler, no module system, no framework.
 *
 * WHAT THE SCREENS ARE FOR, in the order somebody actually works:
 *
 *   * PIPELINE — every open lead with its age, its owner and whether the
 *     response clock has run out. Red is not decoration here: a breached lead
 *     is the one thing on this screen somebody has to act on today.
 *   * LEAD — one customer's whole story on one timeline, and the four things
 *     you can do about it: answer, book, qualify, hand over.
 *   * CAMPAIGNS — draft, audience, approval and delivery, with the withheld
 *     counts shown beside the sent ones. A screen that showed only what went
 *     out would teach a marketer that the list is small, when it is the
 *     PERMISSION that is small.
 */
'use strict';

/*
 * The shell (app.js) defines these at script scope and this file uses them.
 * Declaring them here is what tells the linter they are provided rather than
 * undefined — there is no module system to import them through.
 */
/* global ROUTES, api, el, modal, toast, reportError, badge, statCard, kvRow, renderApp */

// ── helpers ─────────────────────────────────────────────────────────────────

function crmWhen(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function crmAge(hours) {
  if (hours === null || hours === undefined) return '—';
  if (hours < 1) return Math.round(hours * 60) + 'm';
  if (hours < 48) return Math.round(hours) + 'h';
  return Math.round(hours / 24) + 'd';
}

const LEAD_STATE_LABELS = {
  new: 'New',
  working: 'Working',
  qualified: 'Qualified',
  appointment_set: 'Appointment set',
  handed_off: 'Handed to sales',
  closed: 'Closed',
};

/** What a BDC agent may move a lead to from where it is. Mirrors the service. */
const LEAD_NEXT = {
  new: ['working', 'closed'],
  working: ['qualified', 'closed'],
  qualified: ['appointment_set', 'closed'],
  appointment_set: ['qualified', 'closed'],
  handed_off: [],
  closed: [],
};

const CLOSE_REASONS = [
  'sold_elsewhere',
  'not_interested',
  'unqualified',
  'duplicate',
  'no_contact',
];

// ── pipeline ────────────────────────────────────────────────────────────────

async function renderCrmPipeline(root) {
  const [overview, list] = await Promise.all([
    api('GET', '/api/crm/overview'),
    api('GET', '/api/crm/leads'),
  ]);

  root.appendChild(
    el('div', { class: 'stat-row' }, [
      statCard(overview.leads.open, 'Open leads'),
      statCard(overview.sla.awaitingFirstResponse, 'Awaiting first reply'),
      statCard(overview.sla.breached, 'Past the target'),
      statCard(overview.appointments.upcoming, 'Appointments booked'),
      statCard(
        overview.sla.medianFirstResponseMinutes === null
          ? '—'
          : overview.sla.medianFirstResponseMinutes + 'm',
        'Median reply',
      ),
    ]),
  );

  const table = el('table', { class: 'grid' });
  table.appendChild(
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Customer' }),
        el('th', { text: 'Rooftop' }),
        el('th', { text: 'Source' }),
        el('th', { text: 'Interest' }),
        el('th', { text: 'State' }),
        el('th', { text: 'Age' }),
        el('th', { text: 'First reply' }),
      ]),
    ]),
  );
  const body = el('tbody');
  for (const lead of list.leads) {
    const row = el('tr', {
      class: 'clickable',
      onclick: function () {
        location.hash = '#/lead/' + lead.leadId;
      },
    });
    row.appendChild(el('td', { text: lead.customerName }));
    row.appendChild(el('td', { text: lead.rooftopName }));
    row.appendChild(el('td', { text: lead.sourceCode }));
    row.appendChild(el('td', { text: lead.interestSummary || '—' }));
    row.appendChild(
      el('td', {}, [badge(LEAD_STATE_LABELS[lead.lifecycleState] || lead.lifecycleState)]),
    );
    row.appendChild(el('td', { text: crmAge(lead.ageHours) }));
    // The one cell somebody scans for: answered, waiting, or late.
    row.appendChild(
      el('td', {}, [
        lead.firstResponseAt
          ? badge('answered')
          : lead.slaBreached
            ? badge('LATE', 'danger')
            : badge('waiting', 'warn'),
      ]),
    );
    body.appendChild(row);
  }
  table.appendChild(body);
  if (list.leads.length === 0) {
    root.appendChild(el('p', { class: 'empty', text: 'No leads yet.' }));
  } else {
    root.appendChild(table);
  }

  root.appendChild(
    el('div', { class: 'actions' }, [
      el('button', { text: 'Capture a lead', onclick: () => captureLeadDialog() }),
    ]),
  );
}

function captureLeadDialog() {
  modal('Capture a lead', async function (box, close) {
    const sources = await api('GET', '/api/crm/sources');
    const overview = await api('GET', '/api/crm/overview');
    const form = {
      location_id: (overview.rooftops[0] || {}).rooftopId || '',
      source_code: (sources.sources[0] || {}).sourceCode || '',
      channel: 'manual',
    };
    const field = (label, key, type) =>
      el('label', {}, [
        el('span', { text: label }),
        el('input', {
          type: type || 'text',
          oninput: function (e) {
            form[key] = e.target.value;
          },
        }),
      ]);
    box.appendChild(
      el('label', {}, [
        el('span', { text: 'Rooftop' }),
        el(
          'select',
          {
            onchange: function (e) {
              form.location_id = e.target.value;
            },
          },
          overview.rooftops.map((r) => el('option', { value: r.rooftopId, text: r.name })),
        ),
      ]),
    );
    box.appendChild(
      el('label', {}, [
        el('span', { text: 'Source' }),
        el(
          'select',
          {
            onchange: function (e) {
              form.source_code = e.target.value;
            },
          },
          sources.sources.map((s) => el('option', { value: s.sourceCode, text: s.displayName })),
        ),
      ]),
    );
    box.appendChild(field('First name', 'given_name'));
    box.appendChild(field('Last name', 'family_name'));
    box.appendChild(field('Email', 'email', 'email'));
    box.appendChild(field('Phone', 'phone'));
    box.appendChild(
      el('div', { class: 'actions' }, [
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
        el('button', {
          text: 'Capture',
          onclick: async function () {
            try {
              const result = await api(
                'POST',
                '/api/crm/leads',
                {
                  location_id: form.location_id,
                  // The customer's own details ARE the intake key here: a staff
                  // member who submits the same person twice gets one lead.
                  intake_key: 'console:' + (form.email || form.phone || Date.now()),
                  channel: 'manual',
                  source_code: form.source_code,
                  customer: {
                    given_name: form.given_name,
                    family_name: form.family_name,
                    email: form.email,
                    phone: form.phone,
                  },
                },
                { idempotent: true },
              );
              close();
              toast(
                result.outcome === 'merged_into_existing'
                  ? 'That customer already had an open lead — opening it.'
                  : 'Lead captured.',
              );
              location.hash = '#/lead/' + result.lead.leadId;
            } catch (err) {
              reportError(err);
            }
          },
        }),
      ]),
    );
  });
}

// ── one lead ────────────────────────────────────────────────────────────────

async function renderCrmLead(root) {
  // The shell renders with the view element alone and leaves the rest of the
  // hash to the screen, exactly as the vehicle detail does. Reading it here is
  // what makes `#/lead/<id>` a bookmarkable address rather than a click.
  const leadId = (location.hash.split('/')[2] || '').trim();
  if (!leadId) {
    root.appendChild(el('p', { class: 'muted', text: 'No lead selected.' }));
    return;
  }
  const detail = await api('GET', '/api/crm/leads/' + leadId);
  const lead = detail.lead;

  root.appendChild(
    el('div', { class: 'stat-row' }, [
      statCard(LEAD_STATE_LABELS[lead.lifecycleState] || lead.lifecycleState, 'State'),
      statCard(lead.firstResponseAt ? crmWhen(lead.firstResponseAt) : 'not yet', 'First reply'),
      statCard(lead.firstResponseDueAt ? crmWhen(lead.firstResponseDueAt) : '—', 'Reply due'),
      // Two deadlines, because they mean two different things.
      statCard(lead.escalateAt ? crmWhen(lead.escalateAt) : '—', 'Escalates'),
      statCard(lead.escalatedAt ? crmWhen(lead.escalatedAt) : 'no', 'Escalated'),
    ]),
  );

  const facts = el('div', { class: 'facts' });
  facts.appendChild(kvRow('Owner', lead.ownerUserLinkId || 'unassigned'));
  facts.appendChild(kvRow('Disposition', lead.disposition || '—'));
  facts.appendChild(kvRow('Captured', crmWhen(lead.createdAt)));
  if (lead.handedOffAt) facts.appendChild(kvRow('Handed to sales', crmWhen(lead.handedOffAt)));
  root.appendChild(facts);

  // ── the actions, filtered by what the machine actually allows ────────────
  const actions = el('div', { class: 'actions' });
  if (lead.lifecycleState !== 'handed_off' && lead.lifecycleState !== 'closed') {
    actions.appendChild(
      el('button', { text: 'Log activity', onclick: () => logActivityDialog(lead) }),
    );
    actions.appendChild(
      el('button', { text: 'Book appointment', onclick: () => bookAppointmentDialog(lead) }),
    );
    for (const next of LEAD_NEXT[lead.lifecycleState] || []) {
      actions.appendChild(
        el('button', {
          class: 'ghost',
          text: next === 'closed' ? 'Close lead' : 'Mark ' + LEAD_STATE_LABELS[next],
          onclick: () => transitionDialog(lead, next),
        }),
      );
    }
    if (lead.lifecycleState === 'qualified' || lead.lifecycleState === 'appointment_set') {
      actions.appendChild(
        el('button', { text: 'Hand to sales', onclick: () => handoffDialog(lead) }),
      );
    }
  } else {
    actions.appendChild(
      el('p', {
        class: 'empty',
        text:
          lead.lifecycleState === 'handed_off'
            ? 'This lead belongs to sales now. The CRM stops here.'
            : 'This lead is closed.',
      }),
    );
  }
  root.appendChild(actions);

  // ── the one timeline ─────────────────────────────────────────────────────
  root.appendChild(el('h3', { text: 'Timeline' }));
  const list = el('ol', { class: 'timeline' });
  for (const entry of detail.timeline) {
    list.appendChild(
      el('li', {}, [
        el('span', { class: 'when', text: crmWhen(entry.at) }),
        badge(entry.kind),
        el('span', { text: entry.summary }),
        entry.detail ? el('span', { class: 'muted', text: entry.detail }) : el('span'),
      ]),
    );
  }
  root.appendChild(detail.timeline.length === 0 ? el('p', { class: 'empty', text: '—' }) : list);
}

function logActivityDialog(lead) {
  modal('Log activity', function (box, close) {
    const form = { kind: 'call', direction: 'outbound', subject: '', body: '' };
    box.appendChild(
      el('label', {}, [
        el('span', { text: 'Kind' }),
        el(
          'select',
          {
            onchange: function (e) {
              form.kind = e.target.value;
            },
          },
          ['call', 'email', 'sms', 'note', 'task', 'reminder'].map((k) =>
            el('option', { value: k, text: k }),
          ),
        ),
      ]),
    );
    box.appendChild(
      el('label', {}, [
        el('span', { text: 'Direction' }),
        el(
          'select',
          {
            onchange: function (e) {
              form.direction = e.target.value;
            },
          },
          ['outbound', 'inbound'].map((d) => el('option', { value: d, text: d })),
        ),
      ]),
    );
    box.appendChild(
      el('label', {}, [
        el('span', { text: 'Subject' }),
        el('input', {
          oninput: function (e) {
            form.subject = e.target.value;
          },
        }),
      ]),
    );
    box.appendChild(
      el('label', {}, [
        el('span', { text: 'Notes' }),
        el('textarea', {
          oninput: function (e) {
            form.body = e.target.value;
          },
        }),
      ]),
    );
    box.appendChild(
      el('div', { class: 'actions' }, [
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
        el('button', {
          text: 'Log it',
          onclick: async function () {
            try {
              const payload = { kind: form.kind, subject: form.subject, body: form.body };
              // Only a communication carries a direction; the service refuses
              // one on a note, so the screen does not send one.
              if (['call', 'email', 'sms'].indexOf(form.kind) >= 0) {
                payload.direction = form.direction;
              }
              await api('POST', '/api/crm/leads/' + lead.leadId + '/activities', payload, {
                idempotent: true,
              });
              close();
              toast('Logged.');
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
      ]),
    );
  });
}

function bookAppointmentDialog(lead) {
  modal('Book an appointment', function (box, close) {
    const start = new Date(Date.now() + 86400000);
    const form = {
      purpose: 'test_drive',
      starts_at: start.toISOString().slice(0, 16),
      minutes: 60,
    };
    box.appendChild(
      el('label', {}, [
        el('span', { text: 'Purpose' }),
        el(
          'select',
          {
            onchange: function (e) {
              form.purpose = e.target.value;
            },
          },
          ['test_drive', 'showroom_visit', 'consultation', 'delivery_preview', 'callback'].map(
            (p) => el('option', { value: p, text: p.replace(/_/g, ' ') }),
          ),
        ),
      ]),
    );
    box.appendChild(
      el('label', {}, [
        el('span', { text: 'Starts' }),
        el('input', {
          type: 'datetime-local',
          value: form.starts_at,
          oninput: function (e) {
            form.starts_at = e.target.value;
          },
        }),
      ]),
    );
    box.appendChild(
      el('div', { class: 'actions' }, [
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
        el('button', {
          text: 'Book',
          onclick: async function () {
            try {
              const starts = new Date(form.starts_at);
              await api(
                'POST',
                '/api/crm/leads/' + lead.leadId + '/appointments',
                {
                  purpose: form.purpose,
                  starts_at: starts.toISOString(),
                  ends_at: new Date(starts.getTime() + form.minutes * 60000).toISOString(),
                },
                { idempotent: true },
              );
              close();
              toast('Appointment booked.');
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
      ]),
    );
  });
}

function transitionDialog(lead, toState) {
  modal(toState === 'closed' ? 'Close this lead' : 'Move this lead', function (box, close) {
    const form = { disposition: CLOSE_REASONS[0], note: '' };
    if (toState === 'closed') {
      box.appendChild(
        el('label', {}, [
          el('span', { text: 'Why' }),
          el(
            'select',
            {
              onchange: function (e) {
                form.disposition = e.target.value;
              },
            },
            CLOSE_REASONS.map((r) => el('option', { value: r, text: r.replace(/_/g, ' ') })),
          ),
        ]),
      );
    }
    box.appendChild(
      el('label', {}, [
        el('span', { text: 'Note' }),
        el('input', {
          oninput: function (e) {
            form.note = e.target.value;
          },
        }),
      ]),
    );
    box.appendChild(
      el('div', { class: 'actions' }, [
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
        el('button', {
          text: 'Confirm',
          onclick: async function () {
            try {
              const payload = {
                expected_version: lead.authorizationVersion,
                to_state: toState,
                note: form.note,
              };
              if (toState === 'closed') payload.disposition = form.disposition;
              await api('POST', '/api/crm/leads/' + lead.leadId + '/transition', payload);
              close();
              toast('Updated.');
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
      ]),
    );
  });
}

function handoffDialog(lead) {
  modal('Hand this lead to sales', function (box, close) {
    box.appendChild(
      el('p', {
        text:
          'What sales receives is frozen at this moment. The CRM stops here: after the ' +
          'handoff this lead can no longer be reassigned or moved from these screens.',
      }),
    );
    const form = { handed_to_user_link_id: '' };
    box.appendChild(
      el('label', {}, [
        el('span', { text: 'Salesperson (user link id)' }),
        el('input', {
          oninput: function (e) {
            form.handed_to_user_link_id = e.target.value;
          },
        }),
      ]),
    );
    box.appendChild(
      el('div', { class: 'actions' }, [
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
        el('button', {
          text: 'Hand over',
          onclick: async function () {
            try {
              await api('POST', '/api/crm/leads/' + lead.leadId + '/handoff', {
                expected_version: lead.authorizationVersion,
                handed_to_user_link_id: form.handed_to_user_link_id,
              });
              close();
              toast('Handed to sales.');
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
      ]),
    );
  });
}

// ── campaigns ───────────────────────────────────────────────────────────────

async function renderCrmCampaigns(root) {
  const [overview, board] = await Promise.all([
    api('GET', '/api/crm/overview'),
    api('GET', '/api/crm/campaigns'),
  ]);

  root.appendChild(
    el('div', { class: 'stat-row' }, [
      statCard(overview.campaigns.active, 'Active campaigns'),
      statCard(overview.campaigns.executing, 'Sending now'),
      statCard(overview.campaigns.sent, 'Delivered'),
      statCard(overview.campaigns.suppressed, 'Withheld'),
      statCard(overview.campaigns.deferred, 'Held for quiet hours'),
      statCard(overview.campaigns.responses, 'Replies'),
      statCard(overview.campaigns.optOuts, 'Opt-outs'),
    ]),
  );

  // The honest headline: this platform has no sale yet, so it has no revenue
  // to attribute. Saying so is the point — an omitted figure reads as zero.
  root.appendChild(
    el('div', { class: 'notice' }, [
      el('strong', { text: 'Revenue and ROI: ' + overview.revenueStatus + '. ' }),
      el('span', {
        text:
          'Attribution credits sources and campaigns today. Money is reported as ' +
          'unavailable rather than as zero, because no sale exists in this platform yet.',
      }),
    ]),
  );

  root.appendChild(
    el('div', { class: 'actions' }, [
      el('button', { text: 'New campaign', onclick: () => createCampaignDialog(overview) }),
      el('button', {
        class: 'ghost',
        text: 'Consent & suppression',
        onclick: () => (location.hash = '#/consent'),
      }),
      el('button', {
        class: 'ghost',
        text: 'Compute attribution',
        onclick: () => computeAttribution(overview),
      }),
    ]),
  );

  root.appendChild(el('h3', { text: 'Campaigns' }));
  if (board.campaigns.length === 0) {
    root.appendChild(el('p', { class: 'empty', text: 'No campaigns yet.' }));
  }
  for (const campaign of board.campaigns) {
    const card = el('div', { class: 'panel' });
    card.appendChild(
      el('h4', {}, [
        el('span', { text: campaign.name + ' ' }),
        badge(campaign.status),
        el('span', {
          class: 'muted',
          text:
            ' ' +
            campaign.rooftopName +
            ' · ' +
            campaign.channel +
            ' · ' +
            campaign.purpose +
            ' · quiet hours ' +
            campaign.quietHours,
        }),
      ]),
    );

    const table = el('table', { class: 'grid' });
    table.appendChild(
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Version' }),
          el('th', { text: 'State' }),
          el('th', { text: 'Audience' }),
          el('th', { text: 'Delivered' }),
          el('th', { text: 'Withheld' }),
          el('th', { text: 'Next step' }),
        ]),
      ]),
    );
    const rows = el('tbody');
    for (const version of campaign.versions) {
      const cells = el('tr');
      cells.appendChild(el('td', { text: 'v' + version.versionNumber }));
      cells.appendChild(el('td', {}, [badge(version.state)]));
      cells.appendChild(el('td', { text: String(version.audienceSize) }));
      cells.appendChild(el('td', { text: String(version.sent) }));
      cells.appendChild(el('td', { text: String(version.withheld) }));
      cells.appendChild(el('td', {}, [versionActions(campaign, version)]));
      rows.appendChild(cells);
    }
    table.appendChild(rows);
    card.appendChild(
      campaign.versions.length === 0
        ? el('p', { class: 'empty', text: 'No versions drafted.' })
        : table,
    );
    card.appendChild(
      el('div', { class: 'actions' }, [
        el('button', {
          class: 'ghost',
          text: 'Draft a version',
          onclick: () => draftVersionDialog(campaign),
        }),
      ]),
    );
    root.appendChild(card);
  }

  root.appendChild(el('h3', { text: 'Leads by source' }));
  const sources = el('table', { class: 'grid' });
  sources.appendChild(
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Source' }),
        el('th', { text: 'Code' }),
        el('th', { text: 'Leads' }),
      ]),
    ]),
  );
  const sourceRows = el('tbody');
  for (const source of overview.bySource) {
    sourceRows.appendChild(
      el('tr', {}, [
        el('td', { text: source.displayName }),
        el('td', { text: source.sourceCode }),
        el('td', { text: String(source.leads) }),
      ]),
    );
  }
  sources.appendChild(sourceRows);
  root.appendChild(sources);
}

/**
 * WHAT A VERSION CAN DO NEXT, and only that. The state machine lives in the
 * service; showing a button the service would refuse teaches an operator that
 * the screen is unreliable.
 */
function versionActions(campaign, version) {
  const box = el('span', { class: 'actions inline' });
  if (version.state === 'draft') {
    box.appendChild(
      el('button', {
        class: 'ghost',
        text: 'Build audience',
        onclick: () => buildAudienceDialog(campaign, version),
      }),
    );
    if (version.audienceSize > 0) {
      box.appendChild(
        el('button', {
          text: 'Approve',
          onclick: () => approveVersion(campaign, version),
        }),
      );
    }
  } else if (version.state === 'approved') {
    box.appendChild(
      el('button', { text: 'Launch', onclick: () => launchVersion(campaign, version) }),
    );
  } else {
    box.appendChild(
      el('button', {
        class: 'ghost',
        text: 'Delivery',
        onclick: () => deliveryDialog(campaign, version),
      }),
    );
  }
  return box;
}

function createCampaignDialog(overview) {
  modal('New campaign', async function (box, close) {
    const sources = await api('GET', '/api/crm/sources');
    const form = {
      location_id: (overview.rooftops[0] || {}).rooftopId || '',
      source_code: (sources.sources[0] || {}).sourceCode || '',
      channel: 'email',
      purpose: 'sales_marketing',
      quiet_hours_start_minute: 1260,
      quiet_hours_end_minute: 480,
      time_zone: 'UTC',
      name: '',
    };
    const select = (label, key, options) =>
      el('label', {}, [
        el('span', { text: label }),
        el(
          'select',
          {
            onchange: function (e) {
              form[key] = e.target.value;
            },
          },
          options.map((o) => el('option', { value: o.value, text: o.text })),
        ),
      ]);
    box.appendChild(
      el('label', {}, [
        el('span', { text: 'Name' }),
        el('input', {
          oninput: function (e) {
            form.name = e.target.value;
          },
        }),
      ]),
    );
    box.appendChild(
      select(
        'Rooftop',
        'location_id',
        overview.rooftops.map((r) => ({ value: r.rooftopId, text: r.name })),
      ),
    );
    box.appendChild(
      select(
        'Source',
        'source_code',
        sources.sources.map((s) => ({ value: s.sourceCode, text: s.displayName })),
      ),
    );
    box.appendChild(
      select('Channel', 'channel', [
        { value: 'email', text: 'email' },
        { value: 'sms', text: 'sms' },
      ]),
    );
    // No 'transactional' option: transactional messages are not campaigns, and
    // offering it here would let marketing borrow the one consent class a
    // customer cannot refuse.
    box.appendChild(
      select('Purpose', 'purpose', [
        { value: 'sales_marketing', text: 'sales marketing' },
        { value: 'service_reminder', text: 'service reminder' },
        { value: 'research', text: 'research' },
      ]),
    );
    box.appendChild(
      el('p', {
        class: 'muted',
        text: 'Quiet hours default to 21:00–08:00. Messages due inside the window wait for morning.',
      }),
    );
    box.appendChild(
      el('div', { class: 'actions' }, [
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
        el('button', {
          text: 'Create',
          onclick: async function () {
            try {
              await api('POST', '/api/crm/campaigns', form, { idempotent: true });
              close();
              toast('Campaign created.');
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
      ]),
    );
  });
}

function draftVersionDialog(campaign) {
  modal('Draft a version of ' + campaign.name, function (box, close) {
    const form = { subject: '', body: '', includes_opt_out: true };
    box.appendChild(
      el('label', {}, [
        el('span', { text: 'Subject' }),
        el('input', {
          oninput: function (e) {
            form.subject = e.target.value;
          },
        }),
      ]),
    );
    box.appendChild(
      el('label', {}, [
        el('span', { text: 'Message' }),
        el('textarea', {
          rows: '6',
          oninput: function (e) {
            form.body = e.target.value;
          },
        }),
      ]),
    );
    box.appendChild(
      el('label', {}, [
        el('span', { text: 'Carries a way to opt out' }),
        el('input', {
          type: 'checkbox',
          checked: 'checked',
          onchange: function (e) {
            form.includes_opt_out = e.target.checked;
          },
        }),
      ]),
    );
    box.appendChild(
      el('p', {
        class: 'muted',
        text:
          'A marketing version cannot be approved without one. The message a version ' +
          'freezes is the message that goes out — editing the campaign later does not ' +
          'change what was already sent.',
      }),
    );
    box.appendChild(
      el('div', { class: 'actions' }, [
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
        el('button', {
          text: 'Draft',
          onclick: async function () {
            try {
              await api('POST', '/api/crm/campaigns/' + campaign.campaignId + '/versions', form, {
                idempotent: true,
              });
              close();
              toast('Version drafted.');
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
      ]),
    );
  });
}

function buildAudienceDialog(campaign, version) {
  modal('Audience for v' + version.versionNumber, function (box, close) {
    const form = { rule: 'all_active_customers' };
    box.appendChild(
      el('label', {}, [
        el('span', { text: 'Who' }),
        el(
          'select',
          {
            onchange: function (e) {
              form.rule = e.target.value;
            },
          },
          [
            { value: 'all_active_customers', text: 'every current customer' },
            { value: 'open_leads', text: 'customers with an open lead here' },
            { value: 'prior_buyers', text: 'people we acquired a vehicle from' },
          ].map((o) => el('option', { value: o.value, text: o.text })),
        ),
      ]),
    );
    const result = el('div');
    box.appendChild(result);
    box.appendChild(
      el('div', { class: 'actions' }, [
        el('button', { class: 'ghost', text: 'Close', onclick: close }),
        el('button', {
          text: 'Resolve audience',
          onclick: async function () {
            try {
              const built = await api(
                'POST',
                '/api/crm/campaigns/' +
                  campaign.campaignId +
                  '/versions/' +
                  version.campaignVersionId +
                  '/audience',
                form,
              );
              result.textContent = '';
              const a = built.audience;
              // The exclusions are shown, itemized. A marketer who asks for
              // nine hundred customers and reaches four hundred needs to know
              // that five hundred have not agreed to be contacted — otherwise
              // they go looking for a data problem that is not there.
              result.appendChild(
                el('table', { class: 'grid' }, [
                  el('tbody', {}, [
                    kvRow('Considered', a.considered),
                    kvRow('Will receive it', a.included),
                    kvRow('No usable address', a.excludedNoContact),
                    kvRow('Have not agreed', a.excludedNoConsent),
                    kvRow('Asked us to stop', a.excludedSuppressed),
                  ]),
                ]),
              );
              toast('Audience resolved: ' + a.included + ' of ' + a.considered + '.');
            } catch (err) {
              reportError(err);
            }
          },
        }),
        el('button', {
          text: 'Done',
          onclick: function () {
            close();
            renderApp();
          },
        }),
      ]),
    );
  });
}

async function approveVersion(campaign, version) {
  try {
    await api(
      'POST',
      '/api/crm/campaigns/' +
        campaign.campaignId +
        '/versions/' +
        version.campaignVersionId +
        '/approve',
      { expected_version: version.authorizationVersion },
    );
    toast('Version approved.');
    renderApp();
  } catch (err) {
    reportError(err);
  }
}

async function launchVersion(campaign, version) {
  try {
    const launched = await api(
      'POST',
      '/api/crm/campaigns/' +
        campaign.campaignId +
        '/versions/' +
        version.campaignVersionId +
        '/execute',
      { expected_version: version.authorizationVersion },
    );
    toast(
      'Queued ' +
        launched.prepared.prepared +
        ' message(s); ' +
        launched.prepared.withheld +
        ' withheld. Permission is checked again before each one is sent.',
    );
    renderApp();
  } catch (err) {
    reportError(err);
  }
}

function deliveryDialog(campaign, version) {
  modal('Delivery for v' + version.versionNumber, async function (box, close) {
    const { sends } = await api(
      'GET',
      '/api/crm/campaigns/' +
        campaign.campaignId +
        '/versions/' +
        version.campaignVersionId +
        '/sends',
    );
    const table = el('table', { class: 'grid' });
    table.appendChild(
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Customer' }),
          el('th', { text: 'State' }),
          el('th', { text: 'Why withheld' }),
          el('th', { text: 'Attempts' }),
          el('th', { text: 'Responses' }),
          el('th', { text: '' }),
        ]),
      ]),
    );
    const rows = el('tbody');
    for (const send of sends) {
      const tr = el('tr');
      tr.appendChild(el('td', { text: send.customerName }));
      tr.appendChild(el('td', {}, [badge(send.state)]));
      tr.appendChild(el('td', { text: (send.withheldReason || '—').replace(/_/g, ' ') }));
      tr.appendChild(el('td', { text: String(send.attempts) }));
      tr.appendChild(el('td', { text: send.responses.join(', ') || '—' }));
      const actions = el('td');
      if (send.state === 'sent') {
        for (const kind of ['reply', 'opt_out']) {
          actions.appendChild(
            el('button', {
              class: 'ghost',
              text: kind === 'reply' ? 'Log reply' : 'Log opt-out',
              onclick: async function () {
                try {
                  const done = await api(
                    'POST',
                    '/api/crm/campaigns/' +
                      campaign.campaignId +
                      '/sends/' +
                      send.sendId +
                      '/response',
                    { response_type: kind },
                  );
                  toast(
                    kind === 'reply'
                      ? done.leadId
                        ? 'Reply recorded — it became a lead.'
                        : 'Reply already recorded.'
                      : 'Opt-out recorded. They will not be contacted again.',
                  );
                  close();
                  renderApp();
                } catch (err) {
                  reportError(err);
                }
              },
            }),
          );
        }
      }
      tr.appendChild(actions);
      rows.appendChild(tr);
    }
    table.appendChild(rows);
    box.appendChild(
      sends.length === 0 ? el('p', { class: 'empty', text: 'Nothing queued.' }) : table,
    );
    box.appendChild(
      el('div', { class: 'actions' }, [
        el('button', { class: 'ghost', text: 'Close', onclick: close }),
      ]),
    );
  });
}

async function computeAttribution(overview) {
  try {
    const rooftop = (overview.rooftops[0] || {}).rooftopId;
    const now = new Date();
    const run = await api('POST', '/api/crm/attribution', {
      location_id: rooftop,
      model: 'linear',
      window_start: new Date(now.getTime() - 30 * 86400000).toISOString(),
      window_end: new Date(now.getTime() + 86400000).toISOString(),
    });
    toast(
      'Credited ' +
        run.run.touchesCredited +
        ' touches across ' +
        run.run.leadsConsidered +
        ' leads. Revenue: ' +
        run.run.revenueStatus +
        '.',
    );
    renderApp();
  } catch (err) {
    reportError(err);
  }
}

// ── consent and suppression ─────────────────────────────────────────────────

async function renderCrmConsent(root) {
  const { suppressions } = await api('GET', '/api/crm/suppressions');

  root.appendChild(
    el('div', { class: 'notice' }, [
      el('strong', { text: 'Permission is checked twice. ' }),
      el('span', {
        text:
          'Once when an audience is built, and again in the moment before each message ' +
          'is handed to a provider — so somebody who opts out after a campaign is ' +
          'approved still does not receive it.',
      }),
    ]),
  );

  root.appendChild(el('h3', { text: 'Suppressed contacts' }));
  const table = el('table', { class: 'grid' });
  table.appendChild(
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Contact' }),
        el('th', { text: 'Kind' }),
        el('th', { text: 'Reason' }),
        el('th', { text: 'Since' }),
      ]),
    ]),
  );
  const rows = el('tbody');
  for (const s of suppressions) {
    rows.appendChild(
      el('tr', {}, [
        el('td', { text: s.contactValue }),
        el('td', { text: s.contactKind }),
        el('td', { text: s.reason.replace(/_/g, ' ') }),
        el('td', { text: crmWhen(s.createdAt) }),
      ]),
    );
  }
  table.appendChild(rows);
  root.appendChild(
    suppressions.length === 0
      ? el('p', { class: 'empty', text: 'Nobody has asked to be left alone.' })
      : table,
  );

  root.appendChild(
    el('div', { class: 'actions' }, [
      el('button', { text: 'Suppress a contact', onclick: () => suppressDialog() }),
    ]),
  );
}

function suppressDialog() {
  modal('Stop contacting an address', function (box, close) {
    const form = { contact_kind: 'email', contact_value: '', reason: 'do_not_contact' };
    box.appendChild(
      el('label', {}, [
        el('span', { text: 'Kind' }),
        el(
          'select',
          {
            onchange: function (e) {
              form.contact_kind = e.target.value;
            },
          },
          ['email', 'phone'].map((k) => el('option', { value: k, text: k })),
        ),
      ]),
    );
    box.appendChild(
      el('label', {}, [
        el('span', { text: 'Address or number' }),
        el('input', {
          oninput: function (e) {
            form.contact_value = e.target.value;
          },
        }),
      ]),
    );
    box.appendChild(
      el('label', {}, [
        el('span', { text: 'Reason' }),
        el(
          'select',
          {
            onchange: function (e) {
              form.reason = e.target.value;
            },
          },
          ['do_not_contact', 'unsubscribe', 'complaint', 'bounce', 'manual'].map((r) =>
            el('option', { value: r, text: r.replace(/_/g, ' ') }),
          ),
        ),
      ]),
    );
    box.appendChild(
      el('p', {
        class: 'muted',
        text:
          'Suppression is recorded against the ADDRESS, not the customer record, so it ' +
          'survives a merge or a second record for the same person.',
      }),
    );
    box.appendChild(
      el('div', { class: 'actions' }, [
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
        el('button', {
          text: 'Suppress',
          onclick: async function () {
            try {
              await api('POST', '/api/crm/suppressions', form, { idempotent: true });
              close();
              toast('Recorded. They will not be contacted again.');
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
      ]),
    );
  });
}

// ── registration ────────────────────────────────────────────────────────────

ROUTES.pipeline = { title: 'Pipeline', render: renderCrmPipeline };
ROUTES.campaigns = { title: 'Campaigns', render: renderCrmCampaigns };
ROUTES.consent = { title: 'Consent', render: renderCrmConsent };
// Reached from a pipeline row rather than the navigation, so it is hidden from
// the sidebar by the shell's own filter.
ROUTES.lead = { title: 'Lead', render: renderCrmLead, hidden: true };
