/**
 * FBL-120 — the appraisal and desking screens of the staff console.
 *
 * Loaded after app.js, which owns the shell, the router and the fetch wrapper,
 * and after sales.js, whose `picker()` primitive this file reuses: a classic
 * script's top-level function is visible to the scripts that follow it, so
 * there is no bundler, no module system and no framework here either.
 *
 * NOBODY TYPES AN IDENTIFIER. A desk file is opened from the list of
 * desking-ready customers the server filtered to the rooftops this person
 * works; every other id — the file, its appraisal, its versions — comes from a
 * row already on the screen.
 *
 * WHAT THE SCREENS ARE FOR, in the order a desk actually works:
 *
 *   * DESK — every open file across the rooftops this person works, what is
 *     waiting on a manager, and the exceptions somebody has to do something
 *     about. The screen a desk manager keeps open all Saturday.
 *   * DESK FILE — one customer: the trade and what was found on it, the priced
 *     versions side by side, and the one decision that freezes exactly one of
 *     them.
 *
 * MONEY IS INTEGER CENTS ON THE WIRE AND A FORMATTED STRING ON THE SCREEN. The
 * API sends and receives decimal strings of cents — "4550000" — because JSON
 * has no bigint and a float loses the cent that a customer notices. `dollars()`
 * is the only place that turns one into something to read, and `cents()` the
 * only place that turns what somebody typed back into one.
 *
 * WHAT IS DELIBERATELY NOT HERE: a gross, a commission, a close rate, a
 * contract, a delivery and any way to record a sale. This phase ends at an
 * approved priced version that is READY for the deal jacket. The board says so
 * in as many words rather than leaving a blank column to be read as a zero.
 */
'use strict';

/* global ROUTES, api, el, modal, toast, reportError, badge, statCard, renderApp, picker, salesAgo, salesWhen */

// ── money, in and out ───────────────────────────────────────────────────────

/** Cents (a string from the API) as money somebody can read. */
function dollars(centsText) {
  if (centsText === null || centsText === undefined || centsText === '') return '—';
  const negative = String(centsText).charAt(0) === '-';
  const digits = String(centsText).replace('-', '').padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (negative ? '-$' : '$') + whole + '.' + digits.slice(-2);
}

/**
 * What somebody typed, as whole cents.
 *
 * A desk types "45500" or "45,500.00" and means the same thing both times, so
 * both are accepted and anything else is refused HERE rather than by the
 * server — a form that sends nonsense and waits for a 400 is a form that made
 * the person wait to be told what they already knew.
 */
function cents(text) {
  const cleaned = String(text === null || text === undefined ? '' : text)
    .replace(/[$,\s]/g, '')
    .trim();
  if (cleaned === '') return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const negative = cleaned.charAt(0) === '-';
  const [whole, part] = cleaned.replace('-', '').split('.');
  const minor = (part || '').padEnd(2, '0');
  return (negative ? '-' : '') + String(BigInt(whole) * 100n + BigInt(minor));
}

/** A rate in parts per million, as the percentage a desk quotes. */
function percent(ppm) {
  if (ppm === null || ppm === undefined) return '—';
  return (Number(ppm) / 10000).toFixed(2) + '%';
}

function ppm(text) {
  const cleaned = String(text || '')
    .replace(/[%\s]/g, '')
    .trim();
  if (cleaned === '') return null;
  if (!/^\d+(\.\d{1,4})?$/.test(cleaned)) return undefined;
  return String(Math.round(Number(cleaned) * 10000));
}

const SCENARIO_TONE = {
  draft: 'muted',
  submitted: 'warn',
  approved: 'ok',
  rejected: 'bad',
  expired: 'muted',
  superseded: 'muted',
};

// ── the board ───────────────────────────────────────────────────────────────

