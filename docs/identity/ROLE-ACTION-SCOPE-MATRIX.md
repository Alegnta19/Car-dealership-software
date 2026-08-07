# Role / Action / Scope Matrix (FBL-020)

Routes declare **one action**; the central policy engine decides from database
RoleBindings. The role lists below are the action→role matrix — who may be
_granted_ a role that performs the action. Holding a role name means nothing
without an active RoleBinding row covering the resource's scope.

## Scope semantics

A binding at level L covers every resource at or below L, and **nothing above
it**:

```
tenant ⊃ dealer_group ⊃ legal_entity ⊃ rooftop ⊃ department ⊃ resource
```

`platform` is NOT in that chain. A platform binding grants platform actions
only; the sole path to dealership data is an approved, live support-access
session (ADR-008), restricted to its approved action set and scope.

Cross-tenant is denied unconditionally, before any lookup runs.

### Actions that name no resource

Roughly a quarter of the catalog acts without naming an existing row —
creating an appointment, opening a repair order, reading the queues. Scope
still applies to them, in one of two ways:

- **The request names a location.** `location_id` (body or query) is the
  legacy column migration 055 made the rooftop id. It is resolved exactly like
  a resource: a binding must cover that rooftop's chain. A rooftop-scoped
  advisor can therefore create work at their own rooftop and **not** at a
  sibling.
- **The request names no location.** The action reaches the entire tenant, so
  **only a `tenant`-scope binding authorizes it**. A rooftop or department
  binding never widens to tenant-wide reach.

> This is the rule FBL-020-R0 corrected. In the first pass a resource-less
> action was allowed by _any_ binding in the tenant, so the narrowest grant
> answered tenant-wide — see the delivery report, defect 1.

### Effective state

A node authorizes only while it is `active` and inside its
`[effective_from, effective_to)` window, **at every level of the chain**.
Archiving a rooftop revokes every binding scoped to it without touching a
single `role_bindings` row, and a backfilled `pending_configuration` node
authorizes nothing until it is deliberately activated.

## Service actions (44) — `@dealer/fixed-ops` catalog

| Action                                   | Resource               | Roles                            | Sensitive                         |
| ---------------------------------------- | ---------------------- | -------------------------------- | --------------------------------- |
| `service.appointment.create`             | —                      | advisor, manager                 |                                   |
| `service.appointment.update`             | service_appointment    | advisor, manager                 |                                   |
| `service.appointment.check_in`           | service_appointment    | advisor, manager                 |                                   |
| `service.appointment.confirm`            | service_appointment    | advisor, manager                 |                                   |
| `service.appointment.no_show`            | service_appointment    | advisor, manager                 |                                   |
| `service.comeback.create`                | —                      | advisor, manager                 |                                   |
| `service.comeback.update`                | comeback_case          | advisor, manager                 |                                   |
| `service.dispatch.assign`                | —                      | advisor, manager                 |                                   |
| `service.queue.view`                     | —                      | all read roles                   |                                   |
| `service.queue.assign`                   | service_queue_item     | advisor, manager, technician     |                                   |
| `service.queue.escalate`                 | service_queue_item     | manager                          |                                   |
| `service.queue.update_status`            | service_queue_item     | advisor, manager, technician     |                                   |
| `service.cockpit.view`                   | —                      | all read roles                   |                                   |
| `service.cockpit.query`                  | —                      | all read roles                   |                                   |
| `service.intake.quick_start`             | —                      | advisor, manager                 |                                   |
| `service.retention.record_first_service` | —                      | advisor, manager                 |                                   |
| `service.mpi.view_templates`             | —                      | all read roles                   |                                   |
| `service.mpi.start`                      | repair_order           | advisor, manager, technician     |                                   |
| `service.mpi.record_results`             | mpi_session            | advisor, manager, technician     |                                   |
| `service.mpi.submit`                     | mpi_session            | advisor, manager, technician     |                                   |
| `service.parts.request`                  | repair_order           | parts clerk, advisor, manager    |                                   |
| `service.parts.update`                   | ro_parts_line          | parts clerk, advisor, manager    |                                   |
| `service.portal_task.view`               | repair_order           | all read roles                   |                                   |
| `service.portal_task.update`             | service_portal_task    | advisor, manager                 |                                   |
| `service.ro.create`                      | —                      | advisor, manager                 |                                   |
| `service.ro.view`                        | repair_order           | all read roles                   |                                   |
| `service.ro.transition`                  | repair_order           | advisor, manager                 | **yes** — `authorized`/`canceled` |
| `service.ro.line_item.create`            | repair_order           | advisor, manager                 |                                   |
| `service.ro.line_item.update`            | ro_line_item           | advisor, manager, technician     |                                   |
| `service.ro.estimate.generate`           | repair_order           | advisor, manager                 |                                   |
| `service.ro.estimate.send`               | repair_order           | advisor, manager                 |                                   |
| `service.ro.authorization.record`        | repair_order           | advisor, manager                 | **yes** (staff-asserted methods)  |
| `service.ro.authorization.view`          | repair_order           | all read roles                   |                                   |
| `service.ro.recommendation.send`         | repair_order           | advisor, manager                 |                                   |
| `service.ro.sublet.create`               | repair_order           | parts clerk, advisor, manager    |                                   |
| `service.sublet.update`                  | ro_sublet_job          | parts clerk, advisor, manager    |                                   |
| `service.tech.ticket_status`             | tech_work_ticket       | advisor, manager, technician     |                                   |
| `service.tech.ticket_time`               | tech_work_ticket       | advisor, manager, technician     |                                   |
| `service.waitlist.view`                  | —                      | all read roles                   |                                   |
| `service.waitlist.create`                | —                      | advisor, manager                 |                                   |
| `service.waitlist.cancel`                | service_waitlist_entry | advisor, manager                 |                                   |
| `service.waitlist.convert`               | service_waitlist_entry | advisor, manager                 |                                   |
| `service.waitlist.offer`                 | service_waitlist_entry | advisor, manager                 |                                   |
| `service.warranty.claim_create`          | —                      | advisor, manager, warranty admin |                                   |

