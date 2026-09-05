/**
 * FBL-140 — the deal jacket screens of the staff console.
 *
 * Loaded after desking.js, whose `dollars()` and `percent()` this file reuses,
 * and after sales.js for `picker()`, `salesAgo()` and `salesWhen()`: a classic
 * script's top-level function is visible to the scripts that follow it, so
 * there is no bundler, no module system and no framework here either.
 *
 * NOBODY TYPES AN IDENTIFIER. A jacket is opened from the list of approved
 * desk files the server filtered to the rooftops this person works; every other
 * id — the jacket, its packages, its documents, its ceremony — comes from a row
 * already on the screen.
 *
 * WHAT THE SCREENS ARE FOR:
 *
 *   * JACKETS — every jacket across the rooftops this person works, the queues
 *     somebody has to act on, and the way in.
 *   * JACKET — one deal: what it was bound to, the checklist and what is
 *     missing, every package version with its documents and hashes, the
 *     ceremony and its signers, the timeline, and the holds.
 *
 * WHAT IS DELIBERATELY NOT HERE: the customer's signing link. It went to the
 * provider, and a screen that could show it to staff would let staff sign as
 * the customer. Staff see that an invitation was issued, and to whom, masked.
 */
'use strict';

/* global ROUTES, api, el, modal, toast, reportError, badge, statCard, renderApp, picker, salesAgo, salesWhen, dollars, percent */

function shortHash(hash) {
  return hash ? String(hash).slice(0, 12) + '…' : '—';
}

function fieldValue(f) {
  if (f.valueKind === 'money') return dollars(f.valueCents) + ' ' + (f.currency || '');
  if (f.valueKind === 'rate_ppm') return percent(f.valueInteger);
  if (f.valueKind === 'integer') return String(f.valueInteger);
  return f.valueText === null ? '—' : String(f.valueText);
}

// ── the board ───────────────────────────────────────────────────────────────

