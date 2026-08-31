/**
 * RT4 — the sales pipeline and showroom screens of the staff console.
 *
 * Loaded after app.js, which owns the shell, the router and the fetch wrapper.
 * A classic script's top-level `const` is visible to the scripts that follow
 * it, so this file registers its screens by extending the same ROUTES map the
 * shell renders from — no bundler, no module system, no framework.
 *
 * WHAT THE SCREENS ARE FOR, in the order a showroom actually works:
 *
 *   * SHOWROOM — the up-list and who is on the floor, beside the customers
 *     standing in the building right now. This is the screen a manager keeps
 *     open all Saturday, so the only red on it is somebody waiting to be
 *     greeted.
 *   * PIPELINE — every live opportunity, its stage, its owner and its age.
 *   * OPPORTUNITY — one customer's whole visit on one timeline: the cars they
 *     looked at, what they drove, what was said, and who else got involved.
 *
 * WHAT IS DELIBERATELY NOT HERE: a price, a payment, a gross, a commission.
 * The desking screen is FBL-120 and the deal does not exist yet — so rather
 * than show a zero somebody would read as "we made nothing", these screens say
 * the number is not available and name the release that will bring it.
 */
'use strict';

/*
 * The shell (app.js) defines these at script scope and this file uses them.
 * Declaring them here is what tells the linter they are provided rather than
 * undefined — there is no module system to import them through.
 */
/* global ROUTES, api, el, modal, toast, reportError, badge, statCard, renderApp */

// ── helpers ─────────────────────────────────────────────────────────────────

