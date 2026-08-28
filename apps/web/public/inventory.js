/**
 * RT2 — the inventory screens of the staff console.
 *
 * Loaded after app.js, which owns the shell, the router and the fetch wrapper.
 * A classic script's top-level `const` is visible to the scripts that follow
 * it, so this file registers its screens by extending the same ROUTES map the
 * shell renders from — no bundler, no module system, no framework.
 */
'use strict';

/*
 * The shell (app.js) defines these at script scope and this file uses them.
 * Declaring them here is what tells the linter they are provided rather than
 * undefined — there is no module system to import them through.
 */
/* global ROUTES, api, el, modal, toast, reportError, badge, statCard, kvRow, renderApp */

// ── helpers ─────────────────────────────────────────────────────────────────

function money(cents) {
  if (cents === null || cents === undefined) return '—';
  return '$' + (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0 });
}

function vehicleName(row) {
  const parts = [row.modelYear, row.make, row.model, row.trimLevel].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : row.vin;
}

/** Reads the vocabulary the overview publishes, so the UI never hard-codes it. */
const vocab = {
  lifecycleStates: ['acquired', 'in_reconditioning', 'retail_ready', 'retired'],
  acquisitionSources: [
    'trade_in',
    'auction',
    'private_purchase',
    'fleet',
    'consignment',
    'transfer',
  ],
  priceTypes: ['retail', 'internet', 'wholesale', 'msrp'],
  holdTypes: ['sold_pending', 'inspection', 'manager', 'transport'],
  consentChannels: ['email', 'sms', 'phone', 'postal'],
};

// ── inventory list (the owner view) ─────────────────────────────────────────

async function renderInventory(view) {
  const overview = await api('GET', '/api/inventory/overview');
  Object.assign(vocab, overview.vocabulary || {});
  const inv = overview.inventory;

  view.appendChild(
    el('div', { class: 'cards' }, [
      statCard(inv.total, 'Vehicles in stock'),
      statCard(inv.countsByState.retail_ready || 0, 'Retail ready'),
      statCard(inv.countsByState.in_reconditioning || 0, 'In reconditioning'),
      statCard(inv.countsByState.acquired || 0, 'Just acquired'),
      statCard(overview.rooftops.length, 'Rooftops'),
    ]),
  );

  const panel = el('div', { class: 'panel' });
  const filters = el('div', { class: 'row' });
  const rooftopSel = el('select', null, [el('option', { value: '', text: 'All rooftops' })]);
  overview.rooftops.forEach(function (r) {
    rooftopSel.appendChild(el('option', { value: r.rooftopId, text: r.name }));
  });
  const stateSel = el('select', null, [el('option', { value: '', text: 'Any state' })]);
  vocab.lifecycleStates.forEach(function (s) {
    stateSel.appendChild(el('option', { value: s, text: s.replace(/_/g, ' ') }));
  });
  const search = el('input', { type: 'search', placeholder: 'stock number, VIN, make or model' });

  const tableHost = el('div');
  const load = async function () {
    tableHost.textContent = '';
    const params = [];
    if (rooftopSel.value) params.push('rooftop_id=' + encodeURIComponent(rooftopSel.value));
    if (stateSel.value) params.push('lifecycle_state=' + encodeURIComponent(stateSel.value));
    if (search.value.trim()) params.push('q=' + encodeURIComponent(search.value.trim()));
    const data = await api(
      'GET',
      '/api/inventory/stock' + (params.length ? '?' + params.join('&') : ''),
    );
    tableHost.appendChild(inventoryTable(data));
  };
  [rooftopSel, stateSel].forEach(function (c) {
    c.addEventListener('change', function () {
      load().catch(reportError);
    });
  });
  search.addEventListener('change', function () {
    load().catch(reportError);
  });

  filters.appendChild(el('div', null, [el('label', { text: 'Rooftop' }), rooftopSel]));
  filters.appendChild(el('div', null, [el('label', { text: 'State' }), stateSel]));
  filters.appendChild(el('div', null, [el('label', { text: 'Search' }), search]));
  filters.appendChild(
    el('div', null, [
      el('label', { text: ' ' }),
      el('button', {
        text: 'Acquire a vehicle',
        onclick: function () {
          acquireModal(overview.rooftops);
        },
      }),
    ]),
  );
  panel.appendChild(filters);
  panel.appendChild(tableHost);
  view.appendChild(panel);
  await load();
}