async function renderDeskBoard(view) {
  const data = await api('GET', '/api/desking/board');
  const board = data.board;

  view.appendChild(
    el('div', { class: 'stats' }, [
      statCard(board.openCases, 'Open files'),
      statCard(board.awaitingApproval, 'Waiting on a decision'),
      statCard(board.approvedCases, 'Approved'),
    ]),
  );

  // WHAT THIS PHASE DOES NOT KNOW, said rather than left blank. A missing
  // column reads as a zero, and a zero gross is a claim.
  view.appendChild(
    el('p', { class: 'muted' }, [
      'Gross, revenue, commission, close rate, ROI, the deal record, sold inventory and ' +
        'delivery are NOT_YET_AVAILABLE in this phase. An approved version is a priced ' +
        'proposal a manager signed off — no money has moved and no contract exists.',
    ]),
  );

  view.appendChild(
    el('button', {
      class: 'primary',
      text: 'Open a desk file',
      onclick: openDeskFileDialog,
    }),
  );

  if (board.rows.length === 0) {
    view.appendChild(el('p', { class: 'muted', text: 'No desk files at the rooftops you work.' }));
    return;
  }

  const rows = board.rows.map(function (row) {
    return el(
      'tr',
      {
        onclick: function () {
          location.hash = '#/deskfile/' + row.deskingCaseId;
        },
      },
      [
        el('td', { text: row.customerName }),
        el('td', null, [badge(row.state, row.state === 'approved' ? 'ok' : 'muted')]),
        el('td', {
          text:
            row.latestVersionNo === null
              ? 'none'
              : 'v' + row.latestVersionNo + ' of ' + row.versions,
        }),
        el('td', null, [
          row.latestState === null
            ? el('span', { class: 'muted', text: '—' })
            : badge(row.latestState, SCENARIO_TONE[row.latestState] || 'muted'),
        ]),
        el('td', { text: dollars(row.amountFinancedCents) }),
        el('td', { text: dollars(row.monthlyPaymentCents) }),
        el('td', {
          text: row.appraisalVarianceCents === null ? '—' : dollars(row.appraisalVarianceCents),
          title: 'Trade allowance priced, less the best outside quotation held',
        }),
        el('td', { text: row.oldestSourceAt === null ? '—' : salesAgo(row.oldestSourceAt) }),
        el('td', null, [
          row.exceptions.length === 0
            ? el('span', { class: 'muted', text: '—' })
            : el(
                'span',
                null,
                row.exceptions.map(function (e) {
                  return badge(e, 'warn');
                }),
              ),
        ]),
      ],
    );
  });

  view.appendChild(
    el('table', { class: 'table' }, [
      el('thead', null, [
        el('tr', null, [
          el('th', { text: 'Customer' }),
          el('th', { text: 'File' }),
          el('th', { text: 'Versions' }),
          el('th', { text: 'Latest' }),
          el('th', { text: 'Financed' }),
          el('th', { text: 'Monthly' }),
          el('th', { text: 'Appraisal variance' }),
          el('th', { text: 'Oldest source' }),
          el('th', { text: 'Needs doing' }),
        ]),
      ]),
      el('tbody', null, rows),
    ]),
  );
}

/** Open a file from the list of customers the floor has finished with. */
function openDeskFileDialog() {
  modal('Open a desk file', function (box, close) {
    box.appendChild(
      el('p', { class: 'muted' }, [
        'These are the customers the showroom has handed on. Choose one — there is ' +
          'nothing to type.',
      ]),
    );
    picker(box, {
      label: 'Ready for appraisal and desking',
      path: '/api/desking/find/handoffs',
      collection: 'handoffs',
      empty: 'Nobody is waiting for the desk at the rooftops you work.',
      render: function (h) {
        return 'Handed ' + salesAgo(h.occurredAt);
      },
      onPick: async function (h) {
        try {
          const created = await api(
            'POST',
            '/api/desking/cases',
            { desking_handoff_id: h.deskingHandoffId, location_id: h.rooftopId },
            { idempotent: true },
          );
          close();
          toast(
            created.outcome === 'already_open' ? 'That file was already open' : 'Desk file opened',
          );
          location.hash = '#/deskfile/' + created.case.deskingCaseId;
          renderApp();
        } catch (err) {
          reportError(err);
        }
      },
    });
    box.appendChild(el('button', { class: 'ghost', text: 'Cancel', onclick: close }));
  });
}

// ── one desk file ───────────────────────────────────────────────────────────

