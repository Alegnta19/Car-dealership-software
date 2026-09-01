/**
 * RT4 — the sales pipeline and showroom screens of the staff console.
 *
 * Loaded after app.js, which owns the shell, the router and the fetch wrapper.
 * A classic script's top-level `const` is visible to the scripts that follow
 * it, so this file registers its screens by extending the same ROUTES map the
 * shell renders from — no bundler, no module system, no framework.
 *
 * NOBODY TYPES AN IDENTIFIER. Every id this surface needs — a handoff, a
 * customer, an appointment, a car, a colleague — is CHOSEN from a list the
 * server filtered to what the person's bindings reach. A form asking for a UUID
 * is not an interface: it is a text box somebody has to copy a database key
 * into, and it is a way to probe for records that the refusals then have to be
 * careful not to confirm. `picker()` below is the one primitive that replaces
 * all of them.
 *
 * WHAT THE SCREENS ARE FOR, in the order a showroom actually works:
 *
 *   * SHOWROOM — the up-list, who is expected, who is in the building and how
 *     long they have been waiting. The screen a manager keeps open all Saturday,
 *     so the only red on it is somebody who needs seeing to.
 *   * DEALS — every live opportunity, its stage, its owner, its age and what is
 *     owed on it next.
 *   * OPPORTUNITY — one customer's whole visit on one timeline: the cars they
 *     looked at, what they drove, what was said, who else got involved, and the
 *     one button that hands a committed customer to appraisal and desking.
 *
 * WHAT IS DELIBERATELY NOT HERE: a price, a payment, a gross, a commission, and
 * any way to record a sale. This train cannot sell anything — the furthest it
 * goes is saying a customer is ready to be desked, which is FBL-120's work.
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

const STAGE_LABELS = {
  received: 'Received',
  in_showroom: 'In showroom',
  demonstrated: 'Demonstrated',
  negotiating: 'Negotiating',
  follow_up: 'Following up',
  ready_for_desking: 'Ready to desk',
  lost: 'Lost',
};

/** Where an opportunity may go from where it is. Mirrors the service exactly. */
const STAGE_NEXT = {
  received: ['in_showroom', 'demonstrated', 'negotiating', 'follow_up', 'lost'],
  in_showroom: ['demonstrated', 'negotiating', 'follow_up', 'ready_for_desking', 'lost'],
  demonstrated: ['negotiating', 'in_showroom', 'follow_up', 'ready_for_desking', 'lost'],
  negotiating: ['demonstrated', 'follow_up', 'ready_for_desking', 'lost'],
  follow_up: ['in_showroom', 'demonstrated', 'negotiating', 'ready_for_desking', 'lost'],
  ready_for_desking: [],
  lost: [],
};

const TERMINAL_STAGES = ['ready_for_desking', 'lost'];

/**
 * Why a deal ended. There is NO `sold`, because this train cannot sell: the
 * positive outcome is a customer committing, whose only effect is to hand them
 * to appraisal and desking.
 */