function salesWhen(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

/** How long somebody has been standing there, in the units a person would say. */
function salesSince(iso) {
  if (!iso) return '—';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + 'm';
  if (minutes < 48 * 60) return Math.round(minutes / 60) + 'h';
  return Math.round(minutes / 1440) + 'd';
}

/**
 * A member of staff, as the platform can currently name one.
 *
 * `user_links` carries a provider identity rather than a display name, so there
 * is no real name to print yet. A full UUID in a table column is unreadable, so
 * this prints the short form somebody can match against the audit trail and
 * says plainly when there is nobody — rather than an empty cell, which reads as
 * a rendering fault.
 */
function salesStaff(userLinkId) {
  if (!userLinkId) return 'unassigned';
  return 'staff ' + String(userLinkId).slice(0, 8);
}

/** "3m ago", but "just now" rather than the nonsense "just now ago". */
function salesAgo(iso) {
  const since = salesSince(iso);
  return since === 'just now' || since === '—' ? since : since + ' ago';
}

/** An age in hours, in the units somebody would actually say out loud. */
function salesAge(hours) {
  if (hours === null || hours === undefined) return '—';
  if (hours < 1) return Math.round(hours * 60) + 'm';
  if (hours < 48) return Math.round(hours) + 'h';
  return Math.round(hours / 24) + 'd';
}

const STAGE_LABELS = {
  received: 'Received',
  in_showroom: 'In showroom',
  demonstrated: 'Demonstrated',
  negotiating: 'Negotiating',
  won: 'Sold',
  lost: 'Lost',
};

/** Where an opportunity may go from where it is. Mirrors the service exactly. */
const STAGE_NEXT = {
  received: ['in_showroom', 'demonstrated', 'negotiating', 'won', 'lost'],
  in_showroom: ['demonstrated', 'negotiating', 'won', 'lost'],
  demonstrated: ['negotiating', 'in_showroom', 'won', 'lost'],
  negotiating: ['demonstrated', 'won', 'lost'],
  won: [],
  lost: [],
};

const DISPOSITIONS = [
  { value: 'sold', label: 'Sold' },
  { value: 'lost_to_competitor', label: 'Bought elsewhere' },
  { value: 'lost_no_decision', label: 'Did not decide' },
  { value: 'lost_credit', label: 'Could not finance' },
  { value: 'lost_no_vehicle', label: 'We had nothing for them' },
  { value: 'customer_unreachable', label: 'Went quiet' },
];

const VISIT_STATE_LABELS = {
  arrived: 'Waiting',
  greeted: 'Greeted',
  with_salesperson: 'With salesperson',
  departed: 'Left',
};

/**
 * A visit's state in the words a showroom uses, keeping the badge's colour.
 *
 * `badge()` prints the state verbatim, and "arrived" on a screen about people
 * standing in a building reads as a past event rather than as somebody still
 * waiting to be spoken to — which is the one thing this screen exists to make
 * impossible to miss.
 */
function visitBadge(state) {
  const node = badge(state);
  node.textContent = VISIT_STATE_LABELS[state] || state;
  return node;
}

/**
 * The one place this train says what it does not know.
 *
 * A dash in a money column reads as zero to somebody skimming; a sentence that
 * names the release reads as "not built yet", which is the truth.
 */
function notYetAvailable(what, release) {
  return el('div', { class: 'panel muted' }, [
    el('strong', { text: what + ': not available yet. ' }),
    'These screens carry no figure because the deal is not desked until ' +
      release +
      '. Nothing here is zero — it does not exist.',
  ]);
}

/** The rooftop picker every showroom screen needs, remembered across renders. */
const salesState = { rooftopId: null, rooftops: [] };

function rooftopPicker(onChange) {
  if (salesState.rooftops.length < 2) return null;
  const select = el(
    'select',
    {
      onchange: function (e) {
        salesState.rooftopId = e.target.value;
        onChange();
      },
    },
    salesState.rooftops.map(function (r) {
      return el('option', {
        value: r.rooftopId,
        text: r.name,
        selected: r.rooftopId === salesState.rooftopId ? 'selected' : null,
      });
    }),
  );
  return el('label', { class: 'inline' }, ['Showroom ', select]);
}

// ── showroom ────────────────────────────────────────────────────────────────

async function renderShowroom(view) {
  const board = await api('GET', '/api/sales/board');
  salesState.rooftops = board.rooftops || [];
  if (!salesState.rooftopId && salesState.rooftops.length > 0) {
    salesState.rooftopId = salesState.rooftops[0].rooftopId;
  }
  if (!salesState.rooftopId) {
    view.appendChild(
      el('div', { class: 'panel muted', text: 'No showroom is assigned to your account.' }),
    );
    return;
  }

  const floor = await api('GET', '/api/sales/floor?location_id=' + salesState.rooftopId);
  const visits = await api('GET', '/api/sales/visits?location_id=' + salesState.rooftopId);

  const picker = rooftopPicker(renderApp);
  if (picker) view.appendChild(el('div', { class: 'toolbar' }, [picker]));

  view.appendChild(
    el('div', { class: 'cards' }, [
      statCard(board.showroom.waiting, 'Waiting to be greeted'),
      statCard(board.showroom.withSalesperson, 'With a salesperson'),
      statCard(board.floor.available, 'On the floor, free'),
      statCard(board.activity.demonstrationsInProgress, 'Cars out on drives'),
    ]),
  );

  // ── who is in the building ────────────────────────────────────────────────
  const waiting = (visits.visits || []).filter(function (v) {
    return v.state === 'arrived';
  });
  const withUs = (visits.visits || []).filter(function (v) {
    return v.state !== 'arrived' && v.state !== 'departed';
  });

  view.appendChild(
    el('div', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        el('h2', { text: 'In the showroom' }),
        el('button', {
          text: 'Record an arrival',
          onclick: function () {
            openArrival();
          },
        }),
      ]),
      waiting.length + withUs.length === 0
        ? el('p', { class: 'muted', text: 'Nobody is in the building right now.' })
        : el('table', { class: 'grid' }, [
            el('thead', null, [
              el('tr', null, [
                el('th', { text: 'Customer' }),
                el('th', { text: 'Waiting' }),
                el('th', { text: 'State' }),
                el('th', { text: 'With' }),
                el('th', { text: '' }),
              ]),
            ]),
            el(
              'tbody',
              null,
              waiting.concat(withUs).map(function (v) {
                return el('tr', { class: v.state === 'arrived' ? 'urgent' : '' }, [
                  el('td', { text: v.customerName }),
                  el('td', { text: salesSince(v.arrivedAt) }),
                  el('td', null, [visitBadge(v.state)]),
                  el('td', { text: salesStaff(v.greetedByUserLinkId) }),
                  el('td', null, [
                    v.state === 'arrived'
                      ? el('button', {
                          class: 'small',
                          text: 'Greet',
                          onclick: function () {
                            openGreet(v);
                          },
                        })
                      : el('button', {
                          class: 'ghost small',
                          text: 'They have left',
                          onclick: function () {
                            openDepart(v);
                          },
                        }),
                    v.opportunityId
                      ? el('a', {
                          class: 'link small',
                          href: '#/opportunity/' + v.opportunityId,
                          text: 'Open deal',
                        })
                      : null,
                  ]),
                ]);
              }),
            ),
          ]),
    ]),
  );

  // ── the up-list ───────────────────────────────────────────────────────────
  view.appendChild(
    el('div', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        el('h2', { text: 'The floor' }),
        el('button', {
          class: 'ghost',
          text: 'Put somebody on the floor',
          onclick: function () {
            openJoinFloor();
          },
        }),
      ]),
      el('p', {
        class: 'muted',
        text:
          'Turns are taken from the top. Greeting a customer moves that ' +
          'salesperson to the back automatically — nobody has to keep the list by hand.',
      }),
      (floor.floor || []).length === 0
        ? el('p', { class: 'muted', text: 'Nobody is on the floor.' })
        : el('table', { class: 'grid' }, [
            el('thead', null, [
              el('tr', null, [
                el('th', { text: '#' }),
                el('th', { text: 'Salesperson' }),
                el('th', { text: 'State' }),
                el('th', { text: 'Last up' }),
                el('th', { text: '' }),
              ]),
            ]),
            el(
              'tbody',
              null,
              (floor.floor || []).map(function (entry, index) {
                return el('tr', null, [
                  el('td', { text: String(index + 1) }),
                  el('td', { text: salesStaff(entry.userLinkId) }),
                  el('td', null, [badge(entry.status)]),
                  el('td', { text: salesWhen(entry.lastTakenAt) }),
                  el('td', null, [
                    entry.status === 'with_customer'
                      ? el('button', {
                          class: 'ghost small',
                          text: 'Back on the floor',
                          onclick: function () {
                            releaseSalesperson(entry.userLinkId);
                          },
                        })
                      : null,
                  ]),
                ]);
              }),
            ),
          ]),
    ]),
  );
}