async function renderDeskFile(view) {
  const caseId = (location.hash.split('/')[2] || '').trim();
  if (!caseId) {
    view.appendChild(el('p', { class: 'muted', text: 'Choose a file from the desk.' }));
    return;
  }
  const data = await api('GET', '/api/desking/cases/' + caseId);
  const file = data.case;

  view.appendChild(
    el('div', { class: 'card' }, [
      el('h2', { text: file.customerName }),
      el('p', { class: 'muted' }, [
        file.vehicleDescription === null ? 'No vehicle settled on yet' : file.vehicleDescription,
        ' · ',
        badge(file.deskingCase.state, file.deskingCase.state === 'approved' ? 'ok' : 'muted'),
        ' · opened ',
        salesAgo(file.deskingCase.createdAt),
      ]),
    ]),
  );

  renderTradeSection(view, file, caseId);
  renderVersionsSection(view, file, caseId);
}

function renderTradeSection(view, file, caseId) {
  const section = el('section', { class: 'card' }, [el('h3', { text: 'The trade' })]);
  if (file.appraisal === null) {
    section.appendChild(
      el('p', { class: 'muted', text: 'No trade has been appraised on this file.' }),
    );
    section.appendChild(
      el('button', {
        class: 'primary',
        text: 'Appraise a trade',
        onclick: function () {
          appraisalDialog(caseId, null);
        },
      }),
    );
    view.appendChild(section);
    return;
  }

  const a = file.appraisal;
  section.appendChild(
    el('p', null, [
      a.description,
      ' · VIN ',
      a.vin,
      ' · ',
      String(a.odometerMiles.toLocaleString()),
      ' miles · ',
      badge(a.conditionGrade, 'muted'),
      ' · version ',
      String(a.currentVersionNo),
    ]),
  );

  if (a.quotations.length === 0) {
    section.appendChild(
      el('p', { class: 'muted', text: 'No outside valuation has been recorded for this trade.' }),
    );
  } else {
    section.appendChild(
      el('table', { class: 'table' }, [
        el('thead', null, [
          el('tr', null, [
            el('th', { text: 'Source' }),
            el('th', { text: 'Kind' }),
            el('th', { text: 'Value' }),
            el('th', { text: 'Recorded' }),
          ]),
        ]),
        el(
          'tbody',
          null,
          a.quotations.map(function (q) {
            return el('tr', null, [
              el('td', { text: q.providerCode }),
              el('td', { text: q.providerKind.replace(/_/g, ' ') }),
              el('td', null, [
                q.availability === 'quoted'
                  ? el('span', { text: dollars(q.quotedValueCents) })
                  : badge('NOT_YET_AVAILABLE', 'warn'),
              ]),
              el('td', { text: salesAgo(q.recordedAt) }),
            ]);
          }),
        ),
      ]),
    );
  }

  section.appendChild(
    el('button', {
      class: 'ghost',
      text: 'Record what changed',
      onclick: function () {
        appraisalDialog(caseId, a);
      },
    }),
  );
  section.appendChild(
    el('button', {
      class: 'ghost',
      text: 'Record an outside valuation',
      onclick: function () {
        quotationDialog(a.appraisalId);
      },
    }),
  );
  view.appendChild(section);
}