function inventoryTable(data) {
  if (!data.rows.length) {
    return el('p', { class: 'muted', text: 'No vehicles match. Acquire one to get started.' });
  }
  const table = el('table');
  table.appendChild(
    el('tr', null, [
      el('th', { text: 'Stock' }),
      el('th', { text: 'Vehicle' }),
      el('th', { text: 'Rooftop' }),
      el('th', { text: 'State' }),
      el('th', { text: 'Age' }),
      el('th', { text: 'Price' }),
      el('th', { text: 'Cost' }),
      el('th', { text: 'Listing' }),
    ]),
  );
  data.rows.forEach(function (r) {
    const flags = [];
    if (r.onHold) flags.push(el('span', { class: 'badge inactive', text: 'hold: ' + r.holdType }));
    if (r.transferPending) flags.push(el('span', { class: 'badge pending', text: 'transfer' }));
    table.appendChild(
      el('tr', null, [
        el('td', null, [
          el('a', {
            href: '#/vehicle/' + r.stockItemId,
            text: r.stockNumber,
          }),
        ]),
        el('td', null, [
          el('div', { text: vehicleName(r) }),
          el('div', { class: 'muted', text: r.vin }),
        ]),
        el('td', { text: r.rooftopName }),
        el('td', null, [badge(r.lifecycleState)].concat(flags)),
        el('td', {
          text:
            r.daysInInventory +
            'd' +
            (r.daysRetailReady !== null ? ' (' + r.daysRetailReady + 'd ready)' : ''),
        }),
        el('td', {
          text: money(r.internetPriceCents !== null ? r.internetPriceCents : r.retailPriceCents),
        }),
        el('td', { text: money(r.totalCostCents) }),
        el('td', null, [
          r.listingState ? badge(r.listingState) : el('span', { class: 'muted', text: '—' }),
        ]),
      ]),
    );
  });
  return table;
}

// ── acquisition ─────────────────────────────────────────────────────────────

