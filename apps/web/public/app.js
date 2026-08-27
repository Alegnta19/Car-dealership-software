/**
 * RT1 — the dealership administration console. Dependency-free vanilla JS,
 * served same-origin by the API so the session cookie + CSRF model apply.
 *
 * Conventions:
 *  - every unsafe request carries x-csrf-token (from GET /auth/session);
 *  - creating commands carry a generated Idempotency-Key;
 *  - errors arrive as application/problem+json and surface with their stable
 *    code and correlation id;
 *  - sensitive commands (role grant/revoke, deactivation) first obtain a
 *    single-use step-up grant through /auth/reauth and send it as
 *    step_up_token in the body.
 */
'use strict';

const state = {
  session: null,
  csrf: null,
  overview: null,
};

// ── fetch wrapper ───────────────────────────────────────────────────────────

async function api(method, path, body, opts) {
  opts = opts || {};
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && state.csrf) headers['x-csrf-token'] = state.csrf;
  if (opts.idempotent) headers['idempotency-key'] = crypto.randomUUID();
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!res.ok) {
    const problem = payload || {};
    const err = new Error(problem.detail || problem.title || 'Request failed (' + res.status + ')');
    err.status = res.status;
    err.code = problem.code || 'error';
    err.correlationId = problem.correlationId || problem.requestId || null;
    err.errors = problem.errors || null;
    throw err;
  }
  return payload;
}