function openArrival() {
  modal('Record an arrival', function (box, close) {
    const form = { party_id: '', opportunity_id: '' };
    box.appendChild(
      el('p', {
        class: 'muted',
        text:
          'The customer must already exist — sales does not invent a second ' +
          'record for somebody the dealership already knows.',
      }),
    );
    box.appendChild(
      el('label', null, [
        'Customer ID',
        el('input', {
          oninput: function (e) {
            form.party_id = e.target.value.trim();
          },
        }),
      ]),
    );
    box.appendChild(
      el('label', null, [
        'Opportunity ID (optional)',
        el('input', {
          oninput: function (e) {
            form.opportunity_id = e.target.value.trim();
          },
        }),
      ]),
    );
    box.appendChild(
      el('div', { class: 'row' }, [
        el('button', {
          text: 'Record',
          onclick: async function () {
            try {
              await api(
                'POST',
                '/api/sales/visits',
                {
                  location_id: salesState.rooftopId,
                  party_id: form.party_id,
                  opportunity_id: form.opportunity_id || null,
                },
                { idempotent: true },
              );
              close();
              toast('Arrival recorded');
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
      ]),
    );
  });
}

function openGreet(visit) {
  modal('Greet ' + (visit.customerName || 'this customer'), function (box, close) {
    const form = { greeted_by_user_link_id: '' };
    box.appendChild(
      el('p', {
        class: 'muted',
        text:
          'Leave the box empty to take the next turn off the floor. Name ' +
          'somebody only when the customer asked for them — it still costs ' +
          'that person their turn.',
      }),
    );
    box.appendChild(
      el('label', null, [
        'Salesperson (optional)',
        el('input', {
          oninput: function (e) {
            form.greeted_by_user_link_id = e.target.value.trim();
          },
        }),
      ]),
    );
    box.appendChild(
      el('div', { class: 'row' }, [
        el('button', {
          text: 'Greet',
          onclick: async function () {
            try {
              const res = await api('POST', '/api/sales/visits/' + visit.visitId + '/greet', {
                expected_version: visit.authorizationVersion,
                greeted_by_user_link_id: form.greeted_by_user_link_id || null,
              });
              close();
              toast(res.fromRotation ? 'Next up took the customer' : 'Assigned by name');
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
      ]),
    );
  });
}

function openDepart(visit) {
  modal('Close out this visit', function (box, close) {
    const form = { note: '' };
    box.appendChild(
      el('label', null, [
        'What happened',
        el('textarea', {
          rows: '3',
          oninput: function (e) {
            form.note = e.target.value;
          },
        }),
      ]),
    );
    box.appendChild(
      el('div', { class: 'row' }, [
        el('button', {
          text: 'They have left',
          onclick: async function () {
            try {
              await api('POST', '/api/sales/visits/' + visit.visitId + '/depart', {
                expected_version: visit.authorizationVersion,
                note: form.note || null,
              });
              close();
              toast('Visit closed — the salesperson is back on the floor');
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
      ]),
    );
  });
}

function openJoinFloor() {
  modal('Put somebody on the floor', function (box, close) {
    const form = { user_link_id: '' };
    box.appendChild(
      el('label', null, [
        'Salesperson ID',
        el('input', {
          oninput: function (e) {
            form.user_link_id = e.target.value.trim();
          },
        }),
      ]),
    );
    box.appendChild(
      el('div', { class: 'row' }, [
        el('button', {
          text: 'Add to the up-list',
          onclick: async function () {
            try {
              await api(
                'POST',
                '/api/sales/floor',
                { location_id: salesState.rooftopId, user_link_id: form.user_link_id },
                { idempotent: true },
              );
              close();
              toast('On the floor');
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
      ]),
    );
  });
}

async function releaseSalesperson(userLinkId) {
  try {
    await api('POST', '/api/sales/floor/release', {
      location_id: salesState.rooftopId,
      user_link_id: userLinkId,
    });
    toast('Back on the floor');
    renderApp();
  } catch (err) {
    reportError(err);
  }
}

// ── pipeline ────────────────────────────────────────────────────────────────

async function renderSalesPipeline(view) {
  const board = await api('GET', '/api/sales/board');
  const data = await api('GET', '/api/sales/opportunities');

  view.appendChild(
    el('div', { class: 'cards' }, [
      statCard(board.pipeline.open, 'Open deals'),
      statCard(board.pipeline.negotiating, 'Negotiating'),
      statCard(board.activity.demonstrationsToday, 'Drives today'),
      statCard(board.activity.turnovers, 'Manager turnovers'),
    ]),
  );

  view.appendChild(notYetAvailable('Gross, commission and closing ratio', 'FBL-120 (Desking)'));

  view.appendChild(
    el('div', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        el('h2', { text: 'Live opportunities' }),
        el('button', {
          class: 'ghost',
          text: 'Receive a handoff',
          onclick: function () {
            openReceiveHandoff();
          },
        }),
      ]),
      (data.opportunities || []).length === 0
        ? el('p', {
            class: 'muted',
            text: 'Nothing in the pipeline. Deals arrive when the BDC hands a qualified lead over.',
          })
        : el('table', { class: 'grid' }, [
            el('thead', null, [
              el('tr', null, [
                el('th', { text: 'Customer' }),
                el('th', { text: 'Stage' }),
                el('th', { text: 'Owner' }),
                el('th', { text: 'Showroom' }),
                el('th', { text: 'Age' }),
                el('th', { text: '' }),
              ]),
            ]),
            el(
              'tbody',
              null,
              (data.opportunities || []).map(function (o) {
                return el('tr', null, [
                  el('td', { text: o.customerName }),
                  el('td', null, [badge(o.stage)]),
                  el('td', { text: salesStaff(o.ownerUserLinkId) }),
                  el('td', { text: o.rooftopName || '—' }),
                  el('td', { text: salesAge(o.ageHours) }),
                  el('td', null, [
                    el('a', {
                      class: 'link small',
                      href: '#/opportunity/' + o.opportunityId,
                      text: 'Open',
                    }),
                  ]),
                ]);
              }),
            ),
          ]),
    ]),
  );
}

function openReceiveHandoff() {
  modal('Receive a handoff', function (box, close) {
    const form = { handoff_id: '' };
    box.appendChild(
      el('p', {
        class: 'muted',
        text:
          'The handoff carries the customer and the showroom. Sales does not ' +
          'get to choose either, which is why there is one box here and not four.',
      }),
    );
    box.appendChild(
      el('label', null, [
        'Handoff ID',
        el('input', {
          oninput: function (e) {
            form.handoff_id = e.target.value.trim();
          },
        }),
      ]),
    );
    box.appendChild(
      el('div', { class: 'row' }, [
        el('button', {
          text: 'Receive',
          onclick: async function () {
            try {
              const res = await api(
                'POST',
                '/api/sales/opportunities',
                { handoff_id: form.handoff_id },
                { idempotent: true },
              );
              close();
              location.hash = '#/opportunity/' + res.opportunity.opportunityId;
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
      ]),
    );
  });
}

// ── one opportunity ─────────────────────────────────────────────────────────

async function renderOpportunity(view) {
  const opportunityId = (location.hash || '').split('/')[2];
  if (!opportunityId) {
    view.appendChild(el('div', { class: 'panel muted', text: 'No opportunity selected.' }));
    return;
  }
  const data = await api('GET', '/api/sales/opportunities/' + opportunityId);
  const o = data.opportunity;

  view.appendChild(
    el('div', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        el('h2', { text: o.customerName || 'Customer' }),
        el('span', { class: 'muted', text: o.rooftopName || '' }),
        badge(o.stage),
      ]),
      el('table', { class: 'kv' }, [
        el('tbody', null, [
          el('tr', null, [
            el('th', { text: 'Stage' }),
            el('td', { text: STAGE_LABELS[o.stage] || o.stage }),
          ]),
          el('tr', null, [
            el('th', { text: 'Owner' }),
            el('td', { text: salesStaff(o.ownerUserLinkId) }),
          ]),
          el('tr', null, [
            el('th', { text: 'Came from' }),
            el('td', { text: 'BDC handoff ' + (o.handoffId || '').slice(0, 8) }),
          ]),
          el('tr', null, [
            el('th', { text: 'Opened' }),
            el('td', { text: salesWhen(o.createdAt) }),
          ]),
          o.disposition
            ? el('tr', null, [
                el('th', { text: 'Outcome' }),
                el('td', { text: o.disposition.replace(/_/g, ' ') }),
              ])
            : null,
        ]),
      ]),
      o.stage === 'won' || o.stage === 'lost'
        ? null
        : el('div', { class: 'row' }, [
            el('button', {
              class: 'ghost small',
              text: 'Give this deal to somebody',
              onclick: function () {
                openAssign(o);
              },
            }),
          ]),
      el(
        'div',
        { class: 'row' },
        (STAGE_NEXT[o.stage] || []).map(function (stage) {
          return el('button', {
            class: stage === 'won' || stage === 'lost' ? '' : 'ghost',
            text: STAGE_LABELS[stage] || stage,
            onclick: function () {
              openStageMove(o, stage);
            },
          });
        }),
      ),
    ]),
  );

  if (o.stage === 'won' || o.stage === 'lost') {
    view.appendChild(
      el('div', { class: 'panel muted' }, [
        'This deal is finished. It stays readable, and nothing further can be ' +
          'written against it.',
      ]),
    );
  }

  // ── the cars ──────────────────────────────────────────────────────────────
  view.appendChild(
    el('div', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        el('h2', { text: 'Cars they are looking at' }),
        o.stage === 'won' || o.stage === 'lost'
          ? null
          : el('button', {
              class: 'ghost',
              text: 'Add a car',
              onclick: function () {
                openShortlist(o);
              },
            }),
      ]),
      (data.shortlist || []).length === 0
        ? el('p', { class: 'muted', text: 'Nothing shortlisted yet.' })
        : el('table', { class: 'grid' }, [
            el('thead', null, [
              el('tr', null, [
                el('th', { text: 'Stock' }),
                el('th', { text: 'Vehicle' }),
                el('th', { text: 'Where it stands' }),
                el('th', { text: '' }),
              ]),
            ]),
            el(
              'tbody',
              null,
              (data.shortlist || []).map(function (v) {
                return el('tr', null, [
                  el('td', { text: v.stockNumber || '—' }),
                  el('td', { text: v.description || '—' }),
                  el('td', null, [badge(v.status)]),
                  el('td', null, [
                    o.stage === 'won' || o.stage === 'lost'
                      ? null
                      : el('button', {
                          class: 'ghost small',
                          text: 'Test drive',
                          onclick: function () {
                            openDemonstration(o, v);
                          },
                        }),
                    o.stage === 'won' || o.stage === 'lost'
                      ? null
                      : el('button', {
                          class: 'ghost small',
                          text: 'This is the one',
                          onclick: function () {
                            setShortlistStatus(o, v, 'selected');
                          },
                        }),
                  ]),
                ]);
              }),
            ),
          ]),
    ]),
  );

  // ── the car that is out ───────────────────────────────────────────────────
  if ((data.outOnDrive || []).length > 0) {
    view.appendChild(
      el('div', { class: 'panel' }, [
        el('h2', { text: 'Out on a test drive' }),
        el('table', { class: 'grid' }, [
          el('thead', null, [
            el('tr', null, [
              el('th', { text: 'Stock' }),
              el('th', { text: 'Left at' }),
              el('th', { text: '' }),
            ]),
          ]),
          el(
            'tbody',
            null,
            (data.outOnDrive || []).map(function (drive) {
              return el('tr', null, [
                el('td', { text: drive.stockNumber }),
                el('td', { text: salesAgo(drive.startedAt) }),
                el('td', null, [
                  el('button', {
                    class: 'small',
                    text: 'They are back',
                    onclick: function () {
                      openEndDemonstration(o, drive);
                    },
                  }),
                ]),
              ]);
            }),
          ),
        ]),
      ]),
    );
  }

  // ── the timeline ──────────────────────────────────────────────────────────
  view.appendChild(
    el('div', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        el('h2', { text: 'What has happened' }),
        o.stage === 'won' || o.stage === 'lost'
          ? null
          : el('div', { class: 'row' }, [
              el('button', {
                class: 'ghost small',
                text: 'Log something',
                onclick: function () {
                  openActivity(o);
                },
              }),
              el('button', {
                class: 'ghost small',
                text: 'Negotiation round',
                onclick: function () {
                  openNegotiation(o);
                },
              }),
              el('button', {
                class: 'ghost small',
                text: 'Get a manager',
                onclick: function () {
                  openTurnover(o);
                },
              }),
            ]),
      ]),
      (data.timeline || []).length === 0
        ? el('p', { class: 'muted', text: 'Nothing logged yet.' })
        : el(
            'ol',
            { class: 'timeline' },
            (data.timeline || []).map(function (entry) {
              return el('li', null, [
                el('div', { class: 'when', text: salesWhen(entry.at) }),
                el('div', { class: 'what' }, [
                  el('strong', { text: entry.kind.replace(/_/g, ' ') + ': ' }),
                  entry.summary || '',
                ]),
                el('div', { class: 'who muted', text: entry.detail || '' }),
              ]);
            }),
          ),
    ]),
  );
}

function openStageMove(o, stage) {
  const terminal = stage === 'won' || stage === 'lost';
  modal('Move to ' + (STAGE_LABELS[stage] || stage), function (box, close) {
    const form = { disposition: stage === 'won' ? 'sold' : '', note: '' };
    if (terminal) {
      box.appendChild(
        el('label', null, [
          'Why',
          el(
            'select',
            {
              onchange: function (e) {
                form.disposition = e.target.value;
              },
            },
            [el('option', { value: '', text: 'Choose…' })].concat(
              DISPOSITIONS.filter(function (d) {
                return stage === 'won' ? d.value === 'sold' : d.value !== 'sold';
              }).map(function (d) {
                return el('option', {
                  value: d.value,
                  text: d.label,
                  selected: form.disposition === d.value ? 'selected' : null,
                });
              }),
            ),
          ),
        ]),
      );
    }
    box.appendChild(
      el('label', null, [
        'Note',
        el('textarea', {
          rows: '3',
          oninput: function (e) {
            form.note = e.target.value;
          },
        }),
      ]),
    );
    box.appendChild(
      el('div', { class: 'row' }, [
        el('button', {
          text: 'Move',
          onclick: async function () {
            try {
              await api('POST', '/api/sales/opportunities/' + o.opportunityId + '/stage', {
                expected_version: o.authorizationVersion,
                to_stage: stage,
                disposition: form.disposition || null,
                note: form.note || null,
              });
              close();
              toast('Moved to ' + (STAGE_LABELS[stage] || stage));
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
      ]),
    );
  });
}

function openShortlist(o) {
  modal('Add a car to the shortlist', function (box, close) {
    const form = { stock_item_id: '' };
    box.appendChild(
      el('p', {
        class: 'muted',
        text: 'The car has to be on this showroom’s lot and still in stock.',
      }),
    );
    box.appendChild(
      el('label', null, [
        'Stock item ID',
        el('input', {
          oninput: function (e) {
            form.stock_item_id = e.target.value.trim();
          },
        }),
      ]),
    );
    box.appendChild(
      el('div', { class: 'row' }, [
        el('button', {
          text: 'Add',
          onclick: async function () {
            try {
              await api(
                'POST',
                '/api/sales/opportunities/' + o.opportunityId + '/vehicles',
                { stock_item_id: form.stock_item_id },
                { idempotent: true },
              );
              close();
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
      ]),
    );
  });
}

async function setShortlistStatus(o, vehicle, status) {
  try {
    await api(
      'POST',
      '/api/sales/opportunities/' +
        o.opportunityId +
        '/vehicles/' +
        vehicle.opportunityVehicleId +
        '/status',
      { expected_version: vehicle.authorizationVersion, status: status },
    );
    toast('Shortlist updated');
    renderApp();
  } catch (err) {
    reportError(err);
  }
}

function openDemonstration(o, vehicle) {
  modal('Take ' + (vehicle.stockNumber || 'this car') + ' out', function (box, close) {
    const form = { driver_party_id: o.partyId, licence_verified: false };
    box.appendChild(
      el('p', {
        class: 'muted',
        text:
          'A car does not leave the lot until somebody has looked at the ' +
          'driver’s licence. This box is the record that it happened.',
      }),
    );
    box.appendChild(
      el('label', null, [
        'Driver (customer ID)',
        el('input', {
          value: o.partyId,
          oninput: function (e) {
            form.driver_party_id = e.target.value.trim();
          },
        }),
      ]),
    );
    box.appendChild(
      el('label', { class: 'check' }, [
        el('input', {
          type: 'checkbox',
          onchange: function (e) {
            form.licence_verified = e.target.checked;
          },
        }),
        ' I have seen and checked their licence',
      ]),
    );
    box.appendChild(
      el('div', { class: 'row' }, [
        el('button', {
          text: 'Start the drive',
          onclick: async function () {
            try {
              await api(
                'POST',
                '/api/sales/opportunities/' + o.opportunityId + '/demonstrations',
                {
                  stock_item_id: vehicle.stockItemId,
                  driver_party_id: form.driver_party_id,
                  licence_verified: form.licence_verified,
                },
                { idempotent: true },
              );
              close();
              toast('Out on a drive');
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
      ]),
    );
  });
}

function openEndDemonstration(o, drive) {
  modal('Bring ' + drive.stockNumber + ' back', function (box, close) {
    const form = { state: 'completed', outcome: 'interested', notes: '' };
    box.appendChild(
      el('p', {
        class: 'muted',
        text:
          'A finished drive records what the customer thought; an abandoned one ' +
          'records nothing, because nobody found out.',
      }),
    );
    box.appendChild(
      el('label', null, [
        'How it went',
        el(
          'select',
          {
            onchange: function (e) {
              form.state = e.target.value;
              if (form.state === 'abandoned') form.outcome = '';
              else if (!form.outcome) form.outcome = 'interested';
            },
          },
          [
            el('option', { value: 'completed', text: 'They drove it' }),
            el('option', { value: 'abandoned', text: 'Cut short' }),
          ],
        ),
      ]),
    );
    box.appendChild(
      el('label', null, [
        'What they thought',
        el(
          'select',
          {
            onchange: function (e) {
              form.outcome = e.target.value;
            },
          },
          [
            el('option', { value: 'interested', text: 'Interested' }),
            el('option', { value: 'not_interested', text: 'Not for them' }),
            el('option', { value: 'wants_alternative', text: 'Wants something else' }),
          ],
        ),
      ]),
    );
    box.appendChild(
      el('label', null, [
        'Notes',
        el('textarea', {
          rows: '2',
          oninput: function (e) {
            form.notes = e.target.value;
          },
        }),
      ]),
    );
    box.appendChild(
      el('div', { class: 'row' }, [
        el('button', {
          text: 'Back on the lot',
          onclick: async function () {
            try {
              await api(
                'POST',
                '/api/sales/opportunities/' +
                  o.opportunityId +
                  '/demonstrations/' +
                  drive.demonstrationId +
                  '/end',
                {
                  expected_version: drive.authorizationVersion,
                  state: form.state,
                  outcome: form.state === 'abandoned' ? null : form.outcome,
                  notes: form.notes || null,
                },
              );
              close();
              toast('The car is back');
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
      ]),
    );
  });
}

function openAssign(o) {
  modal('Give this deal to somebody', function (box, close) {
    const form = { to_user_link_id: '', reason: 'manual_assignment', note: '' };
    box.appendChild(
      el('p', {
        class: 'muted',
        text: 'They have to work this showroom — the platform checks, it does not assume.',
      }),
    );
    box.appendChild(
      el('label', null, [
        'Salesperson ID',
        el('input', {
          oninput: function (e) {
            form.to_user_link_id = e.target.value.trim();
          },
        }),
      ]),
    );
    box.appendChild(
      el('label', null, [
        'Why',
        el(
          'select',
          {
            onchange: function (e) {
              form.reason = e.target.value;
            },
          },
          [
            'manual_assignment',
            'reassignment',
            'floor_rotation',
            'turnover',
            'manager_override',
          ].map(function (k) {
            return el('option', { value: k, text: k.replace(/_/g, ' ') });
          }),
        ),
      ]),
    );
    box.appendChild(
      el('label', null, [
        'Note',
        el('textarea', {
          rows: '2',
          oninput: function (e) {
            form.note = e.target.value;
          },
        }),
      ]),
    );
    box.appendChild(
      el('div', { class: 'row' }, [
        el('button', {
          text: 'Assign',
          onclick: async function () {
            try {
              await api('POST', '/api/sales/opportunities/' + o.opportunityId + '/assignment', {
                expected_version: o.authorizationVersion,
                to_user_link_id: form.to_user_link_id,
                reason: form.reason,
                note: form.note || null,
              });
              close();
              toast('Assigned');
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
      ]),
    );
  });
}

function openActivity(o) {
  modal('Log something', function (box, close) {
    // A call, an email or a text IS a conversation, so choosing one sets the
    // direction rather than leaving the operator to discover the refusal.
    const form = { kind: 'note', direction: '', subject: '', body: '' };
    const COMMUNICATIONS = ['call', 'email', 'sms'];
    box.appendChild(
      el('label', null, [
        'What',
        el(
          'select',
          {
            onchange: function (e) {
              form.kind = e.target.value;
              const isTalk = COMMUNICATIONS.indexOf(form.kind) >= 0;
              form.direction = isTalk ? form.direction || 'outbound' : '';
              const picker = document.getElementById('sales-activity-direction');
              if (picker) {
                picker.value = form.direction;
                picker.disabled = !isTalk;
              }
            },
          },
          ['note', 'call', 'email', 'sms', 'task'].map(function (k) {
            return el('option', { value: k, text: k });
          }),
        ),
      ]),
    );
    box.appendChild(
      el('label', null, [
        'Which way',
        el(
          'select',
          {
            id: 'sales-activity-direction',
            disabled: 'disabled',
            onchange: function (e) {
              form.direction = e.target.value;
            },
          },
          [
            el('option', { value: '', text: 'Not a conversation' }),
            el('option', { value: 'outbound', text: 'We contacted them' }),
            el('option', { value: 'inbound', text: 'They contacted us' }),
          ],
        ),
      ]),
    );
    box.appendChild(
      el('label', null, [
        'Subject',
        el('input', {
          oninput: function (e) {
            form.subject = e.target.value;
          },
        }),
      ]),
    );
    box.appendChild(
      el('label', null, [
        'Detail',
        el('textarea', {
          rows: '3',
          oninput: function (e) {
            form.body = e.target.value;
          },
        }),
      ]),
    );
    box.appendChild(
      el('div', { class: 'row' }, [
        el('button', {
          text: 'Log it',
          onclick: async function () {
            try {
              await api(
                'POST',
                '/api/sales/opportunities/' + o.opportunityId + '/activities',
                {
                  kind: form.kind,
                  direction: form.direction || null,
                  subject: form.subject,
                  body: form.body || null,
                },
                { idempotent: true },
              );
              close();
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
      ]),
    );
  });
}

function openNegotiation(o) {
  modal('Record a negotiation round', function (box, close) {
    const form = {
      initiated_by: 'customer',
      summary: '',
      manager_involved: false,
      outcome: 'countered',
    };
    box.appendChild(
      el('p', {
        class: 'muted',
        text:
          'What was SAID, not what was offered. The figures belong to desking ' +
          '(FBL-120), and there is deliberately nowhere to type one here.',
      }),
    );
    box.appendChild(
      el('label', null, [
        'Who started it',
        el(
          'select',
          {
            onchange: function (e) {
              form.initiated_by = e.target.value;
            },
          },
          [
            el('option', { value: 'customer', text: 'The customer' }),
            el('option', { value: 'dealership', text: 'Us' }),
          ],
        ),
      ]),
    );
    box.appendChild(
      el('label', null, [
        'What was discussed',
        el('textarea', {
          rows: '3',
          oninput: function (e) {
            form.summary = e.target.value;
          },
        }),
      ]),
    );
    box.appendChild(
      el('label', null, [
        'Where it left off',
        el(
          'select',
          {
            onchange: function (e) {
              form.outcome = e.target.value;
            },
          },
          ['countered', 'accepted', 'declined', 'adjourned'].map(function (k) {
            return el('option', { value: k, text: k });
          }),
        ),
      ]),
    );
    box.appendChild(
      el('label', { class: 'check' }, [
        el('input', {
          type: 'checkbox',
          onchange: function (e) {
            form.manager_involved = e.target.checked;
          },
        }),
        ' A manager was in the conversation',
      ]),
    );
    box.appendChild(
      el('div', { class: 'row' }, [
        el('button', {
          text: 'Record',
          onclick: async function () {
            try {
              await api('POST', '/api/sales/opportunities/' + o.opportunityId + '/negotiation', {
                initiated_by: form.initiated_by,
                summary: form.summary,
                manager_involved: form.manager_involved,
                outcome: form.outcome,
              });
              close();
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
      ]),
    );
  });
}

function openTurnover(o) {
  modal('Bring a manager in', function (box, close) {
    const form = { manager_user_link_id: '', reason: 'second_voice', note: '' };
    box.appendChild(
      el('label', null, [
        'Manager ID',
        el('input', {
          oninput: function (e) {
            form.manager_user_link_id = e.target.value.trim();
          },
        }),
      ]),
    );
    box.appendChild(
      el('label', null, [
        'Why',
        el(
          'select',
          {
            onchange: function (e) {
              form.reason = e.target.value;
            },
          },
          ['second_voice', 'price_authority', 'customer_request', 'closing', 'escalation'].map(
            function (k) {
              return el('option', { value: k, text: k.replace(/_/g, ' ') });
            },
          ),
        ),
      ]),
    );
    box.appendChild(
      el('label', null, [
        'Note',
        el('textarea', {
          rows: '2',
          oninput: function (e) {
            form.note = e.target.value;
          },
        }),
      ]),
    );
    box.appendChild(
      el('div', { class: 'row' }, [
        el('button', {
          text: 'Record the turnover',
          onclick: async function () {
            try {
              await api('POST', '/api/sales/opportunities/' + o.opportunityId + '/turnover', {
                manager_user_link_id: form.manager_user_link_id,
                reason: form.reason,
                note: form.note || null,
              });
              close();
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
      ]),
    );
  });
}

// ── registration ────────────────────────────────────────────────────────────

ROUTES.showroom = { title: 'Showroom', render: renderShowroom };
ROUTES.deals = { title: 'Deals', render: renderSalesPipeline };

// Reached from a row on the pipeline or the showroom, so it routes without
// taking a tab of its own.
ROUTES.opportunity = { title: 'Opportunity', render: renderOpportunity, hidden: true };
