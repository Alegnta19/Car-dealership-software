# FBL-020-R6 §1 — MIGRATION PREFLIGHT: THE CENSUS, AND THE 057/058 DECISION

**Status: the implementer's reading, offered for review. Not an acceptance by anyone.**
The census this rests on carries `"acceptance": "NOT_REVIEWED"` in its own body, and no
sentence here should be read as saying the architect has ratified it.

---

## 1. The decision

**`057` is FROZEN.** Migration `migrations/057_identity_boundary_completion.sql` is not
edited by FBL-020-R6, and neither are `000` or `049`–`056`. Every R6 schema change goes in a
new `058`.

The census token that states this is <!--fig:census_position-->FREEZE_057_AND_ADD_058<!--/fig-->.
It is the value of `conclusion.position` in
[`FBL-020-R6-operator-environment-census.json`](FBL-020-R6-operator-environment-census.json),
whose `conclusion.branch_sentence` reads, verbatim:

> AT LEAST ONE PERSISTENT ENVIRONMENT HAS APPLIED A FORM OF 057. Under §0.2 that freezes
> 057 and sends every further schema correction to 058.

**The token moved when the census was RE-TAKEN, and both readings forbid the same thing.**
The earlier artifact rested the branch on the census being INCOMPLETE — no environment
counted as persistent had reported a form of `057`. The re-take reports one, and it is this
machine's own drill cluster on `127.0.0.1:55434`, which the fail-closed policy records as
`persistence: indeterminate`. **The basis is the artifact's own, and an earlier draft of this
sentence attributed the verdict to something else** — a stale `postmaster.pid` from an earlier
wave naming that port, so the recorded launch and the running server disagreed about the
authoritative data directory. **The correction to that draft said the artifact "records no
such thing", and that was false.** The artifact records the disagreement in this
environment's own evidence rows: `data directory (the postmaster.pid of a RUNNING server on
this port)` reads `C:\Users\alegn\AppData\Local\Temp\fbl020r5-pg`, `data directory as the
RUNNING server reports it (SHOW data_directory)` reads
`C:/Users/alegn/AppData/Local/Temp/fbl020r6-pg-main`, and `postmaster.pid and the running
server agree on the data directory` reads **`false`**. What the withdrawn draft got wrong is
narrower: that disagreement is not what the verdict rests on. The recorded
`disposability.basis` is that one database there, `cockpit_upgrade_test`, matches no pattern
this repository declares disposable and the recorded launch does not disable durability
either, so neither content proof holds. The disagreement is how the cluster was located; the
content is what decides the verdict. Under either reading `permits_editing_057_in_place` is
`false` and `requires_058` is `true`.

## 2. The reason, stated so nobody has to re-derive it

FBL-020-R6 §1.3 permits editing `057` in place **only if** a COMPLETE census proves that NO
persistent environment has applied any form of it. That is a demand for a proven negative,
and this census does not supply one:

### 2a. Environments this census could not classify

**<!--fig:census_persistence_indeterminate-->198<!--/fig--> of the <!--fig:census_environments-->204<!--/fig--> environments could not be
CLASSIFIED.** Their durability could not be established from their provenance or their
content, so the census cannot say whether they are persistent environments or drill
clusters. `scripts/migration-census.ts` counts every one of them WITH the persistent ones
rather than waving them through — but counting them conservatively is not the same as
having enumerated the operator's persistent environments, and §1.3 asks for the latter.
**A census carrying an unclassifiable environment is not complete, and an incomplete census
cannot prove a negative.**

### 2b. Environments that HAVE applied a form of 057

**<!--fig:census_verdict_yes-->3<!--/fig--> of them, and they are named:**

- `host-cluster:C:/Users/alegn/AppData/Local/Temp/fbl020r4-pg` — `persistence: disposable`,
  listed under `conclusion.disposable_or_ephemeral_with_057`
- `host-cluster:C:/Users/alegn/AppData/Local/Temp/fbl020r6-pg-main` — `persistence:
disposable`, listed under `conclusion.disposable_or_ephemeral_with_057`
- `local-disposable-cluster-55434` — `persistence: indeterminate`, and therefore counted
  WITH the persistent ones and listed under `conclusion.persistent_environments_with_057`

**This list and the sentence under it are a CORRECTION.** They named two clusters under a
count of three, and said "the census places both outside the persistent set, as this
project's own drill clusters". The first was an arithmetic contradiction inside one section;
the second is false of `local-disposable-cluster-55434`, which the census places INSIDE the
set it counts as persistent, because its disposability could not be established. Both are
withdrawn and replaced by the three rows above, each with the placement the artifact records.

The two `disposable` placements are a READING of the evidence — a judgement the script makes
and publishes with its basis — and a reading is not a proof. It is recorded here because a
reviewer who weighs it differently reaches the same branch, not a different one: a positive
hit inside the persistent set forbids editing `057` outright, and the incompleteness above
forbids it independently.

Neither limb depends on the other. Either one on its own leaves the "unless" clause of §1.3
unsatisfied, and the rule then requires `058`.

**The branch is also the one that costs nothing if the reading is wrong.** A new `058` is
correct whether or not a retained database holds `057`; editing a migration that some
environment has already applied is not.

## 3. What was NOT done, deliberately

- `057` was not edited, and neither were `000` or `049`–`056`. They are byte-immutable.
- The census was not re-run until it produced a convenient answer. The counts above are one
  reading at `2026-08-18T23:28:27.841Z`; the machine churns scratch clusters, so the COUNT moves
  between runs. The durable claim is `conclusion.position`, and the delivery documents quote
  that rather than any count.
- No `058` was written by §1 either. §1 is the preflight; the schema work is later sections
  of the order.

## 4. Where the census came from — scope and provenance

**Role.** `authority.role` is `OPERATOR_CONTROLLED_HOST` and
`authority.may_decide_the_057_058_branch` is `true`.

**Source head.** <!--fig:census_head-->174c7893c8fd05d1fabf0d8ad97eafa168c35fc6<!--/fig-->, tree state `modified`
(<!--fig:census_modified_paths-->51<!--/fig--> changed path(s);
`source_head_provenance.migrations_match_head`: **`false`** — `migrations/` carries **one** of
them). The markers the census searches for are derived from `migrations/`, so that last flag
is the one that decides whether this census asked the question the commit would have asked.
**An earlier version of this line reported that flag as `yes`; the artifact records `false`,
the artifact is the authority, and the line is corrected.** The one change is the untracked
`migrations/058_policy_evidence_reconstructable.sql`, which is why
`repository.markers_searched_for` names both `057_identity_boundary_completion.sql` and
`058_policy_evidence_reconstructable.sql`: this census asked a **wider** question than a
census taken at the commit itself, which would have searched for the `057` marker alone. The
branch does not turn on the difference — every `yes` verdict in §2b is carried by the `057`
marker, which both questions contain — but the flag is reported as the artifact reports it.

**Taken at.** `2026-08-18T23:28:27.841Z`.

**What was enumerated on the host:**

- the GitHub Actions workflows declared in .github/workflows, read as source
- registered Windows services whose image is a PostgreSQL server
- every PostgreSQL data directory discoverable on this host
- the named volume backing docker-compose.yml's postgres service
- the PostgreSQL clusters inside each WSL distribution
- the local drill cluster on 127.0.0.1:55434

**What this census is NOT evidence about:**

- Any environment not reachable from this host. A managed database, a colleague machine, a customer deployment and a cloud environment nobody on this machine has credentials for are all outside this census, and nothing here is evidence about them.
- Any host on the network. Only 127.0.0.1 is probed, and only for the local drill port.
- Any cluster whose data directory this account cannot read. Such a cluster is reported `indeterminate`, never `no`.
- The future. Every verdict is a reading at `generated_at`; an environment migrated a minute later is not described here.

Each environment carries its own `inspection_method`, its `evidence`, its `basis` and its
`limits` — the uncertainty of that particular probe, stated beside its verdict rather than
rounded away. A probe that could not answer is `indeterminate`, never `no`.

## 5. A CI-runner census may not decide this

`ci.yml` takes its own census on the runner. A hosted runner is created for one job and
destroyed after it, so it holds no operator state and can observe none: that artifact is
evidence about the runner and about nothing else. R5 offered it where the order asked for
the operator-controlled environments, and the review rejected it.

The refusal is mechanical now, in three places, so it does not depend on anybody reading
this section:

- the artifact declares `authority.may_decide_the_057_058_branch: false` whenever it is
  taken on a runner (`scripts/migration-census.ts`, `censusAuthority`);
- the workflow step asserts that exact value on the runner artifact (`ci.yml`);
- `scripts/check-census-prose.ts` THROWS on any census whose value is false, so a runner
  artifact cannot be substituted for the operator one by a wrong path or a copied file.

The census the branch rests on is **committed**, at
`docs/evidence/FBL-020-R6-operator-environment-census.json`, precisely because
`artifacts/` is gitignored: a gate reading its evidence from there checks a different thing
on a developer machine than on a fresh checkout, and in CI it would have been checking the
delivery prose against the runner.

## 6. How to re-check this

```
npx tsx scripts/migration-census.ts --out <somewhere>.json --log <somewhere>.txt
npx tsx scripts/check-census-prose.ts
```

The first re-takes the census on the machine it runs on. Its COUNTS will differ from the
ones above — the host creates and destroys scratch clusters continuously — and its
`conclusion.position` is what to compare. The second requires this repository's delivery
documents to state the position the committed operator artifact carries, and fails the run
when they do not.