function appraisalDialog(caseId, existing) {
  modal(existing === null ? 'Appraise the trade' : 'Record what changed', function (box, close) {
    const form = {};
    const field = function (label, key, placeholder) {
      box.appendChild(el('label', null, [label]));
      box.appendChild(
        el('input', {
          placeholder: placeholder || '',
          oninput: function (e) {
            form[key] = e.target.value;
          },
        }),
      );
    };
    const choice = function (label, key, options) {
      box.appendChild(el('label', null, [label]));
      const select = el(
        'select',
        {
          onchange: function (e) {
            form[key] = e.target.value;
          },
        },
        options.map(function (o) {
          return el('option', { value: o, text: o.replace(/_/g, ' ') });
        }),
      );
      form[key] = options[0];
      box.appendChild(select);
    };

    if (existing === null) {
      field('VIN', 'vin', '17 characters');
      field('Year', 'model_year', '2018');
      field('Make', 'make', 'Toyota');
      field('Model', 'model', 'Corolla');
      field('Trim', 'trim_level', 'LE');
    }
    choice('Ownership', 'ownership', ['owned_outright', 'financed', 'leased']);
    choice('Relationship', 'relationship', ['customer_owned', 'co_owned', 'third_party']);
    field('Odometer', 'odometer_miles', '68420');
    choice('Odometer status', 'odometer_status', ['actual', 'not_actual', 'exceeds_limits']);
    choice('Condition', 'condition_grade', ['rough', 'average', 'clean', 'extra_clean']);
    choice('Where this came from', 'provenance', [
      'walk_around',
      'third_party_inspection',
      'customer_declared',
    ]);
    field('Notes', 'inspection_notes', 'Tyres, service history, keys');
    if (existing !== null) field('What changed, and why', 'change_reason', '');

    box.appendChild(
      el('button', {
        class: 'primary',
        text: 'Record',
        onclick: async function () {
          const payload = {
            ownership: form.ownership,
            relationship: form.relationship,
            odometer_miles: Number(form.odometer_miles || 0),
            odometer_status: form.odometer_status,
            condition_grade: form.condition_grade,
            provenance: form.provenance,
            inspection_notes: form.inspection_notes || null,
          };
          try {
            if (existing === null) {
              await api(
                'POST',
                '/api/desking/cases/' + caseId + '/appraisal',
                Object.assign(payload, {
                  vin: (form.vin || '').toUpperCase(),
                  model_year: Number(form.model_year || 0),
                  make: form.make,
                  model: form.model,
                  trim_level: form.trim_level || null,
                }),
                { idempotent: true },
              );
            } else {
              await api(
                'POST',
                '/api/desking/appraisals/' + existing.appraisalId + '/versions',
                Object.assign(payload, {
                  expected_version: existing.authorizationVersion,
                  change_reason: form.change_reason || null,
                }),
              );
            }
            close();
            toast('Appraisal recorded');
            renderApp();
          } catch (err) {
            reportError(err);
          }
        },
      }),
    );
    box.appendChild(el('button', { class: 'ghost', text: 'Cancel', onclick: close }));
  });
}

function quotationDialog(appraisalId) {
  modal('Record an outside valuation', function (box, close) {
    const form = { availability: 'quoted', provider_kind: 'deterministic_simulator' };
    box.appendChild(
      el('p', { class: 'muted' }, [
        'No certified valuation provider is integrated in this phase. Record the simulator ' +
          'as what it is, or record the absence — a value nobody quoted is not a value.',
      ]),
    );
    box.appendChild(el('label', null, ['Source']));
    box.appendChild(
      el('input', {
        placeholder: 'book_sim',
        oninput: function (e) {
          form.provider_code = e.target.value;
        },
      }),
    );
    box.appendChild(el('label', null, ['Did they give a number?']));
    box.appendChild(
      el(
        'select',
        {
          onchange: function (e) {
            form.availability = e.target.value;
          },
        },
        [
          el('option', { value: 'quoted', text: 'Yes — record the value' }),
          el('option', { value: 'NOT_YET_AVAILABLE', text: 'No — record the absence' }),
        ],
      ),
    );
    box.appendChild(el('label', null, ['Value']));
    box.appendChild(
      el('input', {
        placeholder: '11,850.00',
        oninput: function (e) {
          form.value = e.target.value;
        },
      }),
    );
    box.appendChild(el('label', null, ['If they had nothing, why not']));
    box.appendChild(
      el('input', {
        placeholder: 'No comparables in the last 90 days',
        oninput: function (e) {
          form.reason = e.target.value;
        },
      }),
    );
    box.appendChild(
      el('button', {
        class: 'primary',
        text: 'Record',
        onclick: async function () {
          const value = cents(form.value);
          if (form.availability === 'quoted' && (value === undefined || value === null)) {
            toast('A quotation carries the value that was quoted');
            return;
          }
          try {
            await api('POST', '/api/desking/appraisals/' + appraisalId + '/quotations', {
              provider_code: form.provider_code,
              provider_kind: 'deterministic_simulator',
              availability: form.availability,
              quoted_value_cents: form.availability === 'quoted' ? value : null,
              currency: form.availability === 'quoted' ? 'USD' : null,
              unavailable_reason: form.availability === 'quoted' ? null : form.reason || null,
            });
            close();
            toast('Valuation recorded');
            renderApp();
          } catch (err) {
            reportError(err);
          }
        },
      }),
    );
    box.appendChild(el('button', { class: 'ghost', text: 'Cancel', onclick: close }));
  });
}