async function loadSession() {
  const res = await fetch('/auth/session', {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    state.session = null;
    state.csrf = null;
    return null;
  }
  state.csrf = res.headers.get('x-csrf-token');
  const payload = await res.json();
  state.session = payload.data;
  return state.session;
}

// ── step-up (reauthentication) ──────────────────────────────────────────────

/**
 * Obtains a single-use grant for one sensitive catalog action. Opens the
 * provider round trip in a popup; the callback lands same-origin bearing the
 * grant JSON, which is read from the popup and returned.
 */
function stepUp(action) {
  return api('POST', '/auth/reauth/start', { action }).then(function (started) {
    const url = started.data.authorization_url;
    return new Promise(function (resolve, reject) {
      const win = window.open(url, 'dealer_stepup', 'width=480,height=680');
      if (!win) {
        reject(new Error('The re-authentication popup was blocked — allow popups and retry.'));
        return;
      }
      const timer = setInterval(function () {
        let done = false;
        try {
          if (win.closed) {
            clearInterval(timer);
            reject(new Error('Re-authentication was cancelled.'));
            return;
          }
          // Throws while the popup is on the provider's origin; once it lands
          // back on ours the callback JSON is readable.
          if (win.location.pathname.indexOf('/auth/reauth/callback') === 0) {
            const text = win.document.body ? win.document.body.textContent : '';
            if (text) {
              const parsed = JSON.parse(text);
              if (parsed && parsed.data && parsed.data.grant) {
                done = true;
                resolve(parsed.data.grant);
              } else {
                done = true;
                reject(new Error('Re-authentication failed.'));
              }
            }
          }
        } catch (e) {
          if (e instanceof SyntaxError) {
            done = true;
            reject(new Error('Re-authentication failed.'));
          }
          // otherwise: still cross-origin — keep polling
        }
        if (done) {
          clearInterval(timer);
          try {
            win.close();
          } catch {
            /* already closed */
          }
        }
      }, 250);
    });
  });
}

// ── tiny DOM helpers ────────────────────────────────────────────────────────

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.indexOf('on') === 0 && typeof v === 'function')
        node.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null) node.setAttribute(k, v);
    }
  }
  (children || []).forEach(function (c) {
    if (c === null || c === undefined) return;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
}

function toast(message, isError, correlationId) {
  const box = document.getElementById('toasts');
  const t = el('div', { class: 'toast' + (isError ? ' err' : '') }, [
    message,
    correlationId ? el('span', { class: 'corr', text: 'correlation: ' + correlationId }) : null,
  ]);
  box.appendChild(t);
  setTimeout(
    function () {
      t.remove();
    },
    isError ? 9000 : 4000,
  );
}

function reportError(err) {
  toast((err.code ? '[' + err.code + '] ' : '') + err.message, true, err.correlationId || null);
}

function badge(status) {
  return el('span', { class: 'badge ' + status, text: status.replace(/_/g, ' ') });
}

function modal(title, buildBody) {
  const back = el('div', { class: 'modal-back' });
  const box = el('div', { class: 'modal' }, [el('h3', { text: title })]);
  back.appendChild(box);
  back.addEventListener('click', function (e) {
    if (e.target === back) back.remove();
  });
  document.body.appendChild(back);
  buildBody(box, function close() {
    back.remove();
  });
}

// ── views ───────────────────────────────────────────────────────────────────

const ROUTES = {
  overview: { title: 'Overview', render: renderOverview },
  settings: { title: 'Dealership settings', render: renderSettings },
  hours: { title: 'Business hours', render: renderHours },
  policies: { title: 'Policies', render: renderPolicies },
  organization: { title: 'Organization', render: renderOrganization },
  users: { title: 'Users & access', render: renderUsers },
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function currentRoute() {
  const key = (location.hash || '#/overview').replace(/^#\//, '').split('/')[0];
  return ROUTES[key] ? key : 'overview';
}

async function renderApp() {
  const app = document.getElementById('app');
  app.textContent = '';
  if (!state.session) {
    app.appendChild(
      el('div', { class: 'center-card' }, [
        el('div', { class: 'panel' }, [
          el('h1', { text: 'Dealership Administration' }),
          el('p', { class: 'muted', text: 'Sign in with your dealership account to continue.' }),
          el('button', {
            text: 'Sign in',
            onclick: function () {
              location.href = '/auth/login?return_to=' + encodeURIComponent('/admin/');
            },
          }),
        ]),
      ]),
    );
    return;
  }
  const route = currentRoute();
  const overview = state.overview;
  const shell = el('div', { class: 'shell' }, [
    el('aside', { class: 'sidebar' }, [
      el('div', { class: 'mast' }, [
        el('div', {
          class: 'name',
          text:
            (overview && overview.settings && overview.settings.displayName) ||
            (overview && overview.tenant && overview.tenant.name) ||
            'Dealership',
        }),
        el('div', { class: 'sub', text: 'Administration' }),
      ]),
      el(
        'nav',
        null,
        Object.keys(ROUTES).map(function (key) {
          return el('a', {
            href: '#/' + key,
            class: key === route ? 'active' : '',
            text: ROUTES[key].title,
          });
        }),
      ),
      el('div', { class: 'foot' }, [
        el('div', { text: 'Roles: ' + (state.session.roles || []).join(', ') }),
        el('button', {
          class: 'ghost small',
          text: 'Sign out',
          onclick: function () {
            api('POST', '/auth/logout')
              .catch(function () {})
              .then(function () {
                state.session = null;
                renderApp();
              });
          },
        }),
      ]),
    ]),
    el('main', { class: 'main', id: 'view' }, [el('h1', { text: ROUTES[route].title })]),
  ]);
  app.appendChild(shell);
  const view = document.getElementById('view');
  try {
    await ROUTES[route].render(view);
  } catch (err) {
    if (err.status === 403) {
      view.appendChild(
        el('div', {
          class: 'error-banner',
          text: 'You do not have access to dealership administration.',
        }),
      );
    } else {
      reportError(err);
    }
  }
}

// ── overview ── //

async function renderOverview(view) {
  const data = await api('GET', '/api/admin/overview');
  state.overview = data;
  const counts = data.counts;
  view.appendChild(
    el('div', { class: 'cards' }, [
      statCard(counts.rooftops, 'Rooftops'),
      statCard(counts.departments, 'Departments'),
      statCard(counts.activeUsers, 'Active users'),
      statCard(counts.pendingUsers, 'Pending users'),
      statCard(data.invitations.length, 'Open invitations'),
    ]),
  );
  const s = data.settings;
  view.appendChild(
    el('div', { class: 'panel' }, [
      el('h2', { text: 'Dealership' }),
      s
        ? el('table', null, [
            kvRow('Display name', s.displayName),
            kvRow('Legal name', s.legalName || '—'),
            kvRow('Timezone', s.timezone),
            kvRow('Locale', s.locale || '—'),
          ])
        : el('p', { class: 'muted' }, [
            'Settings are not configured yet — ',
            el('a', { href: '#/settings', text: 'set them up' }),
            '.',
          ]),
    ]),
  );
  if (s && s.brandPrimaryColor) applyBrand(s.brandPrimaryColor);
}

function statCard(num, label) {
  return el('div', { class: 'card' }, [
    el('div', { class: 'num', text: String(num) }),
    el('div', { class: 'lbl', text: label }),
  ]);
}

function kvRow(key, value) {
  return el('tr', null, [el('th', { text: key }), el('td', { text: String(value) })]);
}

function applyBrand(color) {
  if (/^#[0-9a-fA-F]{6}$/.test(color)) {
    document.documentElement.style.setProperty('--brand', color);
  }
}

// ── settings ── //

async function renderSettings(view) {
  const data = await api('GET', '/api/admin/settings');
  const s = data.settings;
  const form = {
    display_name: s ? s.displayName : '',
    legal_name: s ? s.legalName || '' : '',
    brand_primary_color: s ? s.brandPrimaryColor || '#1f3a5f' : '#1f3a5f',
    logo_url: s ? s.logoUrl || '' : '',
    timezone: s ? s.timezone : 'America/New_York',
    locale: s ? s.locale || '' : '',
  };
  const version = s ? s.authorizationVersion : null;
  const panel = el('div', { class: 'panel' });
  const input = function (name, label, type, placeholder) {
    const field = el('input', {
      type: type || 'text',
      value: form[name],
      placeholder: placeholder || '',
      oninput: function (e) {
        form[name] = e.target.value;
      },
    });
    panel.appendChild(el('label', { text: label }));
    panel.appendChild(field);
    return field;
  };
  input('display_name', 'Display name');
  input('legal_name', 'Legal name');
  panel.appendChild(el('label', { text: 'Brand primary color' }));
  panel.appendChild(
    el('input', {
      type: 'color',
      value: /^#[0-9a-fA-F]{6}$/.test(form.brand_primary_color)
        ? form.brand_primary_color
        : '#1f3a5f',
      oninput: function (e) {
        form.brand_primary_color = e.target.value;
      },
    }),
  );
  input('logo_url', 'Logo URL', 'text', 'https://… or /path');
  input('timezone', 'Timezone (IANA)', 'text', 'America/New_York');
  input('locale', 'Locale', 'text', 'en-US');
  panel.appendChild(
    el('div', { class: 'actions' }, [
      el('button', {
        text: s ? 'Save changes' : 'Create settings',
        onclick: async function () {
          try {
            const body = {
              display_name: form.display_name,
              legal_name: form.legal_name || null,
              brand_primary_color: form.brand_primary_color || null,
              logo_url: form.logo_url || null,
              timezone: form.timezone || 'UTC',
              locale: form.locale || null,
              expected_version: version,
            };
            const saved = await api('PUT', '/api/admin/settings', body);
            applyBrand(saved.settings.brandPrimaryColor || '');
            toast('Settings saved.');
            renderApp();
          } catch (err) {
            if (err.code === 'version_conflict') {
              toast('Someone else changed settings — reloading their version.', true);
              renderApp();
            } else {
              reportError(err);
            }
          }
        },
      }),
    ]),
  );
  view.appendChild(panel);
}

// ── business hours ── //

async function renderHours(view) {
  const data = await api('GET', '/api/admin/business-hours');
  const byDay = {};
  (data.businessHours || []).forEach(function (d) {
    byDay[d.dayOfWeek] = d;
  });
  const days = [];
  for (let i = 0; i < 7; i++) {
    const existing = byDay[i];
    days.push(
      existing
        ? {
            day_of_week: i,
            closed: existing.closed,
            open_time: existing.openTime,
            close_time: existing.closeTime,
          }
        : {
            day_of_week: i,
            closed: i === 0,
            open_time: i === 0 ? null : '09:00',
            close_time: i === 0 ? null : '18:00',
          },
    );
  }
  const panel = el('div', { class: 'panel' });
  const table = el('table');
  table.appendChild(
    el('tr', null, [
      el('th', { text: 'Day' }),
      el('th', { text: 'Closed' }),
      el('th', { text: 'Opens' }),
      el('th', { text: 'Closes' }),
    ]),
  );
  days.forEach(function (d) {
    const openInput = el('input', {
      type: 'time',
      value: d.open_time || '',
      oninput: function (e) {
        d.open_time = e.target.value || null;
      },
    });
    const closeInput = el('input', {
      type: 'time',
      value: d.close_time || '',
      oninput: function (e) {
        d.close_time = e.target.value || null;
      },
    });
    const sync = function () {
      openInput.disabled = d.closed;
      closeInput.disabled = d.closed;
    };
    sync();
    table.appendChild(
      el('tr', null, [
        el('td', { text: DAY_NAMES[d.day_of_week] }),
        el('td', null, [
          el('input', {
            type: 'checkbox',
            checked: d.closed ? 'checked' : undefined,
            onchange: function (e) {
              d.closed = e.target.checked;
              if (d.closed) {
                d.open_time = null;
                d.close_time = null;
                openInput.value = '';
                closeInput.value = '';
              } else {
                d.open_time = d.open_time || '09:00';
                d.close_time = d.close_time || '18:00';
                openInput.value = d.open_time;
                closeInput.value = d.close_time;
              }
              sync();
            },
          }),
        ]),
        el('td', null, [openInput]),
        el('td', null, [closeInput]),
      ]),
    );
  });
  panel.appendChild(table);
  panel.appendChild(
    el('div', { class: 'actions' }, [
      el('button', {
        text: 'Save weekly hours',
        onclick: async function () {
          try {
            await api('PUT', '/api/admin/business-hours', { days: days });
            toast('Business hours saved.');
            renderApp();
          } catch (err) {
            reportError(err);
          }
        },
      }),
    ]),
  );
  view.appendChild(panel);
}

// ── policies ── //

async function renderPolicies(view) {
  const data = await api('GET', '/api/admin/policies');
  const values = {};
  (data.policies || []).forEach(function (p) {
    values[p.policyKey] = p.policyValue;
  });
  const panel = el('div', { class: 'panel' });
  (data.catalog || []).forEach(function (entry) {
    const key = entry.key;
    const current = values[key];
    panel.appendChild(el('label', { text: key + ' — ' + entry.description }));
    let field;
    if (typeof current === 'boolean' || key.indexOf('walk_ins') !== -1) {
      field = el('select', null, [
        el('option', { value: 'true', text: 'yes' }),
        el('option', { value: 'false', text: 'no' }),
      ]);
      field.value = current === true ? 'true' : 'false';
    } else {
      field = el('input', {
        type: 'text',
        value: current === undefined || current === null ? '' : String(current),
      });
    }
    const saveBtn = el('button', {
      class: 'small',
      text: 'Save',
      onclick: async function () {
        let value;
        if (field.tagName === 'SELECT') value = field.value === 'true';
        else if (/^-?\d+$/.test(field.value.trim())) value = parseInt(field.value.trim(), 10);
        else value = field.value;
        try {
          await api('PUT', '/api/admin/policies/' + encodeURIComponent(key), { value: value });
          toast(key + ' saved.');
        } catch (err) {
          reportError(err);
        }
      },
    });
    panel.appendChild(
      el('div', { class: 'row' }, [el('div', null, [field]), el('div', null, [saveBtn])]),
    );
  });
  view.appendChild(panel);
}

// ── organization ── //

async function renderOrganization(view) {
  const data = await api('GET', '/api/admin/organization');
  const panel = el('div', { class: 'panel tree' });

  const statusButton = function (level, unitId, status) {
    const next = status === 'active' ? 'inactive' : 'active';
    return el('button', {
      class: 'ghost small',
      text: next === 'active' ? 'Activate' : 'Deactivate',
      onclick: async function () {
        try {
          await api('PATCH', '/api/admin/organization/' + level + '/' + unitId + '/status', {
            status: next,
          });
          toast('Status updated.');
          renderApp();
        } catch (err) {
          reportError(err);
        }
      },
    });
  };

  const addButton = function (level, parentId, label) {
    return el('button', {
      class: 'ghost small',
      text: '+ ' + label,
      onclick: function () {
        modal('New ' + label, function (box, close) {
          const form = { name: '', code: '' };
          box.appendChild(el('label', { text: 'Name' }));
          box.appendChild(
            el('input', {
              oninput: function (e) {
                form.name = e.target.value;
              },
            }),
          );
          if (level === 'department') {
            box.appendChild(el('label', { text: 'Code (e.g. service, parts)' }));
            box.appendChild(
              el('input', {
                oninput: function (e) {
                  form.code = e.target.value;
                },
              }),
            );
          }
          box.appendChild(
            el('div', { class: 'actions' }, [
              el('button', {
                text: 'Create',
                onclick: async function () {
                  try {
                    const body = { name: form.name };
                    if (parentId) body.parent_id = parentId;
                    if (level === 'department') body.code = form.code;
                    await api('POST', '/api/admin/organization/' + level, body, {
                      idempotent: true,
                    });
                    close();
                    toast(label + ' created.');
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
      },
    });
  };

  const node = function (levelLabel, name, status, controls) {
    return el(
      'div',
      { class: 'node' },
      [
        el('span', { class: 'lvl', text: levelLabel }),
        el('strong', { text: name }),
        badge(status),
      ].concat(controls),
    );
  };

  const groupsUl = el('ul');
  data.dealerGroups.forEach(function (g) {
    const li = el('li', null, [
      node('group', g.name, g.status, [
        statusButton('dealer_group', g.dealer_group_id, g.status),
        addButton('legal_entity', g.dealer_group_id, 'Legal entity'),
      ]),
    ]);
    const entitiesUl = el('ul');
    data.legalEntities
      .filter(function (le) {
        return le.dealer_group_id === g.dealer_group_id;
      })
      .forEach(function (le) {
        const leLi = el('li', null, [
          node('entity', le.name, le.status, [
            statusButton('legal_entity', le.legal_entity_id, le.status),
            addButton('rooftop', le.legal_entity_id, 'Rooftop'),
          ]),
        ]);
        const rooftopsUl = el('ul');
        data.rooftops
          .filter(function (r) {
            return r.legal_entity_id === le.legal_entity_id;
          })
          .forEach(function (r) {
            const rLi = el('li', null, [
              node('rooftop', r.name, r.status, [
                statusButton('rooftop', r.rooftop_id, r.status),
                addButton('department', r.rooftop_id, 'Department'),
              ]),
            ]);
            const depsUl = el('ul');
            data.departments
              .filter(function (d) {
                return d.rooftop_id === r.rooftop_id;
              })
              .forEach(function (d) {
                depsUl.appendChild(
                  el('li', null, [
                    node('dept ' + (d.code || ''), d.name, d.status, [
                      statusButton('department', d.department_id, d.status),
                    ]),
                  ]),
                );
              });
            if (depsUl.children.length) rLi.appendChild(depsUl);
            rooftopsUl.appendChild(rLi);
          });
        if (rooftopsUl.children.length) leLi.appendChild(rooftopsUl);
        entitiesUl.appendChild(leLi);
      });
    if (entitiesUl.children.length) li.appendChild(entitiesUl);
    groupsUl.appendChild(li);
  });
  panel.appendChild(groupsUl);
  panel.appendChild(
    el('div', { class: 'actions' }, [addButton('dealer_group', null, 'Dealer group')]),
  );
  view.appendChild(panel);
}

// ── users & access ── //

async function renderUsers(view) {
  const data = await api('GET', '/api/admin/users');
  const overview = state.overview || (await api('GET', '/api/admin/overview'));
  state.overview = overview;
  const roles = overview.invitableRoles || [];

  const usersPanel = el('div', { class: 'panel' });
  const table = el('table');
  table.appendChild(
    el('tr', null, [
      el('th', { text: 'User' }),
      el('th', { text: 'Status' }),
      el('th', { text: 'Roles' }),
      el('th', { text: '' }),
    ]),
  );
  data.users.forEach(function (u) {
    const bindings = el(
      'div',
      null,
      (u.bindings || []).map(function (b) {
        return el('div', null, [
          el('code', { text: b.role }),
          ' @ ' + b.scopeLevel + ' ',
          el('button', {
            class: 'ghost small',
            text: 'Revoke',
            onclick: function () {
              sensitiveCommand(
                'identity.role.revoke',
                'DELETE',
                '/api/admin/users/' + u.userLinkId + '/roles/' + b.roleBindingId,
                {},
                'Role revoked.',
              );
            },
          }),
        ]);
      }),
    );
    table.appendChild(
      el('tr', null, [
        el('td', null, [
          el('div', null, [el('strong', { text: u.displayName || u.email || u.userLinkId })]),
          el('div', { class: 'muted', text: u.email || '' }),
        ]),
        el('td', null, [badge(u.status)]),
        el('td', null, [bindings]),
        el('td', null, [
          el('button', {
            class: 'ghost small',
            text: 'Grant role',
            onclick: function () {
              grantRoleModal(u, roles, overview);
            },
          }),
          ' ',
          u.status !== 'deactivated'
            ? el('button', {
                class: 'danger small',
                text: 'Deactivate',
                onclick: function () {
                  if (!window.confirm('Deactivate this user? Their sessions end immediately.'))
                    return;
                  sensitiveCommand(
                    'identity.user.deactivate',
                    'POST',
                    '/api/admin/users/' + u.userLinkId + '/deactivate',
                    {},
                    'User deactivated.',
                  );
                },
              })
            : null,
        ]),
      ]),
    );
  });
  usersPanel.appendChild(table);
  usersPanel.appendChild(
    el('div', { class: 'actions' }, [
      el('button', {
        text: 'Invite staff member',
        onclick: function () {
          inviteModal(roles, overview);
        },
      }),
    ]),
  );
  view.appendChild(usersPanel);

  const invitations = data.invitations || [];
  if (invitations.length) {
    const invPanel = el('div', { class: 'panel' }, [el('h2', { text: 'Invitations' })]);
    const invTable = el('table');
    invTable.appendChild(
      el('tr', null, [
        el('th', { text: 'Email' }),
        el('th', { text: 'Role' }),
        el('th', { text: 'Scope' }),
        el('th', { text: 'Status' }),
        el('th', { text: '' }),
      ]),
    );
    invitations.forEach(function (i) {
      invTable.appendChild(
        el('tr', null, [
          el('td', { text: i.email }),
          el('td', null, [el('code', { text: i.invitedRole })]),
          el('td', { text: i.scopeLevel }),
          el('td', null, [badge(i.status)]),
          el('td', null, [
            i.status === 'pending'
              ? el('button', {
                  class: 'ghost small',
                  text: 'Revoke',
                  onclick: async function () {
                    try {
                      await api('POST', '/api/admin/invitations/' + i.invitationId + '/revoke', {});
                      toast('Invitation revoked.');
                      renderApp();
                    } catch (err) {
                      reportError(err);
                    }
                  },
                })
              : null,
          ]),
        ]),
      );
    });
    invPanel.appendChild(invTable);
    view.appendChild(invPanel);
  }
}

/** Runs one sensitive command: step-up first, then the request with the grant. */
async function sensitiveCommand(action, method, path, body, successMessage) {
  try {
    const grant = await stepUp(action);
    const withGrant = Object.assign({}, body, { step_up_token: grant });
    await api(method, path, withGrant, { idempotent: true });
    toast(successMessage);
    renderApp();
  } catch (err) {
    reportError(err);
  }
}

function scopePicker(overview, onChange) {
  const wrap = el('div');
  const levelSel = el('select', null, [
    el('option', { value: 'tenant', text: 'Whole dealership' }),
    el('option', { value: 'rooftop', text: 'One rooftop' }),
    el('option', { value: 'department', text: 'One department' }),
  ]);
  const idSel = el('select');
  const rebuild = async function () {
    idSel.textContent = '';
    if (levelSel.value === 'tenant') {
      idSel.style.display = 'none';
      onChange('tenant', null);
      return;
    }
    idSel.style.display = '';
    const org = await api('GET', '/api/admin/organization');
    const options =
      levelSel.value === 'rooftop'
        ? org.rooftops.map(function (r) {
            return { id: r.rooftop_id, name: r.name };
          })
        : org.departments.map(function (d) {
            return { id: d.department_id, name: d.name + ' (' + (d.code || '') + ')' };
          });
    options.forEach(function (o) {
      idSel.appendChild(el('option', { value: o.id, text: o.name }));
    });
    onChange(levelSel.value, idSel.value || null);
  };
  levelSel.addEventListener('change', function () {
    rebuild().catch(reportError);
  });
  idSel.addEventListener('change', function () {
    onChange(levelSel.value, idSel.value || null);
  });
  wrap.appendChild(el('label', { text: 'Access scope' }));
  wrap.appendChild(levelSel);
  wrap.appendChild(idSel);
  idSel.style.display = 'none';
  return wrap;
}

function inviteModal(roles, overview) {
  modal('Invite staff member', function (box, close) {
    const form = {
      email: '',
      display_name: '',
      role: roles[0] || '',
      scope_level: 'tenant',
      scope_id: null,
    };
    box.appendChild(el('label', { text: 'Email' }));
    box.appendChild(
      el('input', {
        type: 'email',
        oninput: function (e) {
          form.email = e.target.value;
        },
      }),
    );
    box.appendChild(el('label', { text: 'Display name (optional)' }));
    box.appendChild(
      el('input', {
        oninput: function (e) {
          form.display_name = e.target.value;
        },
      }),
    );
    box.appendChild(el('label', { text: 'Starting role' }));
    const roleSel = el(
      'select',
      null,
      roles.map(function (r) {
        return el('option', { value: r, text: r });
      }),
    );
    roleSel.addEventListener('change', function () {
      form.role = roleSel.value;
    });
    box.appendChild(roleSel);
    box.appendChild(
      scopePicker(overview, function (level, id) {
        form.scope_level = level;
        form.scope_id = id;
      }),
    );
    box.appendChild(
      el('div', { class: 'actions' }, [
        el('button', {
          text: 'Send invitation',
          onclick: async function () {
            try {
              await api(
                'POST',
                '/api/admin/users/invite',
                {
                  email: form.email,
                  display_name: form.display_name || null,
                  role: form.role,
                  scope_level: form.scope_level,
                  scope_id: form.scope_id,
                },
                { idempotent: true },
              );
              close();
              toast('Invitation created — the email is on its way.');
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

function grantRoleModal(user, roles, overview) {
  modal('Grant role', function (box, close) {
    const form = { role: roles[0] || '', scope_level: 'tenant', scope_id: null };
    box.appendChild(
      el('p', {
        class: 'muted',
        text: 'Granting to ' + (user.displayName || user.email || user.userLinkId),
      }),
    );
    box.appendChild(el('label', { text: 'Role' }));
    const roleSel = el(
      'select',
      null,
      roles.map(function (r) {
        return el('option', { value: r, text: r });
      }),
    );
    roleSel.addEventListener('change', function () {
      form.role = roleSel.value;
    });
    box.appendChild(roleSel);
    box.appendChild(
      scopePicker(overview, function (level, id) {
        form.scope_level = level;
        form.scope_id = id;
      }),
    );
    box.appendChild(
      el('div', { class: 'actions' }, [
        el('button', {
          text: 'Grant (re-authentication required)',
          onclick: function () {
            close();
            sensitiveCommand(
              'identity.role.grant',
              'POST',
              '/api/admin/users/' + user.userLinkId + '/roles',
              { role: form.role, scope_level: form.scope_level, scope_id: form.scope_id },
              'Role granted.',
            );
          },
        }),
        el('button', { class: 'ghost', text: 'Cancel', onclick: close }),
      ]),
    );
  });
}

// ── boot ────────────────────────────────────────────────────────────────────

window.addEventListener('hashchange', function () {
  renderApp();
});

loadSession()
  .then(function () {
    return renderApp();
  })
  .catch(function (err) {
    reportError(err);
  });
