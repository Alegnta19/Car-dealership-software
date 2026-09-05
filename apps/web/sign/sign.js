/**
 * FBL-140 — THE CUSTOMER'S SIGNING PAGE.
 *
 * A separate page for a separate person. The customer is not a dealership
 * user: there is no sign-in, no session cookie and no role. The link the
 * dealership's provider delivered carries the one credential — a lane token in
 * the URL fragment, so it is never sent to the server as a path in access logs
 * and never leaves this origin as a referrer.
 *
 * FOUR STEPS, IN ORDER, AND THE PAGE SHOWS ONLY THE NEXT ONE: read, consent to
 * electronic records, review the documents, sign. The signature request sends
 * back the package hash this page displayed, so the person signs exactly what
 * they read.
 *
 * Dependency-free, like the staff console: no bundler, no framework.
 */
'use strict';

const app = document.getElementById('app');

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
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

function toast(message, isError) {
  const box = document.getElementById('toasts');
  const t = el('div', { class: 'toast' + (isError ? ' err' : ''), text: message });
  box.appendChild(t);
  setTimeout(
    function () {
      t.remove();
    },
    isError ? 9000 : 4000,
  );
}

async function api(method, path, body) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method: method,
    headers: headers,
    credentials: 'omit',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!res.ok) {
    const problem = (payload && payload.error) || payload || {};
    const err = new Error(
      problem.message || problem.detail || 'Request failed (' + res.status + ')',
    );
    err.code = problem.code || 'error';
    err.status = res.status;
    throw err;
  }
  return payload;
}