function renderVersionsSection(view, file, caseId) {
  const section = el('section', { class: 'card' }, [el('h3', { text: 'Priced versions' })]);
  section.appendChild(
    el('button', {
      class: 'primary',
      text: 'Build a version',
      onclick: function () {
        buildDialog(caseId, file.scenarios[0] || null);
      },
    }),
  );

  if (file.scenarios.length === 0) {
    section.appendChild(el('p', { class: 'muted', text: 'Nothing has been priced yet.' }));
    view.appendChild(section);
    return;
  }

  // SIDE BY SIDE, because comparing is the whole job. Newest first, and the
  // approved one is marked wherever it sits.
  section.appendChild(
    el('table', { class: 'table' }, [
      el('thead', null, [
        el('tr', null, [
          el('th', { text: 'Version' }),
          el('th', { text: 'State' }),
          el('th', { text: 'Price' }),
          el('th', { text: 'Trade equity' }),
          el('th', { text: 'Taxable' }),
          el('th', { text: 'Tax' }),
          el('th', { text: 'Fees' }),
          el('th', { text: 'Financed' }),
          el('th', { text: 'Monthly' }),
          el('th', { text: 'Terms' }),
          el('th', { text: '' }),
        ]),
      ]),
      el(
        'tbody',
        null,
        file.scenarios.map(function (s) {
          return el('tr', null, [
            el('td', { text: 'v' + s.versionNo + ' — ' + s.label }),
            el('td', null, [badge(s.state, SCENARIO_TONE[s.state] || 'muted')]),
            el('td', { text: dollars(s.vehiclePriceCents) }),
            el('td', { text: dollars(s.tradeEquityCents) }),
            el('td', { text: dollars(s.taxableAmountCents) }),
            el('td', { text: dollars(s.taxTotalCents) }),
            el('td', { text: dollars(s.feeTotalCents) }),
            el('td', { text: dollars(s.amountFinancedCents) }),
            el('td', { text: dollars(s.monthlyPaymentCents) }),
            el('td', {
              text:
                s.termMonths === null ? 'cash' : s.termMonths + ' months at ' + percent(s.aprPpm),
            }),
            el('td', null, versionActions(s)),
          ]);
        }),
      ),
    ]),
  );
  view.appendChild(section);
}

function versionActions(s) {
  const actions = [];
  if (s.state === 'draft') {
    actions.push(
      el('button', {
        class: 'ghost small',
        text: 'Send to a manager',
        onclick: async function () {
          try {
            await api('POST', '/api/desking/scenarios/' + s.scenarioId + '/submission', {
              expected_version: s.authorizationVersion,
            });
            toast('Sent for a decision');
            renderApp();
          } catch (err) {
            reportError(err);
          }
        },
      }),
    );
  }
  if (s.state === 'draft' || s.state === 'submitted') {
    actions.push(
      el('button', {
        class: 'ghost small',
        text: 'Expire',
        onclick: async function () {
          try {
            await api('POST', '/api/desking/scenarios/' + s.scenarioId + '/expiry', {
              expected_version: s.authorizationVersion,
              reason: 'Retired from the desk',
            });
            toast('Version expired');
            renderApp();
          } catch (err) {
            reportError(err);
          }
        },
      }),
    );
  }
  if (s.state === 'submitted') {
    actions.push(
      el('button', {
        class: 'primary small',
        text: 'Decide',
        onclick: function () {
          decisionDialog(s);
        },
      }),
    );
  }
  actions.push(
    el('button', {
      class: 'ghost small',
      text: 'Detail',
      onclick: function () {
        scenarioDetailDialog(s.scenarioId);
      },
    }),
  );
  return actions;
}