const LOST_REASONS = [
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
    'These screens carry no figure because nothing is priced or desked until ' +
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

/**
 * THE PRIMITIVE THAT REPLACES EVERY TEXT BOX FOR AN IDENTIFIER.
 *
 * Fetches a list from the server, renders it as rows somebody can read and
 * click, and hands the caller back the chosen record — never a string the user
 * typed. `search` makes it a live filter for the long lists (customers,
 * vehicles); without it the list is short enough to just show.
 *
 * It says plainly when there is nothing to choose, because an empty list and a
 * broken screen look identical otherwise.
 */
function picker(box, spec) {
  const holder = el('div', { class: 'picker' }, [el('div', { class: 'muted', text: 'Loading…' })]);
  box.appendChild(el('label', null, [spec.label]));
  if (spec.search) {
    box.appendChild(
      el('input', {
        placeholder: spec.searchPlaceholder || 'Type to search',
        oninput: function (e) {
          load(e.target.value.trim());
        },
      }),
    );
  }
  box.appendChild(holder);

  async function load(query) {
    holder.textContent = '';
    holder.appendChild(el('div', { class: 'muted', text: 'Loading…' }));
    try {
      const path =
        spec.path +
        (query ? (spec.path.indexOf('?') >= 0 ? '&' : '?') + 'q=' + encodeURIComponent(query) : '');
      const data = await api('GET', path);
      const rows = data[spec.collection] || [];
      holder.textContent = '';
      if (rows.length === 0) {
        holder.appendChild(el('div', { class: 'muted', text: spec.empty }));
        return;
      }
      rows.forEach(function (row) {
        holder.appendChild(
          el('button', {
            class: 'ghost small pick',
            text: spec.render(row),
            onclick: function () {
              spec.onPick(row);
            },
          }),
        );
      });
    } catch (err) {
      holder.textContent = '';
      holder.appendChild(el('div', { class: 'error-banner', text: err.message }));
    }
  }

  void load('');
  return holder;
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
  const expected = await api(
    'GET',
    '/api/sales/find/appointments?location_id=' + salesState.rooftopId,
  );

  const rooftopChooser = rooftopPicker(renderApp);
  if (rooftopChooser) view.appendChild(el('div', { class: 'toolbar' }, [rooftopChooser]));

  view.appendChild(
    el('div', { class: 'cards' }, [
      statCard(board.showroom.waiting, 'Waiting to be greeted'),
      statCard(board.showroom.withSalesperson, 'With a salesperson'),
      statCard(board.floor.available, 'On the floor, free'),
      statCard(board.demonstrations.activeNow, 'Cars out on drives'),
    ]),
  );

  // ── what a manager has to act on ──────────────────────────────────────────
  if ((board.exceptions || []).length > 0) {
    view.appendChild(
      el('div', { class: 'panel' }, [
        el('h2', { text: 'Needs attention' }),
        el(
          'ul',
          { class: 'exceptions' },
          (board.exceptions || []).map(function (x) {
            return el('li', { class: 'urgent' }, [
              el('strong', { text: String(x.kind).replace(/_/g, ' ') + ': ' }),
              x.detail + ' — ' + salesAgo(x.since),
              x.opportunityId
                ? el('a', {
                    class: 'link small',
                    href: '#/opportunity/' + x.opportunityId,
                    text: 'Open deal',
                  })
                : null,
            ]);
          }),
        ),
      ]),
    );
  }

  // ── who is expected ───────────────────────────────────────────────────────
  view.appendChild(
    el('div', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        el('h2', { text: 'Expected today' }),
        el('button', {
          class: 'ghost',
          text: 'Somebody walked in',
          onclick: function () {
            openWalkIn();
          },
        }),
      ]),
      (expected.appointments || []).length === 0
        ? el('p', { class: 'muted', text: 'Nobody is booked in around now.' })
        : el('table', { class: 'grid' }, [
            el('thead', null, [
              el('tr', null, [
                el('th', { text: 'Customer' }),
                el('th', { text: 'Due' }),
                el('th', { text: 'For' }),
                el('th', { text: '' }),
              ]),
            ]),
            el(
              'tbody',
              null,
              (expected.appointments || []).map(function (a) {
                return el('tr', null, [
                  el('td', { text: a.customerName }),
                  el('td', { text: salesWhen(a.startsAt) }),
                  el('td', { text: String(a.purpose).replace(/_/g, ' ') }),
                  el('td', null, [
                    el('button', {
                      class: 'small',
                      text: 'They are here',
                      onclick: function () {
                        checkInExpected(a);
                      },
                    }),
                  ]),
                ]);
              }),
            ),
          ]),
    ]),
  );

  // ── who is in the building ────────────────────────────────────────────────
  const here = (visits.visits || []).filter(function (v) {
    return v.state !== 'departed';
  });

  view.appendChild(
    el('div', { class: 'panel' }, [
      el('h2', { text: 'In the showroom' }),
      here.length === 0
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
              here.map(function (v) {
                return el('tr', { class: v.state === 'arrived' ? 'urgent' : '' }, [
                  el('td', { text: v.customerName }),
                  el('td', { text: salesSince(v.arrivedAt) }),
                  el('td', null, [visitBadge(v.state)]),
                  el('td', {
                    text: salesStaff(v.acceptedByUserLinkId || v.greetedByUserLinkId),
                  }),
                  el('td', null, [
                    v.state === 'arrived'
                      ? el('button', {
                          class: 'small',
                          text: 'Greet',
                          onclick: function () {
                            openGreet(v);
                          },
                        })
                      : null,
                    v.state === 'greeted'
                      ? el('button', {
                          class: 'small',
                          text: 'I will take them',
                          onclick: function () {
                            acceptVisit(v);
                          },
                        })
                      : null,
                    el('button', {
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

/** They turned up for their booking: one click, no identifiers. */
async function checkInExpected(appointment) {
  try {
    const res = await api(
      'POST',
      '/api/sales/visits',
      {
        location_id: salesState.rooftopId,
        party_id: appointment.partyId,
        appointment_id: appointment.appointmentId,
      },
      { idempotent: true },
    );
    toast(res.appointmentKept ? 'Checked in, booking kept' : 'Checked in');
    renderApp();
  } catch (err) {
    reportError(err);
  }
}

/**
 * SOMEBODY WALKED IN, and the customer is FOUND before they are created.
 *
 * Searching first is not politeness, it is the canonical path: a walk-in that
 * went straight to a create form would open a second record on half the people
 * who have ever bought here.
 */
function openWalkIn(preselected) {
  modal('Somebody walked in', function (box, close) {
    const form = { party_id: preselected || null, customer: null };

    async function open() {
      try {
        const payload = { location_id: salesState.rooftopId };
        if (form.party_id) payload.party_id = form.party_id;
        else payload.customer = form.customer;
        const res = await api('POST', '/api/sales/walk-ins', payload, { idempotent: true });
        close();
        location.hash = '#/opportunity/' + res.opportunity.opportunityId;
        renderApp();
      } catch (err) {
        if (err.status === 409 && err.body && err.body.candidates) {
          // NOT AN ERROR TO SWALLOW. The dealership already knows somebody with
          // these details; the salesperson picks the real person rather than
          // creating a second file on them.
          box.textContent = '';
          box.appendChild(el('h3', { text: 'We already know somebody like this' }));
          box.appendChild(
            el('p', {
              class: 'muted',
              text: 'Pick the person if this is them, so the dealership keeps one record.',
            }),
          );
          err.body.candidates.forEach(function (c) {
            box.appendChild(
              el('button', {
                class: 'ghost small pick',
                text: c.displayName + ' (matched on ' + c.matchedOn + ')',
                onclick: function () {
                  form.party_id = c.partyId;
                  form.customer = null;
                  void open();
                },
              }),
            );
          });
          box.appendChild(el('button', { class: 'ghost', text: 'Cancel', onclick: close }));
          return;
        }
        reportError(err);
      }
    }

    box.appendChild(
      el('p', {
        class: 'muted',
        text: 'Search for them first — most walk-ins are people we already have.',
      }),
    );
    picker(box, {
      label: 'Find the customer',
      path: '/api/sales/find/customers',
      collection: 'customers',
      search: true,
      searchPlaceholder: 'Name, email or phone',
      empty: 'Nobody found. Add them below if they are new to us.',
      render: function (c) {
        return (
          c.displayName + (c.hasEmail ? ' · has email' : '') + (c.hasPhone ? ' · has phone' : '')
        );
      },
      onPick: function (c) {
        form.party_id = c.partyId;
        form.customer = null;
        void open();
      },
    });

    box.appendChild(el('h3', { text: 'Or add somebody new' }));
    const fresh = { given_name: '', family_name: '', email: '', phone: '' };
    [
      ['First name', 'given_name'],
      ['Last name', 'family_name'],
      ['Email', 'email'],
      ['Phone', 'phone'],
    ].forEach(function (pair) {
      box.appendChild(
        el('label', null, [
          pair[0],
          el('input', {
            oninput: function (e) {
              fresh[pair[1]] = e.target.value.trim();
            },
          }),
        ]),
      );
    });
    box.appendChild(
      el('div', { class: 'row' }, [
        el('button', {
          text: 'Add and open a deal',
          onclick: function () {
            form.party_id = null;
            form.customer = fresh;
            void open();
          },
        }),
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
      ]),
    );
  });
}

function openGreet(visit) {
  modal('Greet ' + (visit.customerName || 'this customer'), function (box, close) {
    async function greet(userLinkId) {
      try {
        const res = await api('POST', '/api/sales/visits/' + visit.visitId + '/greet', {
          expected_version: visit.authorizationVersion,
          greeted_by_user_link_id: userLinkId || null,
        });
        close();
        toast(res.fromRotation ? 'Next up took the customer' : 'Assigned by name');
        renderApp();
      } catch (err) {
        reportError(err);
      }
    }

    box.appendChild(
      el('p', {
        class: 'muted',
        text:
          'Take the next turn off the floor, or name somebody the customer asked ' +
          'for — it costs them their turn either way.',
      }),
    );
    box.appendChild(
      el('div', { class: 'row' }, [
        el('button', {
          text: 'Next up',
          onclick: function () {
            void greet(null);
          },
        }),
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
      ]),
    );
    picker(box, {
      label: 'Or somebody they asked for',
      path: '/api/sales/find/staff?location_id=' + salesState.rooftopId,
      collection: 'staff',
      empty: 'Nobody is on this floor.',
      render: function (s) {
        return (
          salesStaff(s.userLinkId) +
          (s.onFloor ? ' · ' + String(s.floorStatus).replace(/_/g, ' ') : ' · not on the floor')
        );
      },
      onPick: function (s) {
        void greet(s.userLinkId);
      },
    });
  });
}

async function acceptVisit(visit) {
  try {
    await api('POST', '/api/sales/visits/' + visit.visitId + '/acceptance', {
      expected_version: visit.authorizationVersion,
    });
    toast('They are yours');
    renderApp();
  } catch (err) {
    reportError(err);
  }
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
    picker(box, {
      label: 'Who is on',
      path: '/api/sales/find/staff?location_id=' + salesState.rooftopId,
      collection: 'staff',
      empty: 'Nobody at this showroom holds a sales role.',
      render: function (s) {
        return (
          salesStaff(s.userLinkId) +
          (s.onFloor ? ' · already on' : '') +
          ' · ' +
          s.openOpportunities +
          ' open'
        );
      },
      onPick: async function (s) {
        try {
          await api(
            'POST',
            '/api/sales/floor',
            { location_id: salesState.rooftopId, user_link_id: s.userLinkId },
            { idempotent: true },
          );
          close();
          toast('On the floor');
          renderApp();
        } catch (err) {
          reportError(err);
        }
      },
    });
    box.appendChild(el('button', { class: 'ghost', text: 'Cancel', onclick: close }));
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

// ── the pipeline ────────────────────────────────────────────────────────────

async function renderSalesPipeline(view) {
  const board = await api('GET', '/api/sales/board');
  const data = await api('GET', '/api/sales/opportunities');

  view.appendChild(
    el('div', { class: 'cards' }, [
      statCard(board.pipeline.open, 'Open deals'),
      statCard(board.pipeline.negotiating, 'Negotiating'),
      statCard(board.nextActions.overdue, 'Overdue actions'),
      statCard(board.pipeline.readyForDesking, 'Waiting on the desk'),
    ]),
  );

  view.appendChild(
    notYetAvailable('Gross, commission, ROI and closing ratio', 'FBL-120 (Appraisal and desking)'),
  );

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
                el('th', { text: 'Next' }),
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
                  el('td', { text: o.rooftopName }),
                  el('td', { text: salesAge(o.ageHours) }),
                  el('td', {
                    class:
                      o.nextActionDueAt && new Date(o.nextActionDueAt) < new Date() ? 'urgent' : '',
                    text: o.nextActionSubject
                      ? o.nextActionSubject + ' (' + salesWhen(o.nextActionDueAt) + ')'
                      : '—',
                  }),
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
    box.appendChild(
      el('p', {
        class: 'muted',
        text:
          'The handoff carries the customer, the showroom and the car they asked ' +
          'about. Sales does not get to choose any of them, which is why there is ' +
          'nothing to fill in here.',
      }),
    );
    picker(box, {
      label: 'Waiting to be received',
      path: '/api/sales/find/handoffs',
      collection: 'handoffs',
      empty: 'Nothing waiting. The BDC hands leads over when they are qualified.',
      render: function (h) {
        return (
          h.customerName +
          ' · ' +
          h.rooftopName +
          ' · handed over ' +
          salesAgo(h.occurredAt) +
          (h.appointmentAt ? ' · booked ' + salesWhen(h.appointmentAt) : '')
        );
      },
      onPick: async function (h) {
        try {
          const res = await api(
            'POST',
            '/api/sales/opportunities',
            { handoff_id: h.handoffId },
            { idempotent: true },
          );
          close();
          location.hash = '#/opportunity/' + res.opportunity.opportunityId;
          renderApp();
        } catch (err) {
          reportError(err);
        }
      },
    });
    box.appendChild(el('button', { class: 'ghost', text: 'Cancel', onclick: close }));
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
  const finished = TERMINAL_STAGES.indexOf(o.stage) >= 0;

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
            el('td', {
              text:
                o.origin === 'walk_in'
                  ? 'Walked in'
                  : 'BDC handoff ' + String(o.handoffId || '').slice(0, 8),
            }),
          ]),
          el('tr', null, [
            el('th', { text: 'Opened' }),
            el('td', { text: salesWhen(o.createdAt) }),
          ]),
          o.disposition
            ? el('tr', null, [
                el('th', { text: 'Outcome' }),
                el('td', { text: String(o.disposition).replace(/_/g, ' ') }),
              ])
            : null,
        ]),
      ]),
      finished
        ? null
        : el('div', { class: 'row' }, [
            o.ownerUserLinkId
              ? null
              : el('button', {
                  text: 'I will take this one',
                  onclick: function () {
                    acceptOpportunity(o);
                  },
                }),
            el('button', {
              class: 'ghost small',
              text: 'Give this deal to somebody',
              onclick: function () {
                openAssign(o);
              },
            }),
          ]),
      finished
        ? null
        : el(
            'div',
            { class: 'row' },
            (STAGE_NEXT[o.stage] || []).map(function (stage) {
              return el('button', {
                class: TERMINAL_STAGES.indexOf(stage) >= 0 ? '' : 'ghost',
                text: STAGE_LABELS[stage] || stage,
                onclick: function () {
                  openStageMove(o, stage);
                },
              });
            }),
          ),
    ]),
  );

  if (o.stage === 'ready_for_desking') {
    view.appendChild(
      el('div', { class: 'panel muted' }, [
        el('strong', { text: 'Handed to appraisal and desking. ' }),
        'This customer committed to buying, and that fact has been passed on exactly ' +
          'once. No price, deal or delivery exists yet — those are FBL-120 and later, ' +
          'and this deal stays readable while they are built.',
      ]),
    );
  } else if (o.stage === 'lost') {
    view.appendChild(
      el('div', { class: 'panel muted' }, [
        'This deal is closed. It stays readable, and nothing further can be written ' +
          'against it.',
      ]),
    );
  }

  // ── what is owed next ─────────────────────────────────────────────────────
  if ((data.openActions || []).length > 0 || !finished) {
    view.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'panel-head' }, [
          el('h2', { text: 'Owed next' }),
          finished
            ? null
            : el('button', {
                class: 'ghost',
                text: 'Add a task',
                onclick: function () {
                  openTask(o);
                },
              }),
        ]),
        (data.openActions || []).length === 0
          ? el('p', { class: 'muted', text: 'Nothing owed on this deal.' })
          : el('table', { class: 'grid' }, [
              el('thead', null, [
                el('tr', null, [
                  el('th', { text: 'What' }),
                  el('th', { text: 'Due' }),
                  el('th', { text: '' }),
                ]),
              ]),
              el(
                'tbody',
                null,
                (data.openActions || []).map(function (a) {
                  return el('tr', { class: a.overdue ? 'urgent' : '' }, [
                    el('td', { text: a.subject }),
                    el('td', { text: a.dueAt ? salesWhen(a.dueAt) : '—' }),
                    el('td', null, [
                      el('button', {
                        class: 'small',
                        text: 'Done',
                        onclick: function () {
                          closeAction(o, a, 'completed');
                        },
                      }),
                      el('button', {
                        class: 'ghost small',
                        text: 'Call it off',
                        onclick: function () {
                          openCancelAction(o, a);
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

  // ── the cars ──────────────────────────────────────────────────────────────
  view.appendChild(
    el('div', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        el('h2', { text: 'Cars they are looking at' }),
        finished
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
                  el('td', { text: v.stockNumber }),
                  el('td', { text: v.description }),
                  el('td', null, [badge(v.status)]),
                  el('td', null, [
                    finished
                      ? null
                      : el('button', {
                          class: 'ghost small',
                          text: 'Test drive',
                          onclick: function () {
                            openDemonstration(o, v);
                          },
                        }),
                    finished || v.status === 'selected'
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

  // ── the cars that are out ─────────────────────────────────────────────────
  if ((data.outOnDrive || []).length > 0) {
    view.appendChild(
      el('div', { class: 'panel' }, [
        el('h2', { text: 'Out on a test drive' }),
        el('table', { class: 'grid' }, [
          el('thead', null, [
            el('tr', null, [
              el('th', { text: 'Stock' }),
              el('th', { text: 'State' }),
              el('th', { text: 'Since' }),
              el('th', { text: '' }),
            ]),
          ]),
          el(
            'tbody',
            null,
            (data.outOnDrive || []).map(function (drive) {
              return el('tr', { class: drive.minutesOut > 120 ? 'urgent' : '' }, [
                el('td', { text: drive.stockNumber }),
                el('td', null, [badge(drive.state)]),
                el('td', { text: salesAgo(drive.issuedAt) }),
                el('td', null, [
                  drive.state === 'issued'
                    ? el('button', {
                        class: 'small',
                        text: 'They have driven off',
                        onclick: function () {
                          moveDrive(o, drive, { to_state: 'in_progress' });
                        },
                      })
                    : null,
                  el('button', {
                    class: 'small',
                    text: 'They are back',
                    onclick: function () {
                      openEndDrive(o, drive);
                    },
                  }),
                  el('button', {
                    class: 'ghost small',
                    text: 'Something happened',
                    onclick: function () {
                      openDriveException(o, drive);
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
        finished
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
                  el('strong', { text: String(entry.kind).replace(/_/g, ' ') + ': ' }),
                  entry.summary || '',
                ]),
                el('div', { class: 'who muted', text: entry.detail || '' }),
              ]);
            }),
          ),
    ]),
  );
}

async function acceptOpportunity(o) {
  try {
    await api('POST', '/api/sales/opportunities/' + o.opportunityId + '/acceptance', {
      expected_version: o.authorizationVersion,
    });
    toast('It is yours');
    renderApp();
  } catch (err) {
    reportError(err);
  }
}

function openAssign(o) {
  modal('Give this deal to somebody', function (box, close) {
    const form = { reason: 'reassignment', note: '' };
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
            'reassignment',
            'manual_assignment',
            'floor_rotation',
            'turnover',
            'manager_override',
          ].map(function (k) {
            return el('option', {
              value: k,
              text: k.replace(/_/g, ' '),
              selected: k === 'reassignment' ? 'selected' : null,
            });
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
    picker(box, {
      label: 'Who takes it',
      path: '/api/sales/find/staff?location_id=' + (salesState.rooftopId || ''),
      collection: 'staff',
      empty: 'Nobody at this showroom holds a sales role.',
      render: function (s) {
        return salesStaff(s.userLinkId) + ' · ' + s.openOpportunities + ' open';
      },
      onPick: async function (s) {
        try {
          await api('POST', '/api/sales/opportunities/' + o.opportunityId + '/assignment', {
            expected_version: o.authorizationVersion,
            to_user_link_id: s.userLinkId,
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
    });
    box.appendChild(el('button', { class: 'ghost', text: 'Cancel', onclick: close }));
  });
}

function openStageMove(o, stage) {
  const needsReason = TERMINAL_STAGES.indexOf(stage) >= 0;
  const positive = stage === 'ready_for_desking';
  modal('Move to ' + (STAGE_LABELS[stage] || stage), function (box, close) {
    const form = { disposition: positive ? 'committed_to_purchase' : '', note: '' };
    if (positive) {
      box.appendChild(
        el('p', { class: 'muted' }, [
          el('strong', { text: 'This hands them to appraisal and desking. ' }),
          'It records that the customer committed to buying — nothing more. No ' +
            'price, no deal, no delivery, and no sale: those are FBL-120 and later.',
        ]),
      );
    }
    if (needsReason && !positive) {
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
              LOST_REASONS.map(function (d) {
                return el('option', { value: d.value, text: d.label });
              }),
            ),
          ),
        ]),
      );
    }
    if (stage === 'follow_up') {
      box.appendChild(
        el('p', {
          class: 'muted',
          text: 'A follow-up needs something owed — add the task that is due first.',
        }),
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
          text: positive ? 'Hand to desking' : 'Move',
          onclick: async function () {
            try {
              await api('POST', '/api/sales/opportunities/' + o.opportunityId + '/stage', {
                expected_version: o.authorizationVersion,
                to_stage: stage,
                disposition: form.disposition || null,
                note: form.note || null,
              });
              close();
              toast(positive ? 'Handed to appraisal and desking' : 'Moved');
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
    box.appendChild(
      el('p', {
        class: 'muted',
        text: 'Only cars on this showroom’s lot are listed.',
      }),
    );
    picker(box, {
      label: 'Find a car',
      path: '/api/sales/find/vehicles',
      collection: 'vehicles',
      search: true,
      searchPlaceholder: 'Stock number, VIN, make or model',
      empty: 'Nothing in stock matches.',
      render: function (v) {
        return (
          v.stockNumber + ' · ' + v.description + (v.outOnDemonstration ? ' · out on a drive' : '')
        );
      },
      onPick: async function (v) {
        try {
          await api(
            'POST',
            '/api/sales/opportunities/' + o.opportunityId + '/vehicles',
            { stock_item_id: v.stockItemId },
            { idempotent: true },
          );
          close();
          renderApp();
        } catch (err) {
          reportError(err);
        }
      },
    });
    box.appendChild(el('button', { class: 'ghost', text: 'Cancel', onclick: close }));
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
  modal('Take ' + vehicle.stockNumber + ' out', function (box, close) {
    const form = { licence_verified: false };
    box.appendChild(
      el('p', {
        class: 'muted',
        text:
          'A car does not leave the lot until somebody has looked at the driver’s ' +
          'licence. This box is the record that it happened.',
      }),
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
          text: 'Issue the keys',
          onclick: async function () {
            try {
              await api(
                'POST',
                '/api/sales/opportunities/' + o.opportunityId + '/demonstrations',
                {
                  stock_item_id: vehicle.stockItemId,
                  driver_party_id: o.partyId,
                  licence_verified: form.licence_verified,
                },
                { idempotent: true },
              );
              close();
              toast('Keys issued');
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

async function moveDrive(o, drive, payload) {
  try {
    await api(
      'POST',
      '/api/sales/opportunities/' +
        o.opportunityId +
        '/demonstrations/' +
        drive.demonstrationId +
        '/state',
      Object.assign({ expected_version: drive.authorizationVersion }, payload),
    );
    renderApp();
  } catch (err) {
    reportError(err);
  }
}

function openEndDrive(o, drive) {
  modal('Bring ' + drive.stockNumber + ' back', function (box, close) {
    const form = { to_state: 'returned', outcome: 'interested', notes: '', reason: '' };
    box.appendChild(
      el('p', {
        class: 'muted',
        text:
          'A finished drive records what the customer thought. One that never went ' +
          'out records why instead, because nobody found out.',
      }),
    );
    box.appendChild(
      el('label', null, [
        'How it went',
        el(
          'select',
          {
            onchange: function (e) {
              form.to_state = e.target.value;
            },
          },
          [
            el('option', { value: 'returned', text: 'They drove it and it is back' }),
            el('option', { value: 'cancelled', text: 'It never went out' }),
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
        'Notes, or why it was called off',
        el('textarea', {
          rows: '2',
          oninput: function (e) {
            form.notes = e.target.value;
            form.reason = e.target.value;
          },
        }),
      ]),
    );
    box.appendChild(
      el('div', { class: 'row' }, [
        el('button', {
          text: 'Back on the lot',
          onclick: async function () {
            const payload =
              form.to_state === 'returned'
                ? { to_state: 'returned', outcome: form.outcome, notes: form.notes || null }
                : { to_state: 'cancelled', reason: form.reason };
            await moveDrive(o, drive, payload);
            close();
          },
        }),
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
      ]),
    );
  });
}

function openDriveException(o, drive) {
  modal('Something happened to ' + drive.stockNumber, function (box, close) {
    const form = { exception_kind: 'damage', notes: '' };
    box.appendChild(
      el('p', {
        class: 'muted',
        text:
          'This frees the car from the active list so the next customer is not ' +
          'offered it, and puts the deal on the manager’s attention list.',
      }),
    );
    box.appendChild(
      el('label', null, [
        'What happened',
        el(
          'select',
          {
            onchange: function (e) {
              form.exception_kind = e.target.value;
            },
          },
          ['damage', 'accident', 'not_returned', 'breakdown', 'other'].map(function (k) {
            return el('option', { value: k, text: k.replace(/_/g, ' ') });
          }),
        ),
      ]),
    );
    box.appendChild(
      el('label', null, [
        'Details',
        el('textarea', {
          rows: '3',
          oninput: function (e) {
            form.notes = e.target.value;
          },
        }),
      ]),
    );
    box.appendChild(
      el('div', { class: 'row' }, [
        el('button', {
          text: 'Record it',
          onclick: async function () {
            await moveDrive(o, drive, {
              to_state: 'exception',
              exception_kind: form.exception_kind,
              notes: form.notes,
            });
            close();
          },
        }),
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
      ]),
    );
  });
}

function openTask(o) {
  modal('Add a task', function (box, close) {
    const form = { subject: '', due_at: '' };
    box.appendChild(
      el('label', null, [
        'What is owed',
        el('input', {
          oninput: function (e) {
            form.subject = e.target.value;
          },
        }),
      ]),
    );
    box.appendChild(
      el('label', null, [
        'When',
        el('input', {
          type: 'datetime-local',
          oninput: function (e) {
            form.due_at = e.target.value;
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
                '/api/sales/opportunities/' + o.opportunityId + '/activities',
                {
                  kind: 'task',
                  subject: form.subject,
                  due_at: form.due_at ? new Date(form.due_at).toISOString() : null,
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

async function closeAction(o, action, state) {
  try {
    await api(
      'POST',
      '/api/sales/opportunities/' + o.opportunityId + '/activities/' + action.activityId + '/close',
      { expected_version: action.authorizationVersion, state: state },
    );
    renderApp();
  } catch (err) {
    reportError(err);
  }
}

function openCancelAction(o, action) {
  modal('Call off: ' + action.subject, function (box, close) {
    const form = { reason: '' };
    box.appendChild(
      el('label', null, [
        'Why it no longer applies',
        el('textarea', {
          rows: '2',
          oninput: function (e) {
            form.reason = e.target.value;
          },
        }),
      ]),
    );
    box.appendChild(
      el('div', { class: 'row' }, [
        el('button', {
          text: 'Call it off',
          onclick: async function () {
            try {
              await api(
                'POST',
                '/api/sales/opportunities/' +
                  o.opportunityId +
                  '/activities/' +
                  action.activityId +
                  '/close',
                {
                  expected_version: action.authorizationVersion,
                  state: 'cancelled',
                  reason: form.reason,
                },
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

function openActivity(o) {
  modal('Log something', function (box, close) {
    // A call, an email or a text IS a conversation, so choosing one sets the
    // direction rather than leaving the operator to discover the refusal.
    const form = { kind: 'note', direction: '', subject: '', body: '' };
    const COMMUNICATIONS = ['call', 'email', 'sms'];
    box.appendChild(
      el('p', {
        class: 'muted',
        text: 'This records what HAPPENED. Something still owed is a task, above.',
      }),
    );
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
              const dir = document.getElementById('sales-activity-direction');
              if (dir) {
                dir.value = form.direction;
                dir.disabled = !isTalk;
              }
            },
          },
          ['note', 'call', 'email', 'sms'].map(function (k) {
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
          'What was SAID, not what was offered. The figures belong to appraisal and ' +
          'desking (FBL-120), and there is deliberately nowhere to type one here.',
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
    const form = { reason: 'second_voice', note: '' };
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
    picker(box, {
      label: 'Which manager',
      path: '/api/sales/find/staff?role=manager&location_id=' + (salesState.rooftopId || ''),
      collection: 'staff',
      empty: 'No manager works this showroom.',
      render: function (s) {
        return salesStaff(s.userLinkId);
      },
      onPick: async function (s) {
        try {
          await api('POST', '/api/sales/opportunities/' + o.opportunityId + '/turnover', {
            manager_user_link_id: s.userLinkId,
            reason: form.reason,
            note: form.note || null,
          });
          close();
          toast('A manager has been brought in');
          renderApp();
        } catch (err) {
          reportError(err);
        }
      },
    });
    box.appendChild(el('button', { class: 'ghost', text: 'Cancel', onclick: close }));
  });
}

// ── registration ────────────────────────────────────────────────────────────

ROUTES.showroom = { title: 'Showroom', render: renderShowroom };
ROUTES.deals = { title: 'Deals', render: renderSalesPipeline };

// Reached from a row on the pipeline or the showroom, so it routes without
// taking a tab of its own.
ROUTES.opportunity = { title: 'Opportunity', render: renderOpportunity, hidden: true };