"all read roles" = parts_clerk, service_advisor, service_manager,
service_technician, service_viewer, warranty_admin.

## Identity / organization actions — `@dealer/identity-access` catalog

| Action                      | Roles                            | Sensitive |
| --------------------------- | -------------------------------- | --------- |
| `identity.user.provision`   | tenant_admin                     |           |
| `identity.user.deactivate`  | tenant_admin                     | yes       |
| `identity.role.grant`       | tenant_admin                     | yes       |
| `identity.role.revoke`      | tenant_admin                     | yes       |
| `identity.support.approve`  | tenant_admin                     | yes       |
| `identity.support.revoke`   | tenant_admin                     |           |
| `org.unit.create`           | tenant_admin                     |           |
| `org.unit.update_status`    | tenant_admin                     |           |
| `platform.tenant.provision` | platform_admin                   |           |
| `platform.support.request`  | platform_support, platform_admin |           |

`platform.*` actions require a `platform`-scope binding and touch no
dealership data.

## Decision reason codes

| Code                         | Meaning                                                                           | External rendering                                             |
| ---------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `ALLOW_ROLE_BINDING`         | A dealership binding covered the scope                                            | proceed                                                        |
| `ALLOW_PLATFORM_ROLE`        | A platform binding covered a `platform.*` action                                  | proceed                                                        |
| `ALLOW_SUPPORT_SESSION`      | A live approved support session covered it                                        | proceed + `x-support-access` header                            |
| `ACTION_UNKNOWN`             | No catalog entry                                                                  | 403                                                            |
| `CROSS_TENANT`               | Target tenant ≠ actor tenant                                                      | 404 when resource-scoped                                       |
| `TENANT_INACTIVE`            | Tenant not active/effective                                                       | 403                                                            |
| `RESOURCE_REQUIRED`          | Route declared a resource action without an id                                    | 403                                                            |
| `RESOURCE_TYPE_MISMATCH`     | Wrong resource type for the action                                                | 404                                                            |
| `RESOURCE_NOT_FOUND`         | Resolver found nothing **in this tenant**                                         | 404                                                            |
| `SCOPE_NOT_FOUND`            | A named location did not resolve in this tenant, or is not effective              | 404                                                            |
| `RESOURCE_SCOPE_UNRESOLVED`  | Ancestry broken                                                                   | 404                                                            |
| `SUPPORT_ACTOR_UNAUTHORIZED` | The support session's actor no longer holds an effective platform-support binding | 404 when a RESOURCE was named (non-enumeration), otherwise 403 |
| `NO_MATCHING_BINDING`        | Deny by default                                                                   | 404 when a RESOURCE was named (non-enumeration), otherwise 403 |

**Non-enumeration:** for resource-scoped requests, "not yours" and "does not
exist" produce the identical not-found envelope.

**`SUPPORT_ACTOR_UNAUTHORIZED` is how offboarding takes effect.** A live support
session is not authority on its own: the engine re-reads the actor's
platform-scope bindings on every decision, under the same effectiveness
predicate every other reader uses. Revoking the binding, or letting its window
close, denies the very next request through that session — no operator has to
remember to revoke the session as well.