function buildDialog(caseId, previous) {
  modal('Build a version', function (box, close) {
    const form = {
      label: previous === null ? 'First pencil' : 'Revision',
      jurisdiction: previous === null ? '' : previous.jurisdiction,
      vehicle_price: previous === null ? '' : String(Number(previous.vehiclePriceCents) / 100),
    };
    const field = function (label, key, placeholder, hint) {
      box.appendChild(el('label', null, [label]));
      box.appendChild(
        el('input', {
          value: form[key] || '',
          placeholder: placeholder || '',
          oninput: function (e) {
            form[key] = e.target.value;
          },
        }),
      );
      if (hint) box.appendChild(el('p', { class: 'muted', text: hint }));
    };
    field('What to call it', 'label', 'First pencil');
    field('Jurisdiction', 'jurisdiction', 'US-CO', 'The rule book this is priced under.');
    field('Vehicle price', 'vehicle_price', '45,500.00');
    field('Trade allowance', 'trade_allowance', '12,000.00');
    field('Trade payoff', 'trade_payoff', '14,500.00');
    field('Cash down', 'cash_down', '3,000.00');
    field('Term, in months', 'term_months', '72');
    field('Rate', 'apr', '7.49%');

    box.appendChild(
      el('button', {
        class: 'primary',
        text: 'Price it',
        onclick: async function () {
          const price = cents(form.vehicle_price);
          if (price === undefined || price === null) {
            toast('A price is an amount, like 45,500.00');
            return;
          }
          const rate = ppm(form.apr);
          if (rate === undefined) {
            toast('A rate is a percentage, like 7.49');
            return;
          }
          const term = form.term_months ? Number(form.term_months) : null;
          if (term !== null && !Number.isInteger(term)) {
            toast('A term is a whole number of months');
            return;
          }
          try {
            const built = await api(
              'POST',
              '/api/desking/cases/' + caseId + '/scenarios',
              {
                label: form.label,
                jurisdiction: form.jurisdiction,
                vehicle_price_cents: price,
                trade_allowance_cents: cents(form.trade_allowance) || '0',
                trade_payoff_cents: cents(form.trade_payoff) || '0',
                cash_down_cents: cents(form.cash_down) || '0',
                term_months: rate === null ? null : term,
                apr_ppm: term === null ? null : rate,
                supersedes_scenario_id: previous === null ? null : previous.scenarioId,
              },
              { idempotent: true },
            );
            close();
            toast('Version ' + built.scenario.versionNo + ' priced');
            renderApp();
          } catch (err) {
            reportError(err);
          }
        },
      }),
    );
    box.appendChild(el('button', { class: 'ghost', text: 'Cancel', onclick: close }));
  });
}

/**
 * THE DECISION, and what it binds.
 *
 * The figures the manager is looking at are sent back with the decision as
 * `reviewed_output_fingerprint`. If the version has been rebuilt since this
 * screen was drawn the server refuses and says so — an approval of figures
 * nobody read is the one outcome this dialog exists to prevent.
 */