function tokenFromHash() {
  return (location.hash || '').replace(/^#\/?/, '').trim();
}

function dollars(centsText) {
  if (centsText === null || centsText === undefined || centsText === '') return '—';
  const negative = String(centsText).charAt(0) === '-';
  const digits = String(centsText).replace('-', '').padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (negative ? '-$' : '$') + whole + '.' + digits.slice(-2);
}

function fieldWords(f) {
  if (f.valueKind === 'money') return dollars(f.valueCents) + ' ' + (f.currency || '');
  if (f.valueKind === 'rate_ppm') return (Number(f.valueInteger) / 10000).toFixed(4) + '%';
  if (f.valueKind === 'integer') return String(f.valueInteger);
  return f.valueText === null ? '—' : String(f.valueText);
}

function renderProblem(message) {
  app.textContent = '';
  app.appendChild(
    el('div', { class: 'center-card' }, [
      el('div', { class: 'panel' }, [
        el('h1', { text: 'Review and sign' }),
        el('p', { class: 'muted', text: message }),
      ]),
    ]),
  );
}

async function render() {
  const token = tokenFromHash();
  if (!token) {
    renderProblem('Open the link the dealership sent you. There is nothing to type here.');
    return;
  }
  let session;
  try {
    session = await api('GET', '/sign/api/' + encodeURIComponent(token));
  } catch (err) {
    renderProblem(
      err.code === 'signing_link_expired'
        ? 'This signing link has expired. Ask the dealership for a new one.'
        : err.code === 'ceremony_closed'
          ? 'This signing ceremony is closed and takes no further action.'
          : 'This link is not one we recognise.',
    );
    return;
  }
  app.textContent = '';
  const main = el('main', { class: 'main' }, [
    el('h1', { text: 'Review and sign your documents' }),
  ]);
  app.appendChild(main);

  main.appendChild(
    el('div', { class: 'card' }, [
      el('p', null, [
        'Signing as ',
        el('strong', { text: session.signer.displayName }),
        ' (' + session.signer.role.replace(/_/g, ' ') + ')',
      ]),
      el('p', { class: 'muted' }, [
        'Package version ' +
          session.package.versionNo +
          ' · ' +
          session.package.documentCount +
          ' document(s) · package hash ',
        el('code', { text: session.package.packageSha256, id: 'package-hash' }),
      ]),
      session.package.carriesUnapprovedTemplates
        ? el('div', { class: 'error-banner' }, [
            'One or more documents in this package are rendered from UNAPPROVED SAMPLE templates that are not jurisdictionally approved forms. Each document says so on its face.',
          ])
        : null,
      el('p', {
        class: 'muted',
        text: 'Signing here records that you signed these documents. It is not a sale, a funded loan or a delivery.',
      }),
    ]),
  );

  const figures = session.fields.filter(function (f) {
    return f.fieldCode.indexOf('deal.') === 0 && f.valueKind === 'money';
  });
  if (figures.length > 0) {
    main.appendChild(
      el('div', { class: 'card' }, [
        el('h3', { text: 'The figures' }),
        el(
          'table',
          { class: 'table' },
          figures.map(function (f) {
            return el('tr', null, [
              el('th', { text: f.fieldCode.replace('deal.', '').replace(/_/g, ' ') }),
              el('td', { text: fieldWords(f) }),
            ]);
          }),
        ),
      ]),
    );
  }

  main.appendChild(
    el('div', { class: 'card' }, [
      el('h3', { text: 'The documents' }),
      el(
        'ul',
        null,
        session.documents.map(function (d) {
          return el('li', null, [
            el('a', {
              href: '/sign/api/' + encodeURIComponent(token) + '/documents/' + d.documentId,
              target: '_blank',
              rel: 'noopener',
              text: d.sequenceNo + '. ' + d.title,
            }),
            el('span', {
              class: 'muted',
              text:
                ' · ' +
                d.templateApprovalStatus.replace(/_/g, ' ') +
                ' · sha256 ' +
                d.contentSha256.slice(0, 12) +
                '…',
            }),
          ]);
        }),
      ),
    ]),
  );

  const steps = el('div', { class: 'card' }, [el('h3', { text: 'Your signature' })]);
  main.appendChild(steps);
  steps.appendChild(
    el(
      'ol',
      null,
      session.signers.map(function (s) {
        return el('li', {
          text:
            s.role.replace(/_/g, ' ') +
            ' — ' +
            s.state.replace(/_/g, ' ') +
            (s.signedAt ? ' at ' + new Date(s.signedAt).toLocaleString() : ''),
        });
      }),
    ),
  );

  if (session.nextStep === 'consent') {
    steps.appendChild(el('p', { text: session.consentText }));
    steps.appendChild(
      el('p', { class: 'muted', text: 'Consent text version ' + session.consentTextVersion }),
    );
    steps.appendChild(
      el('button', {
        class: 'primary',
        id: 'consent',
        text: 'I agree to electronic records',
        onclick: async function () {
          try {
            await api('POST', '/sign/api/' + encodeURIComponent(token) + '/consent', {
              consent_text_version: session.consentTextVersion,
            });
            toast('Consent recorded');
            render();
          } catch (err) {
            toast(err.message, true);
          }
        },
      }),
    );
  } else if (session.nextStep === 'sign') {
    steps.appendChild(
      el('p', {
        class: 'muted',
        text:
          'You consented to electronic records at ' +
          new Date(session.signer.consentedAt).toLocaleString() +
          '.',
      }),
    );
    steps.appendChild(el('p', { text: session.intentStatement }));
    steps.appendChild(
      el('button', {
        class: 'primary',
        id: 'sign',
        text: 'Sign',
        onclick: async function () {
          try {
            const out = await api('POST', '/sign/api/' + encodeURIComponent(token) + '/signature', {
              package_sha256: document.getElementById('package-hash').textContent,
              intent_statement: session.intentStatement,
            });
            toast(out.completed ? 'Signed — every signature is in' : 'Signed');
            render();
          } catch (err) {
            toast(err.message, true);
          }
        },
      }),
    );
    steps.appendChild(
      el('button', {
        class: 'ghost',
        id: 'decline',
        text: 'Decline to sign',
        onclick: async function () {
          const reason = window.prompt('Tell the dealership why you are declining:');
          if (!reason) return;
          try {
            await api('POST', '/sign/api/' + encodeURIComponent(token) + '/decline', {
              reason: reason,
            });
            toast('You declined to sign');
            render();
          } catch (err) {
            toast(err.message, true);
          }
        },
      }),
    );
  } else if (session.nextStep === 'wait_for_turn') {
    steps.appendChild(
      el('p', {
        class: 'muted',
        text: 'Another signer signs before you. Come back to this link when they have.',
      }),
    );
  } else if (session.nextStep === 'done') {
    steps.appendChild(
      el('p', null, [
        session.signer.state === 'signed'
          ? 'You signed at ' +
            new Date(session.signer.signedAt).toLocaleString() +
            '. Your signature: '
          : 'You declined to sign.',
        session.signer.signatureSha256
          ? el('code', { text: session.signer.signatureSha256 })
          : null,
      ]),
    );
    if (session.ceremony.completionCertificateSha256) {
      steps.appendChild(
        el('p', {
          class: 'muted',
          text:
            'Every signature is in. Completion certificate ' +
            session.ceremony.completionCertificateSha256,
        }),
      );
    }
  } else {
    steps.appendChild(
      el('p', {
        class: 'muted',
        text: 'This ceremony is ' + session.ceremony.state + ' and takes no further action.',
      }),
    );
  }
}

window.addEventListener('hashchange', render);
render();