function acquireModal(rooftops) {
  modal('Acquire a vehicle', function (box, close) {
    const form = {
      location_id: rooftops.length ? rooftops[0].rooftopId : '',
      vin: '',
      stock_number: '',
      acquisition_source: 'trade_in',
      acquired_on: new Date().toISOString().slice(0, 10),
      odometer: '',
      party_mode: 'existing',
      acquisition_party_id: '',
      new_party: { given_name: '', family_name: '', email: '', phone: '' },
    };

    const field = function (label, node) {
      box.appendChild(el('label', { text: label }));
      box.appendChild(node);
      return node;
    };

    const rooftopSel = el(
      'select',
      null,
      rooftops.map(function (r) {
        return el('option', { value: r.rooftopId, text: r.name });
      }),
    );
    rooftopSel.addEventListener('change', function () {
      form.location_id = rooftopSel.value;
    });
    field('Rooftop', rooftopSel);

    field(
      'VIN',
      el('input', {
        placeholder: '17 characters',
        oninput: function (e) {
          form.vin = e.target.value;
        },
      }),
    );
    field(
      'Stock number',
      el('input', {
        oninput: function (e) {
          form.stock_number = e.target.value;
        },
      }),
    );
    const sourceSel = el(
      'select',
      null,
      vocab.acquisitionSources.map(function (s) {
        return el('option', { value: s, text: s.replace(/_/g, ' ') });
      }),
    );
    sourceSel.addEventListener('change', function () {
      form.acquisition_source = sourceSel.value;
    });
    field('Source', sourceSel);
    field(
      'Acquired on',
      el('input', {
        type: 'date',
        value: form.acquired_on,
        oninput: function (e) {
          form.acquired_on = e.target.value;
        },
      }),
    );
    field(
      'Odometer',
      el('input', {
        type: 'number',
        oninput: function (e) {
          form.odometer = e.target.value;
        },
      }),
    );

    // ── the acquisition party ────────────────────────────────────────────
    box.appendChild(el('h4', { text: 'Acquired from' }));
    const modeSel = el('select', null, [
      el('option', { value: 'existing', text: 'An existing customer' }),
      el('option', { value: 'new', text: 'A new customer' }),
      el('option', { value: 'none', text: 'No counterparty (auction or fleet)' }),
    ]);
    const partyHost = el('div');
    const renderParty = function () {
      partyHost.textContent = '';
      form.party_mode = modeSel.value;
      if (modeSel.value === 'existing') {
        const found = el('div');
        const q = el('input', { type: 'search', placeholder: 'search customers' });
        q.addEventListener('change', function () {
          api('GET', '/api/inventory/parties?q=' + encodeURIComponent(q.value))
            .then(function (data) {
              found.textContent = '';
              data.parties.forEach(function (p) {
                found.appendChild(
                  el('div', null, [
                    el('button', {
                      class: 'ghost small',
                      text: p.displayName + (p.email ? ' · ' + p.email : ''),
                      onclick: function () {
                        form.acquisition_party_id = p.partyId;
                        found.textContent = '';
                        found.appendChild(
                          el('div', { class: 'muted', text: 'Selected ' + p.displayName }),
                        );
                      },
                    }),
                  ]),
                );
              });
              if (!data.parties.length) {
                found.appendChild(el('div', { class: 'muted', text: 'No match.' }));
              }
            })
            .catch(reportError);
        });
        partyHost.appendChild(el('label', { text: 'Find the customer' }));
        partyHost.appendChild(q);
        partyHost.appendChild(found);
      } else if (modeSel.value === 'new') {
        ['given_name', 'family_name', 'email', 'phone'].forEach(function (k) {
          partyHost.appendChild(el('label', { text: k.replace(/_/g, ' ') }));
          partyHost.appendChild(
            el('input', {
              oninput: function (e) {
                form.new_party[k] = e.target.value;
              },
            }),
          );
        });
      }
    };
    modeSel.addEventListener('change', renderParty);
    box.appendChild(modeSel);
    box.appendChild(partyHost);
    renderParty();

    box.appendChild(
      el('div', { class: 'actions' }, [
        el('button', {
          text: 'Acquire',
          onclick: async function () {
            const payload = {
              location_id: form.location_id || rooftopSel.value,
              vin: form.vin,
              stock_number: form.stock_number,
              acquisition_source: form.acquisition_source,
              acquired_on: form.acquired_on,
            };
            if (form.odometer) payload.odometer = Number(form.odometer);
            if (form.party_mode === 'existing' && form.acquisition_party_id) {
              payload.acquisition_party_id = form.acquisition_party_id;
            }
            if (form.party_mode === 'new') {
              payload.new_party = { party_type: 'person' };
              Object.keys(form.new_party).forEach(function (k) {
                if (form.new_party[k]) payload.new_party[k] = form.new_party[k];
              });
            }
            try {
              const created = await api('POST', '/api/inventory/stock', payload, {
                idempotent: true,
              });
              close();
              toast('Acquired ' + created.stockItem.stockNumber + '.');
              location.hash = '#/vehicle/' + created.stockItem.stockItemId;
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

// ── one vehicle ─────────────────────────────────────────────────────────────

async function renderVehicle(view) {
  const stockItemId = (location.hash.split('/')[2] || '').trim();
  if (!stockItemId) {
    view.appendChild(el('p', { class: 'muted', text: 'No vehicle selected.' }));
    return;
  }
  const d = await api('GET', '/api/inventory/stock/' + stockItemId);
  const s = d.stockItem;

  view.appendChild(
    el('div', { class: 'panel' }, [
      el('h2', { text: vehicleName(d.vehicle) + ' — ' + s.stockNumber }),
      el('table', null, [
        kvRow(
          'VIN',
          d.vehicle.vin + (d.vehicle.vinCheckDigitValid ? '' : '  (check digit does not match)'),
        ),
        kvRow('Rooftop', d.rooftopName),
        kvRow('State', s.lifecycleState.replace(/_/g, ' ')),
        kvRow('Acquired', s.acquiredOn + ' · ' + s.acquisitionSource.replace(/_/g, ' ')),
        kvRow('From', d.acquisitionPartyName || '—'),
        kvRow('Odometer', s.odometer === null ? '—' : s.odometer + ' ' + s.odometerUnit),
        kvRow('Title', s.titleStatus),
        kvRow('Days in inventory', String(d.daysInInventory)),
        kvRow('Total cost', money(d.totalCostCents)),
      ]),
      el('div', { class: 'actions' }, [
        el('button', {
          class: 'ghost',
          text: 'Decode VIN',
          onclick: async function () {
            try {
              const r = await api(
                'POST',
                '/api/inventory/vehicles/' + d.vehicle.vehicleId + '/decode',
              );
              toast(
                r.outcome === 'decoded' ? 'Decoded.' : 'Provider: ' + r.message,
                r.outcome !== 'decoded',
              );
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
        lifecycleButton(s, 'in_reconditioning', 'Send to reconditioning'),
        lifecycleButton(s, 'retail_ready', 'Mark retail ready'),
      ]),
    ]),
  );

  // pricing
  const priceHost = el('div', { class: 'panel' }, [el('h2', { text: 'Pricing' })]);
  const priceTable = el('table');
  priceTable.appendChild(
    el('tr', null, [
      el('th', { text: 'Type' }),
      el('th', { text: 'Amount' }),
      el('th', { text: 'From' }),
      el('th', { text: 'Status' }),
    ]),
  );
  d.prices.forEach(function (p) {
    priceTable.appendChild(
      el('tr', null, [
        el('td', { text: p.priceType }),
        el('td', { text: money(p.amountCents) }),
        el('td', { text: p.effectiveFrom.slice(0, 10) }),
        el('td', null, [
          p.supersededAt === null
            ? el('span', { class: 'badge active', text: 'current' })
            : el('span', { class: 'muted', text: 'superseded' }),
        ]),
      ]),
    );
  });
  priceHost.appendChild(priceTable);
  const priceType = el(
    'select',
    null,
    vocab.priceTypes.map(function (t) {
      return el('option', { value: t, text: t });
    }),
  );
  const amount = el('input', { type: 'number', placeholder: 'dollars' });
  priceHost.appendChild(
    el('div', { class: 'row' }, [
      el('div', null, [el('label', { text: 'Type' }), priceType]),
      el('div', null, [el('label', { text: 'Amount' }), amount]),
      el('div', null, [
        el('label', { text: ' ' }),
        el('button', {
          text: 'Set price',
          onclick: async function () {
            try {
              await api(
                'POST',
                '/api/inventory/stock/' + stockItemId + '/prices',
                {
                  price_type: priceType.value,
                  amount_cents: Math.round(Number(amount.value) * 100),
                },
                { idempotent: true },
              );
              toast('Price set.');
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
      ]),
    ]),
  );
  view.appendChild(priceHost);

  // photos + features
  const mediaHost = el('div', { class: 'panel' }, [el('h2', { text: 'Photos and features' })]);
  const gallery = el('div', { class: 'row' });
  d.media.forEach(function (m) {
    gallery.appendChild(
      el('div', null, [
        el('div', { class: 'muted', text: '#' + m.position + ' ' + (m.caption || '') }),
        el('button', {
          class: 'ghost small',
          text: 'Remove',
          onclick: async function () {
            try {
              await api('DELETE', '/api/inventory/stock/' + stockItemId + '/media/' + m.mediaId);
              toast('Photo removed.');
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
      ]),
    );
  });
  if (!d.media.length)
    gallery.appendChild(el('div', { class: 'muted', text: 'No photographs yet.' }));
  mediaHost.appendChild(gallery);
  const uri = el('input', { placeholder: 'https://…/photo.jpg' });
  mediaHost.appendChild(
    el('div', { class: 'row' }, [
      el('div', null, [el('label', { text: 'Photo URL' }), uri]),
      el('div', null, [
        el('label', { text: ' ' }),
        el('button', {
          text: 'Add photo',
          onclick: async function () {
            try {
              await api(
                'POST',
                '/api/inventory/stock/' + stockItemId + '/media',
                { uri: uri.value },
                { idempotent: true },
              );
              toast('Photo added.');
              renderApp();
            } catch (err) {
              reportError(err);
            }
          },
        }),
      ]),
    ]),
  );
  mediaHost.appendChild(
    el(
      'p',
      { class: 'muted' },
      d.features.length
        ? [
            d.features
              .map(function (f) {
                return f.label;
              })
              .join(' · '),
          ]
        : ['No features recorded.'],
    ),
  );
  view.appendChild(mediaHost);

  // costs and documents
  const opsHost = el('div', { class: 'panel' }, [el('h2', { text: 'Costs and paperwork' })]);
  const costTable = el('table');
  costTable.appendChild(
    el('tr', null, [
      el('th', { text: 'Type' }),
      el('th', { text: 'Amount' }),
      el('th', { text: 'Vendor' }),
      el('th', { text: 'Date' }),
      el('th', { text: 'Status' }),
    ]),
  );
  d.costs.forEach(function (c) {
    costTable.appendChild(
      el('tr', null, [
        el('td', { text: c.costType.replace(/_/g, ' ') }),
        el('td', { text: money(c.amountCents) }),
        el('td', { text: c.vendor || '—' }),
        el('td', { text: c.incurredOn }),
        el('td', null, [badge(c.status)]),
      ]),
    );
  });
  opsHost.appendChild(costTable);
  opsHost.appendChild(
    el('div', { class: 'actions' }, [
      el('button', {
        class: 'ghost',
        text: 'Record a cost',
        onclick: function () {
          costModal(stockItemId);
        },
      }),
      el('button', {
        class: 'ghost',
        text: 'Record paperwork',
        onclick: function () {
          documentModal(stockItemId);
        },
      }),
    ]),
  );
  if (d.documents.length) {
    const docs = el('table');
    docs.appendChild(
      el('tr', null, [el('th', { text: 'Document' }), el('th', { text: 'Status' })]),
    );
    d.documents.forEach(function (doc) {
      docs.appendChild(
        el('tr', null, [
          el('td', { text: doc.documentType.replace(/_/g, ' ') }),
          el('td', null, [badge(doc.status)]),
        ]),
      );
    });
    opsHost.appendChild(docs);
  }
  view.appendChild(opsHost);

  // holds, transfers, listings
  const marketHost = el('div', { class: 'panel' }, [
    el('h2', { text: 'Availability and listings' }),
  ]);
  const liveHold = d.holds.filter(function (h) {
    return h.releasedAt === null;
  })[0];
  marketHost.appendChild(
    el('div', { class: 'actions' }, [
      liveHold
        ? el('button', {
            class: 'ghost',
            text: 'Release hold (' + liveHold.holdType + ')',
            onclick: async function () {
              try {
                await api(
                  'POST',
                  '/api/inventory/stock/' + stockItemId + '/holds/' + liveHold.holdId + '/release',
                  { release_reason: 'released from the console' },
                );
                toast('Hold released.');
                renderApp();
              } catch (err) {
                reportError(err);
              }
            },
          })
        : el('button', {
            class: 'ghost',
            text: 'Place a hold',
            onclick: function () {
              holdModal(stockItemId);
            },
          }),
      el('button', {
        class: 'ghost',
        text: 'Transfer to another rooftop',
        onclick: function () {
          transferModal(stockItemId);
        },
      }),
      el('button', {
        text: 'Publish listing',
        onclick: function () {
          publishModal(stockItemId);
        },
      }),
    ]),
  );
  if (d.listings.length) {
    const lt = el('table');
    lt.appendChild(
      el('tr', null, [
        el('th', { text: 'Channel' }),
        el('th', { text: 'State' }),
        el('th', { text: 'Reference' }),
        el('th', { text: '' }),
      ]),
    );
    d.listings.forEach(function (l) {
      lt.appendChild(
        el('tr', null, [
          el('td', { text: l.channel }),
          el('td', null, [
            badge(l.state),
            l.lastError ? el('div', { class: 'muted', text: l.lastError }) : null,
          ]),
          el('td', { text: l.externalRef || '—' }),
          el('td', null, [
            el('button', {
              class: 'ghost small',
              text: 'Withdraw',
              onclick: async function () {
                try {
                  await api(
                    'POST',
                    '/api/inventory/listings/' + l.listingId + '/withdraw',
                    {},
                    { idempotent: true },
                  );
                  toast('Withdrawal requested.');
                  renderApp();
                } catch (err) {
                  reportError(err);
                }
              },
            }),
            ' ',
            el('button', {
              class: 'ghost small',
              text: 'Reconcile',
              onclick: async function () {
                try {
                  const r = await api(
                    'POST',
                    '/api/inventory/listings/' + l.listingId + '/reconcile',
                  );
                  toast(r.agreed ? 'Provider agrees.' : 'Corrected to ' + r.correctedTo, !r.agreed);
                  renderApp();
                } catch (err) {
                  reportError(err);
                }
              },
            }),
          ]),
        ]),
      );
    });
    marketHost.appendChild(lt);
  }
  view.appendChild(marketHost);
}

function lifecycleButton(stockItem, to, label) {
  if (stockItem.lifecycleState === to || stockItem.lifecycleState === 'retired') return null;
  return el('button', {
    class: 'ghost',
    text: label,
    onclick: async function () {
      try {
        await api(
          'POST',
          '/api/inventory/stock/' + stockItem.stockItemId + '/transition',
          { to: to },
          { idempotent: true },
        );
        toast('Moved to ' + to.replace(/_/g, ' ') + '.');
        renderApp();
      } catch (err) {
        reportError(err);
      }
    },
  });
}

function costModal(stockItemId) {
  modal('Record a cost', function (box, close) {
    const form = {
      cost_type: 'reconditioning',
      amount: '',
      vendor: '',
      incurred_on: new Date().toISOString().slice(0, 10),
      status: 'actual',
    };
    const typeSel = el(
      'select',
      null,
      ['purchase', 'transport', 'reconditioning', 'inspection', 'fee', 'other'].map(function (t) {
        return el('option', { value: t, text: t });
      }),
    );
    typeSel.value = form.cost_type;
    typeSel.addEventListener('change', function () {
      form.cost_type = typeSel.value;
    });
    box.appendChild(el('label', { text: 'Type' }));
    box.appendChild(typeSel);
    box.appendChild(el('label', { text: 'Amount (dollars)' }));
    box.appendChild(
      el('input', {
        type: 'number',
        oninput: function (e) {
          form.amount = e.target.value;
        },
      }),
    );
    box.appendChild(el('label', { text: 'Vendor' }));
    box.appendChild(
      el('input', {
        oninput: function (e) {
          form.vendor = e.target.value;
        },
      }),
    );
    box.appendChild(el('label', { text: 'Date' }));
    box.appendChild(
      el('input', {
        type: 'date',
        value: form.incurred_on,
        oninput: function (e) {
          form.incurred_on = e.target.value;
        },
      }),
    );
    box.appendChild(
      el('div', { class: 'actions' }, [
        el('button', {
          text: 'Record',
          onclick: async function () {
            try {
              await api('POST', '/api/inventory/stock/' + stockItemId + '/costs', {
                cost_type: form.cost_type,
                amount_cents: Math.round(Number(form.amount) * 100),
                vendor: form.vendor || null,
                incurred_on: form.incurred_on,
                status: form.status,
              });
              close();
              toast('Cost recorded.');
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

function documentModal(stockItemId) {
  modal('Record paperwork', function (box, close) {
    const form = {
      document_type: 'title',
      status: 'received',
      received_on: new Date().toISOString().slice(0, 10),
      reference: '',
    };
    const typeSel = el(
      'select',
      null,
      ['title', 'bill_of_sale', 'odometer_statement', 'inspection', 'lien_release', 'other'].map(
        function (t) {
          return el('option', { value: t, text: t.replace(/_/g, ' ') });
        },
      ),
    );
    typeSel.addEventListener('change', function () {
      form.document_type = typeSel.value;
    });
    const statusSel = el(
      'select',
      null,
      ['expected', 'received', 'sent', 'missing'].map(function (t) {
        return el('option', { value: t, text: t });
      }),
    );
    statusSel.value = 'received';
    statusSel.addEventListener('change', function () {
      form.status = statusSel.value;
    });
    box.appendChild(el('label', { text: 'Document' }));
    box.appendChild(typeSel);
    box.appendChild(el('label', { text: 'Status' }));
    box.appendChild(statusSel);
    box.appendChild(el('label', { text: 'Reference' }));
    box.appendChild(
      el('input', {
        oninput: function (e) {
          form.reference = e.target.value;
        },
      }),
    );
    box.appendChild(
      el('div', { class: 'actions' }, [
        el('button', {
          text: 'Record',
          onclick: async function () {
            try {
              const payload = {
                document_type: form.document_type,
                status: form.status,
                reference: form.reference || null,
              };
              if (form.status === 'received') payload.received_on = form.received_on;
              await api('POST', '/api/inventory/stock/' + stockItemId + '/documents', payload);
              close();
              toast('Paperwork recorded.');
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

function holdModal(stockItemId) {
  modal('Place a hold', function (box, close) {
    const form = { hold_type: 'manager', reason: '' };
    const typeSel = el(
      'select',
      null,
      vocab.holdTypes.map(function (t) {
        return el('option', { value: t, text: t.replace(/_/g, ' ') });
      }),
    );
    typeSel.addEventListener('change', function () {
      form.hold_type = typeSel.value;
    });
    box.appendChild(el('label', { text: 'Kind' }));
    box.appendChild(typeSel);
    box.appendChild(el('label', { text: 'Reason' }));
    box.appendChild(
      el('input', {
        oninput: function (e) {
          form.reason = e.target.value;
        },
      }),
    );
    box.appendChild(
      el('div', { class: 'actions' }, [
        el('button', {
          text: 'Place hold',
          onclick: async function () {
            try {
              await api(
                'POST',
                '/api/inventory/stock/' + stockItemId + '/holds',
                { hold_type: form.hold_type, reason: form.reason },
                { idempotent: true },
              );
              close();
              toast('Hold placed.');
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

function transferModal(stockItemId) {
  modal('Transfer to another rooftop', function (box, close) {
    api('GET', '/api/inventory/overview')
      .then(function (overview) {
        const sel = el(
          'select',
          null,
          overview.rooftops.map(function (r) {
            return el('option', { value: r.rooftopId, text: r.name });
          }),
        );
        box.appendChild(el('label', { text: 'Destination' }));
        box.appendChild(sel);
        box.appendChild(
          el('div', { class: 'actions' }, [
            el('button', {
              text: 'Request transfer',
              onclick: async function () {
                try {
                  await api(
                    'POST',
                    '/api/inventory/stock/' + stockItemId + '/transfers',
                    { to_rooftop_id: sel.value },
                    { idempotent: true },
                  );
                  close();
                  toast('Transfer requested.');
                  renderApp();
                } catch (err) {
                  reportError(err);
                }
              },
            }),
            el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
          ]),
        );
      })
      .catch(reportError);
  });
}

function publishModal(stockItemId) {
  modal('Publish listing', function (box, close) {
    const channel = el('input', { value: 'cars_com' });
    box.appendChild(el('label', { text: 'Channel' }));
    box.appendChild(channel);
    box.appendChild(
      el('p', {
        class: 'muted',
        text: 'The vehicle must be retail ready, priced, photographed and off hold.',
      }),
    );
    box.appendChild(
      el('div', { class: 'actions' }, [
        el('button', {
          text: 'Publish',
          onclick: async function () {
            try {
              await api(
                'POST',
                '/api/inventory/stock/' + stockItemId + '/listings',
                { channel: channel.value },
                { idempotent: true },
              );
              close();
              toast('Publication requested — the provider is being contacted.');
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

// ── customers ───────────────────────────────────────────────────────────────

async function renderCustomers(view) {
  const panel = el('div', { class: 'panel' });
  const host = el('div');
  const q = el('input', { type: 'search', placeholder: 'name, email or phone' });
  const load = async function () {
    host.textContent = '';
    const data = await api(
      'GET',
      '/api/inventory/parties' + (q.value.trim() ? '?q=' + encodeURIComponent(q.value.trim()) : ''),
    );
    if (!data.parties.length) {
      host.appendChild(el('p', { class: 'muted', text: 'No customers match.' }));
      return;
    }
    const table = el('table');
    table.appendChild(
      el('tr', null, [
        el('th', { text: 'Name' }),
        el('th', { text: 'Contact' }),
        el('th', { text: 'Status' }),
        el('th', { text: '' }),
      ]),
    );
    data.parties.forEach(function (p) {
      table.appendChild(
        el('tr', null, [
          el('td', { text: p.displayName }),
          el('td', null, [
            el('div', { text: p.email || '—' }),
            el('div', { class: 'muted', text: p.phone || '' }),
          ]),
          el('td', null, [badge(p.status)]),
          el('td', null, [
            el('button', {
              class: 'ghost small',
              text: 'Consent',
              onclick: function () {
                consentModal(p);
              },
            }),
          ]),
        ]),
      );
    });
    host.appendChild(table);
  };
  q.addEventListener('change', function () {
    load().catch(reportError);
  });
  panel.appendChild(el('label', { text: 'Search' }));
  panel.appendChild(q);
  panel.appendChild(host);
  panel.appendChild(
    el('div', { class: 'actions' }, [
      el('button', {
        text: 'Add a customer',
        onclick: function () {
          customerModal();
        },
      }),
    ]),
  );
  view.appendChild(panel);
  await load();
}

function customerModal() {
  modal('Add a customer', function (box, close) {
    const form = { given_name: '', family_name: '', email: '', phone: '' };
    ['given_name', 'family_name', 'email', 'phone'].forEach(function (k) {
      box.appendChild(el('label', { text: k.replace(/_/g, ' ') }));
      box.appendChild(
        el('input', {
          oninput: function (e) {
            form[k] = e.target.value;
          },
        }),
      );
    });
    const candidates = el('div');
    box.appendChild(candidates);
    box.appendChild(
      el('div', { class: 'actions' }, [
        el('button', {
          text: 'Create',
          onclick: async function () {
            const payload = { party_type: 'person' };
            Object.keys(form).forEach(function (k) {
              if (form[k]) payload[k] = form[k];
            });
            try {
              await api('POST', '/api/inventory/parties', payload, { idempotent: true });
              close();
              toast('Customer added.');
              renderApp();
            } catch (err) {
              // A DUPLICATE IS A CONVERSATION, NOT A FAILURE: the platform shows
              // who it matched and lets a human decide they are different people.
              if (err.status === 409) {
                candidates.textContent = '';
                candidates.appendChild(
                  el('div', {
                    class: 'error-banner',
                    text: 'This looks like an existing customer.',
                  }),
                );
                candidates.appendChild(
                  el('button', {
                    class: 'ghost small',
                    text: 'They are a different person — create anyway',
                    onclick: async function () {
                      try {
                        payload.allow_duplicate = true;
                        await api('POST', '/api/inventory/parties', payload, { idempotent: true });
                        close();
                        toast('Customer added.');
                        renderApp();
                      } catch (e2) {
                        reportError(e2);
                      }
                    },
                  }),
                );
              } else {
                reportError(err);
              }
            }
          },
        }),
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
      ]),
    );
  });
}

function consentModal(party) {
  modal('Contact consent — ' + party.displayName, function (box, close) {
    vocab.consentChannels.forEach(function (channel) {
      const sel = el('select', null, [
        el('option', { value: 'granted', text: 'granted' }),
        el('option', { value: 'withdrawn', text: 'withdrawn' }),
        el('option', { value: 'unknown', text: 'unknown' }),
      ]);
      box.appendChild(el('label', { text: channel }));
      box.appendChild(sel);
      box.appendChild(
        el('button', {
          class: 'ghost small',
          text: 'Record ' + channel,
          onclick: async function () {
            try {
              await api('PUT', '/api/inventory/parties/' + party.partyId + '/consents/' + channel, {
                state: sel.value,
                source: 'staff console',
              });
              toast(channel + ' consent recorded.');
            } catch (err) {
              reportError(err);
            }
          },
        }),
      );
    });
    box.appendChild(
      el('div', { class: 'actions' }, [
        el('button', { class: 'ghost', text: 'Close', onclick: close }),
      ]),
    );
  });
}

// ── registration ────────────────────────────────────────────────────────────

ROUTES.inventory = { title: 'Inventory', render: renderInventory };
ROUTES.customers = { title: 'Customers', render: renderCustomers };
// Reached from an inventory row rather than the navigation, so it is hidden
// from the sidebar by the shell's own filter.
ROUTES.vehicle = { title: 'Vehicle', render: renderVehicle, hidden: true };