function decisionDialog(s) {
  modal('Decide version ' + s.versionNo, function (box, close) {
    const form = {};
    box.appendChild(
      el('p', null, [
        'Financed ',
        el('strong', { text: dollars(s.amountFinancedCents) }),
        s.monthlyPaymentCents === null
          ? ''
          : ', ' +
            dollars(s.monthlyPaymentCents) +
            ' a month over ' +
            s.termMonths +
            ' months at ' +
            percent(s.aprPpm),
        '.',
      ]),
    );
    box.appendChild(
      el('p', { class: 'muted' }, [
        'Approving freezes these exact figures. A later revision creates the next version ' +
          'and leaves this one as it is.',
      ]),
    );
    box.appendChild(el('label', null, ['If this is outside the desk limit, say why']));
    box.appendChild(
      el('input', {
        oninput: function (e) {
          form.override = e.target.value;
        },
      }),
    );
    box.appendChild(el('label', null, ['If you are turning it down, what against']));
    box.appendChild(
      el('input', {
        oninput: function (e) {
          form.limit = e.target.value;
        },
      }),
    );

    const decide = function (decision) {
      return async function () {
        if (decision === 'rejected' && !form.limit) {
          toast('A rejection says what it was measured against');
          return;
        }
        try {
          await api('POST', '/api/desking/scenarios/' + s.scenarioId + '/decision', {
            decision: decision,
            reviewed_output_fingerprint: s.outputFingerprint,
            expected_version: s.authorizationVersion,
            override_reason: form.override || null,
            limit_reason: form.limit || null,
          });
          close();
          toast(decision === 'approved' ? 'Approved and frozen' : 'Turned down');
          renderApp();
        } catch (err) {
          reportError(err);
        }
      };
    };
    box.appendChild(
      el('button', { class: 'primary', text: 'Approve', onclick: decide('approved') }),
    );
    box.appendChild(
      el('button', { class: 'ghost', text: 'Turn down', onclick: decide('rejected') }),
    );
    box.appendChild(el('button', { class: 'ghost', text: 'Cancel', onclick: close }));
  });
}

/** Every line, every rule behind it, and everything that happened to it. */
function scenarioDetailDialog(scenarioId) {
  modal('Version detail', async function (box, close) {
    box.appendChild(el('div', { class: 'muted', text: 'Loading…' }));
    try {
      const data = await api('GET', '/api/desking/scenarios/' + scenarioId);
      const d = data.scenario;
      box.textContent = '';
      box.appendChild(
        el('table', { class: 'table' }, [
          el('thead', null, [
            el('tr', null, [
              el('th', { text: '#' }),
              el('th', { text: 'What' }),
              el('th', { text: 'Amount' }),
              el('th', { text: 'Rule' }),
            ]),
          ]),
          el(
            'tbody',
            null,
            d.lines.map(function (l) {
              return el('tr', null, [
                el('td', { text: String(l.sequenceNo) }),
                el('td', { text: l.label }),
                el('td', { text: dollars(l.amountCents) }),
                el('td', { text: l.ruleId === null ? '—' : l.lineCode + ' v' + l.ruleVersion }),
              ]);
            }),
          ),
        ]),
      );
      box.appendChild(el('h4', { text: 'Priced under' }));
      box.appendChild(
        el(
          'ul',
          null,
          d.rules.map(function (r) {
            return el('li', {
              text:
                r.ruleKind +
                ' ' +
                r.ruleCode +
                ' v' +
                r.ruleVersion +
                ' — ' +
                r.source +
                ' (' +
                r.jurisdiction +
                (r.rooftopScoped ? ', this rooftop' : '') +
                ', from ' +
                salesWhen(r.effectiveFrom) +
                ')',
            });
          }),
        ),
      );
      box.appendChild(el('h4', { text: 'What happened to it' }));
      box.appendChild(
        el(
          'ul',
          null,
          d.history.map(function (h) {
            return el('li', {
              text:
                h.fromState +
                ' → ' +
                h.toState +
                ' ' +
                salesAgo(h.occurredAt) +
                (h.reason ? ' — ' + h.reason : ''),
            });
          }),
        ),
      );
      if (d.decision !== null) {
        box.appendChild(
          el('p', null, [
            'Decided ',
            badge(d.decision.decision, d.decision.decision === 'approved' ? 'ok' : 'bad'),
            ' ' + salesWhen(d.decision.decidedAt),
            d.decision.overrideReason ? ' — ' + d.decision.overrideReason : '',
            d.decision.limitReason ? ' — ' + d.decision.limitReason : '',
          ]),
        );
      }
    } catch (err) {
      box.textContent = '';
      box.appendChild(el('div', { class: 'error-banner', text: err.message }));
    }
    box.appendChild(el('button', { class: 'ghost', text: 'Close', onclick: close }));
  });
}

// ── registration ────────────────────────────────────────────────────────────

ROUTES.desk = { title: 'Desk', render: renderDeskBoard };

// Reached from a row on the desk, so it routes without taking a tab of its own.
ROUTES.deskfile = { title: 'Desk file', render: renderDeskFile, hidden: true };