async function renderJacketBoard(view) {
  const data = await api('GET', '/api/jacket/board');
  const board = data.board;

  view.appendChild(
    el('div', { class: 'stats' }, [
      statCard(board.open, 'Open jackets'),
      statCard(board.awaitingReview, 'Ready for review'),
      statCard(board.awaitingSignature, 'Out for signature'),
      statCard(board.signedComplete, 'Signed complete'),
    ]),
  );

  view.appendChild(
    el('p', { class: 'muted' }, [
      'A signed package is evidence that people signed documents. The sale, funding, delivery, ' +
        'sold inventory, accounting posting, gross, commission and revenue are NOT_YET_AVAILABLE ' +
        'in this phase; nothing here moves money or a car.',
    ]),
  );

  const q = board.queues;
  view.appendChild(
    el('p', null, [
      'Needs doing: ',
      badge('missing documents ' + q.missing_documents),
      ' ',
      badge('render failure ' + q.render_failure),
      ' ',
      badge('rejected or expired ' + q.rejected_or_expired),
      ' ',
      badge('provider failure ' + q.provider_failure),
      ' ',
      badge('desk approval moved ' + q.stale_inputs),
    ]),
  );

  view.appendChild(
    el('button', { class: 'primary', text: 'Open a jacket', onclick: openJacketDialog }),
  );
  view.appendChild(
    el('button', {
      class: 'ghost',
      text: 'Document templates (manager)',
      onclick: openConfigurationDialog,
    }),
  );

  if (board.rows.length === 0) {
    view.appendChild(el('p', { class: 'muted', text: 'No jackets at the rooftops you work.' }));
    return;
  }

  const rows = board.rows.map(function (row) {
    const pkg = row.latestPackage;
    return el(
      'tr',
      {
        onclick: function () {
          location.hash = '#/jacket/' + row.jacketId;
        },
      },
      [
        el('td', { text: row.customerName }),
        el('td', { text: row.vehicleDescription === null ? '—' : row.vehicleDescription }),
        el('td', null, [badge(row.state)]),
        el('td', { text: 'desk v' + row.boundVersionNo + (row.stale ? ' (moved)' : '') }),
        el('td', null, [
          pkg === null
            ? el('span', { class: 'muted', text: 'none' })
            : el('span', null, ['v' + pkg.versionNo + ' ', badge(pkg.state)]),
        ]),
        el('td', {
          text:
            row.ceremony === null
              ? '—'
              : row.ceremony.signed + ' of ' + row.ceremony.total + ' signed',
        }),
        el('td', null, [
          row.exceptions.length === 0
            ? el('span', { class: 'muted', text: '—' })
            : el(
                'span',
                null,
                row.exceptions.map(function (e) {
                  return badge(e);
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
          el('th', { text: 'Vehicle' }),
          el('th', { text: 'Jacket' }),
          el('th', { text: 'Bound to' }),
          el('th', { text: 'Package' }),
          el('th', { text: 'Signatures' }),
          el('th', { text: 'Needs doing' }),
        ]),
      ]),
      el('tbody', null, rows),
    ]),
  );
}

/** Open a jacket from the list of deals the desk has approved. */
function openJacketDialog() {
  modal('Open a jacket', function (box, close) {
    box.appendChild(
      el('p', { class: 'muted' }, [
        'These are the deals a manager has approved on the desk and that have no jacket yet. ' +
          'Choose one — there is nothing to type.',
      ]),
    );
    picker(box, {
      label: 'Approved on the desk',
      path: '/api/jacket/find/approved',
      collection: 'cases',
      empty: 'No approved deal is waiting for a jacket at the rooftops you work.',
      render: function (c) {
        return (
          c.customerName +
          ' — desk v' +
          c.versionNo +
          ' · financed ' +
          dollars(c.amountFinancedCents) +
          (c.monthlyPaymentCents === null ? '' : ' · ' + dollars(c.monthlyPaymentCents) + '/mo') +
          ' · approved ' +
          salesAgo(c.approvedAt)
        );
      },
      onPick: async function (c) {
        try {
          const created = await api(
            'POST',
            '/api/jacket/jackets',
            { desking_case_id: c.deskingCaseId, location_id: c.rooftopId },
            { idempotent: true },
          );
          close();
          toast(
            created.outcome === 'already_open' ? 'That jacket was already open' : 'Jacket opened',
          );
          location.hash = '#/jacket/' + created.jacket.jacketId;
          renderApp();
        } catch (err) {
          reportError(err);
        }
      },
    });
    box.appendChild(el('button', { class: 'ghost', text: 'Cancel', onclick: close }));
  });
}

// ── one jacket ──────────────────────────────────────────────────────────────

async function renderJacket(view) {
  const jacketId = (location.hash.split('/')[2] || '').trim();
  if (!jacketId) {
    view.appendChild(el('p', { class: 'muted', text: 'Choose a jacket from the board.' }));
    return;
  }
  const data = await api('GET', '/api/jacket/jackets/' + jacketId);
  const j = data.jacket;

  view.appendChild(
    el('div', { class: 'card' }, [
      el('h2', { text: j.customerName }),
      el('p', { class: 'muted' }, [
        j.vehicleDescription === null ? 'No vehicle settled on' : j.vehicleDescription,
        ' · ',
        badge(j.jacket.state),
        ' · bound to desk v' +
          j.jacket.scenarioVersionNo +
          ' (' +
          j.jacket.transactionType.replace('_', ' ') +
          ', ' +
          j.jacket.jurisdiction +
          ')',
        ' · opened ',
        salesAgo(j.jacket.openedAt),
        j.legalHold ? ' · ' : '',
        j.legalHold ? badge('legal hold') : '',
      ]),
      j.stale
        ? el('div', { class: 'error-banner' }, [
            'The desk no longer stands behind version ' +
              j.jacket.scenarioVersionNo +
              (j.currentApprovedVersionNo === null
                ? ' — nothing is approved on this deal now.'
                : ' — version ' + j.currentApprovedVersionNo + ' is approved now.') +
              ' Void this jacket and open a new one from the current approval.',
          ])
        : null,
    ]),
  );

  renderChecklistSection(view, j);
  renderPackagesSection(view, j);
  renderBindingsSection(view, j);
  renderHoldsSection(view, j);
}

function renderChecklistSection(view, j) {
  const section = el('section', { class: 'card' }, [el('h3', { text: 'Checklist' })]);
  if (j.checklist.length === 0) {
    section.appendChild(
      el('p', {
        class: 'muted',
        text: 'No document requirement is configured for this deal’s jurisdiction and rooftop.',
      }),
    );
  } else {
    section.appendChild(
      el('p', { class: 'muted' }, [
        j.blocking.length === 0
          ? 'Every required item is met.'
          : j.blocking.length +
            ' required item(s) still missing — the package cannot go for review until they are met or waived.',
      ]),
    );
    section.appendChild(
      el('table', { class: 'table' }, [
        el('thead', null, [
          el('tr', null, [
            el('th', { text: 'Requirement' }),
            el('th', { text: 'Source' }),
            el('th', { text: 'Met by' }),
            el('th', { text: 'State' }),
            el('th', { text: '' }),
          ]),
        ]),
        el(
          'tbody',
          null,
          j.checklist.map(function (item) {
            return el('tr', null, [
              el('td', {
                text:
                  item.requirementCode +
                  ' v' +
                  item.requirementVersion +
                  (item.required ? '' : ' (optional)'),
              }),
              el('td', { text: item.requirementSource }),
              el('td', {
                text:
                  item.satisfiedBy === 'template'
                    ? 'document ' + item.templateCode
                    : 'evidence: ' + item.evidenceKind,
              }),
              el('td', null, [
                badge(item.state),
                item.state === 'waived'
                  ? el('span', {
                      class: 'muted',
                      text:
                        ' — ' + item.waiverReason + ' (policy v' + item.waiverPolicyVersion + ')',
                    })
                  : '',
              ]),
              el('td', null, [
                item.state === 'missing' && item.satisfiedBy === 'evidence'
                  ? el('button', {
                      class: 'ghost small',
                      text: 'Record evidence',
                      onclick: function () {
                        evidenceDialog(j, item);
                      },
                    })
                  : null,
                item.state === 'missing' && item.waivable
                  ? el('button', {
                      class: 'ghost small',
                      text: 'Waive (manager)',
                      onclick: function () {
                        waiverDialog(j, item);
                      },
                    })
                  : null,
              ]),
            ]);
          }),
        ),
      ]),
    );
  }
  view.appendChild(section);
}

function evidenceDialog(j, item) {
  modal('Record evidence for ' + item.requirementCode, function (box, close) {
    const values = {};
    const field = function (label, key, placeholder) {
      box.appendChild(el('label', null, [label]));
      box.appendChild(
        el('input', {
          placeholder: placeholder || '',
          oninput: function (e) {
            values[key] = e.target.value;
          },
        }),
      );
    };
    field('Where the evidence is (a URI)', 'evidence_uri', 'file://… or https://…');
    field('sha256 of its bytes', 'evidence_sha256', '64 hex characters');
    box.appendChild(
      el('button', {
        class: 'primary',
        text: 'Record',
        onclick: async function () {
          try {
            await api(
              'POST',
              '/api/jacket/jackets/' +
                j.jacket.jacketId +
                '/checklist/' +
                item.itemId +
                '/evidence',
              {
                evidence_uri: values.evidence_uri,
                evidence_sha256: values.evidence_sha256,
                expected_version: item.authorizationVersion,
              },
            );
            close();
            toast('Evidence recorded');
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

function waiverDialog(j, item) {
  modal('Waive ' + item.requirementCode, function (box, close) {
    const values = {};
    const field = function (label, key, placeholder) {
      box.appendChild(el('label', null, [label]));
      box.appendChild(
        el('input', {
          placeholder: placeholder || '',
          oninput: function (e) {
            values[key] = e.target.value;
          },
        }),
      );
    };
    box.appendChild(
      el('p', {
        class: 'muted',
        text: 'A waiver is four things or it is nothing: who (you), why, under which policy version, and with what evidence.',
      }),
    );
    field('Why', 'reason', '');
    field('Policy version that permits it', 'policy_version', 'a whole number');
    field('Evidence (a URI)', 'evidence_uri', '');
    box.appendChild(
      el('button', {
        class: 'primary',
        text: 'Waive',
        onclick: async function () {
          try {
            await api(
              'POST',
              '/api/jacket/jackets/' + j.jacket.jacketId + '/checklist/' + item.itemId + '/waiver',
              {
                reason: values.reason,
                policy_version: Number(values.policy_version),
                evidence_uri: values.evidence_uri,
                expected_version: item.authorizationVersion,
              },
            );
            close();
            toast('Requirement waived');
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

function renderPackagesSection(view, j) {
  const section = el('section', { class: 'card' }, [el('h3', { text: 'Packages' })]);
  if (j.jacket.state !== 'voided') {
    section.appendChild(
      el('button', {
        class: 'primary',
        text: j.packages.length === 0 ? 'Assemble the package' : 'Re-assemble (next version)',
        onclick: async function () {
          try {
            const out = await api(
              'POST',
              '/api/jacket/jackets/' + j.jacket.jacketId + '/packages',
              { expected_version: j.jacket.authorizationVersion },
              { idempotent: true },
            );
            toast(
              out.outcome === 'already_current'
                ? 'Nothing changed — version ' + out.package.versionNo + ' is current'
                : 'Package version ' +
                    out.package.versionNo +
                    ' assembled: ' +
                    out.documents.length +
                    ' document(s)',
            );
            renderApp();
          } catch (err) {
            reportError(err);
          }
        },
      }),
    );
  }
  if (j.packages.length === 0) {
    section.appendChild(el('p', { class: 'muted', text: 'No package has been assembled yet.' }));
    view.appendChild(section);
    return;
  }
  j.packages.forEach(function (p) {
    section.appendChild(renderPackage(j, p));
  });
  view.appendChild(section);
}

function renderPackage(j, p) {
  const pkg = p.package;
  const box = el('div', { class: 'card' }, [
    el('h4', null, [
      'Version ' + pkg.versionNo + ' ',
      badge(pkg.state),
      pkg.carriesUnapprovedTemplates ? ' ' : '',
      pkg.carriesUnapprovedTemplates ? badge('unapproved sample templates') : '',
    ]),
    el('p', { class: 'muted' }, [
      'assembled ' +
        salesAgo(pkg.assembledAt) +
        ' · fields ' +
        shortHash(pkg.fieldsSha256) +
        ' · package hash ' +
        shortHash(pkg.packageSha256) +
        (pkg.supersedesPackageId ? ' · supersedes an earlier version' : '') +
        (pkg.stateReason ? ' · ' + pkg.stateReason : ''),
    ]),
  ]);

  if (p.documents.length > 0) {
    box.appendChild(
      el('table', { class: 'table' }, [
        el('thead', null, [
          el('tr', null, [
            el('th', { text: '#' }),
            el('th', { text: 'Document' }),
            el('th', { text: 'Template' }),
            el('th', { text: 'Approval' }),
            el('th', { text: 'Content hash' }),
            el('th', { text: 'Bytes' }),
            el('th', { text: 'Scan' }),
            el('th', { text: 'Retention' }),
            el('th', { text: '' }),
          ]),
        ]),
        el(
          'tbody',
          null,
          p.documents.map(function (d) {
            return el('tr', null, [
              el('td', { text: String(d.sequenceNo) }),
              el('td', { text: d.title + (d.legalHold ? ' (legal hold)' : '') }),
              el('td', { text: d.templateCode + ' v' + d.templateVersion }),
              el('td', null, [badge(d.templateApprovalStatus)]),
              el('td', { text: shortHash(d.contentSha256), title: d.contentSha256 }),
              el('td', { text: String(d.byteSize) }),
              el('td', { text: d.malwareScanResult.replace('_', ' ') }),
              el('td', { text: d.retentionPolicyCode + ' v' + d.retentionPolicyVersion }),
              el('td', null, [
                el('button', {
                  class: 'ghost small',
                  text: 'Open (15 min link)',
                  onclick: async function () {
                    try {
                      const g = await api(
                        'POST',
                        '/api/jacket/packages/' +
                          pkg.packageId +
                          '/documents/' +
                          d.documentId +
                          '/access',
                        {},
                      );
                      window.open(g.grant.path, '_blank');
                    } catch (err) {
                      reportError(err);
                    }
                  },
                }),
              ]),
            ]);
          }),
        ),
      ]),
    );
  }

  const figures = p.fields.filter(function (f) {
    return f.fieldCode.indexOf('deal.') === 0 && f.valueKind === 'money';
  });
  if (figures.length > 0) {
    box.appendChild(
      el('p', { class: 'muted' }, [
        'Figures, from the approved desk version in whole cents: ' +
          figures
            .map(function (f) {
              return f.fieldCode.replace('deal.', '').replace(/_/g, ' ') + ' ' + fieldValue(f);
            })
            .join(' · '),
      ]),
    );
  }

  const actions = el('p', null, []);
  if (pkg.state === 'draft') {
    actions.appendChild(
      el('button', {
        class: 'primary',
        text: 'Ready for review',
        onclick: async function () {
          try {
            await api('POST', '/api/jacket/packages/' + pkg.packageId + '/review-ready', {
              expected_version: pkg.authorizationVersion,
            });
            toast('Package is ready for review');
            renderApp();
          } catch (err) {
            reportError(err);
          }
        },
      }),
    );
  }
  if (
    (pkg.state === 'draft' || pkg.state === 'review_ready') &&
    pkg.reviewRequired &&
    pkg.reviewedAt === null
  ) {
    actions.appendChild(
      el('button', {
        class: 'ghost',
        text: 'Record manager review',
        onclick: async function () {
          try {
            await api('POST', '/api/jacket/packages/' + pkg.packageId + '/review', {
              expected_version: pkg.authorizationVersion,
            });
            toast('Review recorded');
            renderApp();
          } catch (err) {
            reportError(err);
          }
        },
      }),
    );
  }
  if (pkg.state === 'review_ready') {
    actions.appendChild(
      el('button', {
        class: 'primary',
        text: 'Send for signature (manager)',
        onclick: async function () {
          try {
            const out = await api('POST', '/api/jacket/packages/' + pkg.packageId + '/send', {
              expected_version: pkg.authorizationVersion,
            });
            toast('Sent: ' + out.signers.length + ' signer(s) invited through the provider');
            renderApp();
          } catch (err) {
            reportError(err);
          }
        },
      }),
    );
  }
  if (['draft', 'review_ready', 'sent', 'partially_signed'].indexOf(pkg.state) >= 0) {
    actions.appendChild(
      el('button', {
        class: 'ghost',
        text: 'Void (manager)',
        onclick: function () {
          reasonDialog('Void package version ' + pkg.versionNo, async function (reason) {
            await api('POST', '/api/jacket/packages/' + pkg.packageId + '/void', {
              reason: reason,
              expected_version: pkg.authorizationVersion,
            });
          });
        },
      }),
    );
  }
  box.appendChild(actions);

  if (p.ceremony !== null) box.appendChild(renderCeremony(p));
  return box;
}

function reasonDialog(title, act) {
  modal(title, function (box, close) {
    let reason = '';
    box.appendChild(el('label', null, ['Why']));
    box.appendChild(
      el('input', {
        oninput: function (e) {
          reason = e.target.value;
        },
      }),
    );
    box.appendChild(
      el('button', {
        class: 'primary',
        text: 'Confirm',
        onclick: async function () {
          try {
            await act(reason);
            close();
            toast('Done');
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

function renderCeremony(p) {
  const c = p.ceremony;
  const box = el('div', { class: 'card' }, [
    el('h4', null, ['Signing ceremony ', badge(c.state)]),
    el('p', { class: 'muted' }, [
      'provider ' +
        c.providerCode +
        ' (' +
        c.providerKind.replace(/_/g, ' ') +
        ')' +
        ' · envelope ' +
        (c.providerEnvelopeRef || '—') +
        ' · bound to package hash ' +
        shortHash(c.boundPackageSha256) +
        ' · expires ' +
        salesWhen(c.expiresAt) +
        (c.completionCertificateSha256
          ? ' · certificate ' + shortHash(c.completionCertificateSha256)
          : ''),
    ]),
  ]);

  box.appendChild(
    el('table', { class: 'table' }, [
      el('thead', null, [
        el('tr', null, [
          el('th', { text: '#' }),
          el('th', { text: 'Signer' }),
          el('th', { text: 'Lane' }),
          el('th', { text: 'Authority · assurance' }),
          el('th', { text: 'State' }),
          el('th', { text: 'Consented' }),
          el('th', { text: 'Signed' }),
          el('th', { text: 'Signature' }),
          el('th', { text: '' }),
        ]),
      ]),
      el(
        'tbody',
        null,
        p.signers.map(function (s) {
          return el('tr', null, [
            el('td', { text: String(s.signingOrder) }),
            el('td', {
              text:
                s.displayName +
                ' (' +
                s.signerRole.replace(/_/g, ' ') +
                ')' +
                (s.contactMasked ? ' · ' + s.contactMasked : ''),
            }),
            el('td', {
              text:
                s.lane === 'signer_token'
                  ? 'invitation link (never shown to staff)'
                  : 'staff session',
            }),
            el('td', {
              text:
                s.signingAuthority.replace(/_/g, ' ') +
                ' · ' +
                s.identityAssurance.replace(/_/g, ' '),
            }),
            el('td', null, [badge(s.state)]),
            el('td', { text: s.consentedAt ? salesWhen(s.consentedAt) : '—' }),
            el('td', { text: s.signedAt ? salesWhen(s.signedAt) : '—' }),
            el('td', { text: shortHash(s.signatureSha256), title: s.signatureSha256 || '' }),
            el('td', null, [
              s.lane === 'staff_session' &&
              s.state !== 'signed' &&
              (c.state === 'sent' || c.state === 'in_progress')
                ? el('button', {
                    class: 'primary small',
                    text: 'Sign as the dealership’s representative',
                    onclick: function () {
                      dealerSignDialog(p);
                    },
                  })
                : null,
            ]),
          ]);
        }),
      ),
    ]),
  );

  if (c.completionCertificateSha256) {
    box.appendChild(
      el('button', {
        class: 'ghost small',
        text: 'Open completion certificate',
        onclick: function () {
          window.open('/api/jacket/ceremonies/' + c.ceremonyId + '/certificate', '_blank');
        },
      }),
    );
  }

  box.appendChild(el('h5', { text: 'Timeline' }));
  box.appendChild(
    el(
      'ul',
      null,
      p.events.map(function (e) {
        return el('li', {
          text:
            salesWhen(e.occurredAt) +
            ' · ' +
            e.eventType +
            ' · ' +
            e.lane +
            (e.payload && e.payload.reconciliation
              ? ' · provider ' + e.payload.reconciliation
              : '') +
            (e.payload && e.payload.delivery_outcome
              ? ' · delivery ' + e.payload.delivery_outcome
              : ''),
        });
      }),
    ),
  );
  return box;
}

function dealerSignDialog(p) {
  modal('Sign as the dealership’s representative', function (box, close) {
    const holder = el('div', null, [el('div', { class: 'muted', text: 'Loading the terms…' })]);
    box.appendChild(holder);
    api('GET', '/api/jacket/ceremonies/' + p.ceremony.ceremonyId + '/signing-terms')
      .then(function (terms) {
        holder.textContent = '';
        holder.appendChild(el('p', { text: terms.consent_text }));
        holder.appendChild(
          el('p', {
            class: 'muted',
            text: 'Package hash you are signing: ' + p.ceremony.boundPackageSha256,
          }),
        );
        holder.appendChild(el('p', { text: terms.intent_statement }));
        holder.appendChild(
          el('button', {
            class: 'primary',
            text: 'I consent and I sign',
            onclick: async function () {
              try {
                const out = await api(
                  'POST',
                  '/api/jacket/ceremonies/' + p.ceremony.ceremonyId + '/dealer-signature',
                  {
                    package_sha256: p.ceremony.boundPackageSha256,
                    intent_statement: terms.intent_statement,
                    consent_text_version: terms.consent_text_version,
                  },
                );
                close();
                toast(out.completed ? 'Signed — the ceremony is complete' : 'Signed');
                renderApp();
              } catch (err) {
                reportError(err);
              }
            },
          }),
        );
      })
      .catch(function (err) {
        holder.textContent = '';
        holder.appendChild(el('div', { class: 'error-banner', text: err.message }));
      });
    box.appendChild(el('button', { class: 'ghost', text: 'Cancel', onclick: close }));
  });
}

function renderBindingsSection(view, j) {
  const section = el('section', { class: 'card' }, [
    el('h3', { text: 'What this jacket is bound to' }),
  ]);
  section.appendChild(
    el('p', {
      class: 'muted',
      text: 'Every canonical record the package is assembled from, with the version it carried when the jacket opened.',
    }),
  );
  section.appendChild(
    el(
      'ul',
      null,
      j.bindings.map(function (b) {
        return el('li', {
          text:
            b.sourceKind.replace(/_/g, ' ') +
            ' · version ' +
            b.sourceVersion +
            (b.sourceFingerprint ? ' · ' + shortHash(b.sourceFingerprint) : ''),
        });
      }),
    ),
  );
  view.appendChild(section);
}

function renderHoldsSection(view, j) {
  const section = el('section', { class: 'card' }, [
    el('h3', { text: 'Retention and legal hold' }),
  ]);
  section.appendChild(
    el('p', { class: 'muted' }, [
      j.legalHold ? 'A legal hold is in place: retention clocks are suspended.' : 'No legal hold.',
      ' Disposal at the end of retention is NOT_YET_AVAILABLE in this phase — nothing here deletes a document.',
    ]),
  );
  if (j.retention.length > 0) {
    section.appendChild(
      el(
        'ul',
        null,
        j.retention.map(function (r) {
          return el('li', {
            text:
              'v' +
              r.packageVersionNo +
              ' ' +
              r.title +
              ' · ' +
              r.retentionPolicyCode +
              ' v' +
              r.retentionPolicyVersion +
              ' · retain until ' +
              salesWhen(r.retainUntil) +
              (r.legalHold ? ' · held' : ''),
          });
        }),
      ),
    );
  }
  if (j.legalHolds.length > 0) {
    section.appendChild(
      el(
        'ul',
        null,
        j.legalHolds.map(function (h) {
          return el('li', {
            text:
              salesWhen(h.occurredAt) +
              ' · hold ' +
              h.action +
              ' · ' +
              h.reason +
              (h.reference ? ' (' + h.reference + ')' : ''),
          });
        }),
      ),
    );
  }
  section.appendChild(
    el('button', {
      class: 'ghost',
      text: j.legalHold ? 'Lift legal hold (administrator)' : 'Place legal hold (administrator)',
      onclick: function () {
        reasonDialog(
          j.legalHold ? 'Lift the legal hold' : 'Place a legal hold',
          async function (reason) {
            await api('POST', '/api/jacket/jackets/' + j.jacket.jacketId + '/legal-hold', {
              action: j.legalHold ? 'lift' : 'place',
              reason: reason,
              expected_version: j.jacket.authorizationVersion,
            });
          },
        );
      },
    }),
  );
  section.appendChild(
    el('button', {
      class: 'ghost',
      text: 'Export the file (administrator)',
      onclick: function () {
        window.open('/api/jacket/jackets/' + j.jacket.jacketId + '/export', '_blank');
      },
    }),
  );
  if (j.jacket.state !== 'voided') {
    section.appendChild(
      el('button', {
        class: 'ghost',
        text: 'Void this jacket (manager)',
        onclick: function () {
          reasonDialog('Void this jacket', async function (reason) {
            await api('POST', '/api/jacket/jackets/' + j.jacket.jacketId + '/void', {
              reason: reason,
              expected_version: j.jacket.authorizationVersion,
            });
          });
        },
      }),
    );
  }
  view.appendChild(section);
}

// ── configuration ───────────────────────────────────────────────────────────

/**
 * The document templates and requirements in force, and the form that records
 * the NEXT version of a template. A template is never edited: a manager records
 * the next version, optionally ending the one in force at the same instant, and
 * every package assembled from then on renders the new text. The default status
 * is an unapproved sample, and the form says what approving means.
 */
function openConfigurationDialog() {
  modal('Document configuration', function (box, close) {
    const listing = el('div', null, [el('div', { class: 'muted', text: 'Loading…' })]);
    box.appendChild(listing);
    api('GET', '/api/jacket/configuration')
      .then(function (data) {
        const c = data.configuration;
        listing.textContent = '';
        listing.appendChild(el('h4', { text: 'Templates' }));
        listing.appendChild(
          el(
            'ul',
            null,
            c.templates.map(function (t) {
              return el('li', {
                text:
                  t.templateCode +
                  ' v' +
                  t.version +
                  ' — ' +
                  t.title +
                  ' · ' +
                  t.jurisdiction +
                  ' · ' +
                  t.approvalStatus.replace(/_/g, ' ') +
                  ' · in force ' +
                  salesWhen(t.effectiveFrom) +
                  (t.effectiveTo ? ' to ' + salesWhen(t.effectiveTo) : ' onward') +
                  ' · source: ' +
                  t.source,
              });
            }),
          ),
        );
        listing.appendChild(el('h4', { text: 'Requirements' }));
        listing.appendChild(
          el(
            'ul',
            null,
            c.requirements.map(function (r) {
              return el('li', {
                text:
                  r.requirementCode +
                  ' v' +
                  r.version +
                  ' — ' +
                  r.label +
                  (r.required ? '' : ' (optional)') +
                  (r.waivable ? ' · waivable' : '') +
                  ' · ' +
                  (r.satisfiedBy === 'template'
                    ? 'document ' + r.templateCode
                    : 'evidence ' + r.evidenceKind) +
                  ' · source: ' +
                  r.source,
              });
            }),
          ),
        );
        listing.appendChild(el('h4', { text: 'Retention' }));
        listing.appendChild(
          el(
            'ul',
            null,
            c.retentionPolicies.map(function (p) {
              return el('li', {
                text:
                  p.policyCode +
                  ' v' +
                  p.version +
                  ' — ' +
                  p.retainForDays +
                  ' days · source: ' +
                  p.source,
              });
            }),
          ),
        );
      })
      .catch(function (err) {
        listing.textContent = '';
        listing.appendChild(el('div', { class: 'error-banner', text: err.message }));
      });

    box.appendChild(el('h4', { text: 'Record the next version of a template' }));
    box.appendChild(
      el('p', { class: 'muted' }, [
        'A template is never edited. The next version is recorded with where its text came from; it is an ' +
          'UNAPPROVED SAMPLE unless an accountable manager approves it with a reference, and every page it ' +
          'renders says which.',
      ]),
    );
    const values = {
      approval_status: 'unapproved_sample',
      closes_predecessor: true,
      document_kind: 'acknowledgement',
    };
    const field = function (label, key, placeholder, multiline) {
      box.appendChild(el('label', null, [label]));
      box.appendChild(
        el(multiline ? 'textarea' : 'input', {
          placeholder: placeholder || '',
          rows: multiline ? '5' : null,
          oninput: function (e) {
            values[key] = e.target.value;
          },
        }),
      );
    };
    field('Template code (letters, digits, _)', 'template_code', 'privacy_notice');
    field('Title', 'title', '');
    field('Jurisdiction', 'jurisdiction', 'US-CO');
    field('Source of the text', 'source', 'where these words came from');
    field(
      'Body — use {{field.code}} placeholders',
      'body_template',
      'PRIVACY NOTICE. {{customer.name}} acknowledges …',
      true,
    );
    box.appendChild(el('label', null, ['Document kind']));
    box.appendChild(
      el(
        'select',
        {
          onchange: function (e) {
            values.document_kind = e.target.value;
          },
        },
        ['acknowledgement', 'disclosure', 'contract', 'supporting'].map(function (k) {
          return el('option', { value: k, text: k });
        }),
      ),
    );
    box.appendChild(el('label', null, ['Approval']));
    box.appendChild(
      el(
        'select',
        {
          onchange: function (e) {
            values.approval_status = e.target.value;
          },
        },
        [
          el('option', { value: 'unapproved_sample', text: 'unapproved sample (default)' }),
          el('option', {
            value: 'approved',
            text: 'approved — I am accountable, and I name the approval reference below',
          }),
        ],
      ),
    );
    field(
      'Approval reference (required when approved)',
      'approval_reference',
      'counsel memo, filing, licence…',
    );
    box.appendChild(
      el('label', null, [
        el('input', {
          type: 'checkbox',
          checked: 'checked',
          onchange: function (e) {
            values.closes_predecessor = e.target.checked;
          },
        }),
        ' End the version currently in force at this instant',
      ]),
    );
    box.appendChild(
      el('button', {
        class: 'primary',
        text: 'Record version',
        onclick: async function () {
          try {
            const out = await api(
              'POST',
              '/api/jacket/configuration/templates',
              {
                template_code: values.template_code,
                title: values.title,
                document_kind: values.document_kind,
                jurisdiction: values.jurisdiction,
                transaction_type: 'any',
                source: values.source,
                approval_status: values.approval_status,
                approval_reference: values.approval_reference || null,
                effective_from: new Date().toISOString(),
                body_template: values.body_template,
                required_signer_roles: ['customer'],
                closes_predecessor: values.closes_predecessor,
              },
              { idempotent: true },
            );
            close();
            toast(
              'Recorded ' +
                out.template.templateCode +
                ' version ' +
                out.template.version +
                ' (' +
                out.template.approvalStatus.replace(/_/g, ' ') +
                ')',
            );
            renderApp();
          } catch (err) {
            reportError(err);
          }
        },
      }),
    );
    box.appendChild(el('button', { class: 'ghost', text: 'Close', onclick: close }));
  });
}

// ── registration ────────────────────────────────────────────────────────────

ROUTES.jackets = { title: 'Jackets', render: renderJacketBoard };

// Reached from a row on the board, so it routes without taking a tab of its own.
ROUTES.jacket = { title: 'Deal jacket', render: renderJacket, hidden: true };
