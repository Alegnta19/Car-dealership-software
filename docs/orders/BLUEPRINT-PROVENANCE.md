# Which blueprint governs, and what a bare §14 citation resolves to in each

**Governing authority.** The active order is **FBL-020-R6**; the R5 order text it succeeds is
checked into this repository at
[`docs/orders/FBL-020-R5.md`](FBL-020-R5.md), canonical-LF SHA-256
`83b7bcd961bd36e1ba06ed79bebe524a8d1a6b40c65797ad2b4c37cc0ce47f44` — reproduce with
`sed 's/\r$//' docs/orders/FBL-020-R5.md | sha256sum`. Per that order's Appendix A,
**every R5 clause is UNVERIFIED until the final package proves it**; nothing in this
document closes one, and any earlier "closed" or "discharged" wording about an R5 clause is
withdrawn as a governing status and survives only as an implementation note.

**§3.1 is OPEN.** It is not closed by this file, and it is not closed by checking the order
text in. See "The status of §3.1" below.

FBL-020-R5 §3.1. Two blueprint documents exist for this program. They share a cover
layout, a section numbering scheme and even the same `Source archive SHA-256`, and their
§14 headings are **different orders**. R3 was rejected for a citation that did not say
which document it meant; R4 was rejected for answering that by recording the governing
document's status as verified-and-in-hand on the strength of one machine's filesystem, which
is not a fact this repository could show anybody. This file states the facts and the consequence.

## The two documents, by fact

| Fact                    | GOVERNING                                                                  | SUPERSEDED                                                                             |
| ----------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| File name               | `Car_Dealership_Management_and_Sales_Cloud_Master_Blueprint.docx`          | `Car_Dealership_SaaS_Architecture_Blueprint.docx`                                      |
| Byte size               | 95,325 bytes                                                               | 88,931 bytes                                                                           |
| sha256                  | `556d4e108c9db8b7dcfee284828f926157f7663d260d3d3e0d8774bb032feaaf`         | `d38ad00ad2cd5a13ac087dbb96a34a4c133d0e5bfe8c81d9820a0b69f31e03f9`                     |
| Title, first line       | `Dealership Management & Sales Cloud`                                      | `Car Dealership SaaS`                                                                  |
| Title, second line      | `Master Architecture Blueprint and Forward-Only Roadmap`                   | `Repository Assessment and Industrial Platform Blueprint`                              |
| Version line            | `Version 2.0  \|  August 4, 2026  \|  Governing management-first baseline` | `Version 1.0  \|  July 30, 2026  \|  Architecture baseline`                            |
| Section that governs R5 | §14.3 (in Version 2.0)                                                     | §14.5 (in Version 1.0)                                                                 |
| In this repository?     | **Yes**, at the path in the row above — see "Where each document is" below | **Yes**, `docs/orders/Car_Dealership_SaaS_Architecture_Blueprint.docx`, byte-identical |

The separators in each version line are **two spaces around each pipe**; they are quoted
that way because a test compares them character for character.

## The §14 headings, side by side

| §    | SUPERSEDED (Version 1.0)                              | GOVERNING (Version 2.0)                                          |
| ---- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| 14.1 | `14.1 Execution contract`                             | `14.1 Execution contract`                                        |
| 14.2 | `14.2 Ordered backlog`                                | `14.2 Ordered backlog`                                           |
| 14.3 | `14.3 Work Order FBL-000 — Reproducible Baseline`     | `14.3 First active instruction — FBL-020-R2`                     |
| 14.4 | `14.4 Work Order FBL-010 — Architecture Shell`        | `14.4 Accepted historical order FBL-000 — Reproducible Baseline` |
| 14.5 | `14.5 Work Order FBL-020 — Identity and Organization` | `14.5 Accepted historical order FBL-010 — Architecture Shell`    |
| 14.6 | `14.6 Definition of done for every later order`       | `14.6 Original FBL-020 scope — retained context only`            |
| 14.7 | —                                                     | `14.7 Definition of done for every later order`                  |

**FBL-020 is §14.3 in the Version 2.0 document and §14.5 in the Version 1.0 document, and
§14.3 of the Version 1.0 document is FBL-000.** That is the whole of the ambiguity: a bare
section number names two different orders depending on which file the reader opened.

## The status of §3.1 — OPEN, and what would close it

§3.1 requires the management-first Version 2.0 blueprint's bytes and exact checksum to be
supplied **in both project copies**, or every claim that the document is in hand and
verified to be withdrawn. The withdrawal has been made everywhere in this repository, and
the bytes are now committed here. Whether **both project copies** hold them is a fact about
a record this repository can neither write to nor read, so the clause stays OPEN here — not
answered "no", but unanswerable from this side.

**The facts, stated exactly and not overstated. FBL-020-R6 moved the FIRST of them, and that
movement is the whole of what changed here.**

- **The Version 2.0 blueprint IS IN THIS REPOSITORY** — 95,325 bytes, sha256
  `556d4e108c9db8b7dcfee284828f926157f7663d260d3d3e0d8774bb032feaaf`, committed at
  `docs/orders/Car_Dealership_Management_and_Sales_Cloud_Master_Blueprint.docx`. The
  bytes were sent through the attachment channel three times and what became of them is not
  observable from here, so the operator committed them instead: a clone of this repository is
  a transfer this repository can verify.
  Every fact this file states about that document is now READ FROM THOSE BYTES by
  `tests/delivery-documentation.test.ts`, unconditionally, and by
  `scripts/check-published-figures.ts` for the figures it publishes.
- **WHICH DOCUMENT GOVERNS, AND WHAT §14.3 SAYS IN IT, IS THEREFORE CHECKABLE HERE.** So is
  the ceilings sentence — `tsc-strict <=59, eslint <=136 and format <=23` — which occurs
  exactly once in Version 2.0 §14.3 and nowhere in the Version 1.0 document. Both of those
  were attestations in every previous revision of this file; neither is one now.
- **WHAT IS STILL NOT ESTABLISHED HERE IS THE STATE OF THE REVIEWER'S OWN TWO PROJECT
  COPIES.** §3.1 requires the Version 2.0 bytes in both of them. This repository cannot
  write to that record and cannot read it, so it neither asserts nor denies what those
  copies now contain, and no gate here may assert it. A green suite in this repository is
  evidence about THIS repository's copy and about nothing else.
  <!--final-state:withdrawn-->
  An earlier revision of this section asserted, as a fact of that record, that the bytes had
  not materialized there and that the only accessible project copies remained the Version
  1.0 file. Both are **withdrawn** as claims of this repository: they describe a workspace
  nothing here can observe. What replaced them is the sentence above — the question is open
  because it is unobservable from here, not because it has been answered either way.
  <!--/final-state-->
- **Committing the document does NOT by itself close §3.1**, and neither did checking the
  R5 order text in — that discharges §3.2, a different clause. The two were run together in
  an earlier revision and the conflation is withdrawn here.

**§3.1 therefore remains OPEN, on one clause only.**
**THE GOVERNING VERSION 2.0 BLUEPRINT IS COMMITTED IN THIS REPOSITORY AND EVERY RECORDED FACT
ABOUT IT IS MEASURED FROM ITS OWN BYTES, AND WHETHER THE TWO REVIEWER PROJECT COPIES HOLD IT
IS NOT OBSERVABLE FROM HERE.** It is not open because work was left undone here; it is open
because the act that closes it happens in a record this repository cannot reach.

<!--final-state:withdrawn-->

Until FBL-020-R6, `scripts/check-final-state.ts` REQUIRED this document to assert that the
Version 2.0 bytes **were not materialized in the review workspace and the only accessible
project copies remain the Version 1.0 file**. That sentence is **withdrawn** and the gate now
REFUSES it: its first half is contradicted by the committed document, and its second half was
always a claim about a workspace nothing here can observe.
<!--/final-state-->

**FBL-020-R6 IS NOT SUBMITTABLE AS COMPLETE WHILE §3.1 IS OPEN** — that is the
`submission.status` of `docs/evidence/FBL-020-FINAL-STATE.json`, and
`scripts/check-final-state.ts` refuses any other status while this clause is `OPEN`.

**WHO MUST ACT: the reviewer**, by replacing BOTH designated project copies with the
Version 2.0 file. **WHAT THEY MUST VERIFY ON ARRIVAL**, on the copy that lands in the project
record:

| What to verify    | Expected                                                                   |
| ----------------- | -------------------------------------------------------------------------- |
| Filename          | `Car_Dealership_Management_and_Sales_Cloud_Master_Blueprint.docx`          |
| Byte length       | 95,325                                                                     |
| sha256            | `556d4e108c9db8b7dcfee284828f926157f7663d260d3d3e0d8774bb032feaaf`         |
| Title, line 1     | `Dealership Management & Sales Cloud`                                      |
| Title, line 2     | `Master Architecture Blueprint and Forward-Only Roadmap`                   |
| Version line      | `Version 2.0  \|  August 4, 2026  \|  Governing management-first baseline` |
| Governing section | §14.3, reading `14.3 First active instruction — FBL-020-R2`                |

**Every one of those facts is already checked here, against the committed file**, by
`tests/delivery-documentation.test.ts` — unconditionally, not "when the file appears". So a
reviewer replacing their copies can compare against a document whose facts this repository
has measured rather than against a list somebody typed. What a green suite here proves is
that THIS repository's copy is the right file; it is not, and is nowhere offered as,
evidence about the reviewer's two copies.

NO DOCUMENT IN THIS REPOSITORY MAKES ANY CLAIM ABOUT WHAT THE REVIEWER'S PROJECT RECORD
CONTAINS — not that it holds the Version 2.0 file, not that it holds the Version 1.0 file,
not that a supply has or has not been made. Its state is UNKNOWN HERE. `tests/delivery-documentation.test.ts` carries R4's exact in-hand-and-verified
wording in its `BANNED_CLAIMS` list and fails if any delivery document reintroduces it, and
it asserts that the requirement map records `present_in_repository: true` and
`verification: "verified-from-repository-bytes"` for that document — a statement about this
tree, made because it is measurable in this tree.

## Where each document is

**The superseded Version 1.0 document is in this repository**, at
`docs/orders/Car_Dealership_SaaS_Architecture_Blueprint.docx`, byte-identical to the
digest above. It is checked in for one reason: it is the document a bare
`§14.3` resolves to differently in, which is what makes a bare section number useless as a
citation, and `tests/delivery-documentation.test.ts` reads it — its bytes,
its title, its version line and its §14 headings — so the facts in this file are checked
against a document rather than against another file we wrote.

**The governing Version 2.0 document IS in this repository** at
`docs/orders/Car_Dealership_Management_and_Sales_Cloud_Master_Blueprint.docx`, and the
documentation battery now verifies it unconditionally from its own bytes — digest, byte
length, both title lines, the version line and every §14 heading — exactly as it verifies the
Version 1.0 document. The earlier "verify it only IF a file appears at that path" limb was
written for this moment and is now the ordinary path.

Three sends were made through the attachment channel and their outcome is not observable from
here, so committing the bytes is the transfer this repository can verify. What remains outside
this repository is what the reviewer's own two project copies hold. Nothing here can write to
or read that record, so this file makes no claim about its contents in either direction.

**EVERY ROW BELOW WAS AN ATTESTATION UNTIL FBL-020-R6, AND NONE OF THEM IS ONE NOW.** The
digest was the single fact this repository could resolve; the rest rested on a copy the
project record did not contain. Committing the file replaced every one of them with a
measurement over bytes in this tree.

| Fact                                                       | What backs it                                                                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| sha256 `556d4e10…`                                         | **RESOLVES TWICE.** `docs/orders/FBL-020-R5.md`, **Appendix A item 8**, states it as the claimed SHA-256; the committed file hashes to it, asserted by the battery |
| Byte size 95,325                                           | **DERIVED** from the committed file's own length, by the battery and by `scripts/check-published-figures.ts` (`blueprint_v2_bytes`)                                |
| Title lines, version line, §14 headings, governing section | **DERIVED** from the committed file's paragraph text by `tests/delivery-documentation.test.ts`, through `scripts/docx-text.ts`                                     |
| Ceilings `tsc-strict <=59`, `eslint <=136`, `format <=23`  | **DERIVED** from the same paragraph text (`ceiling_tsc_strict`, `ceiling_eslint`, `ceiling_format`), and asserted to occur EXACTLY ONCE in the document            |

The digest binding runs in BOTH directions and that is deliberate: the order text says which
file was to be supplied, and the file in this tree hashes to what the order text says, so
neither can drift from the other unnoticed. `docs/FBL-020-R5-REQUIREMENT-MAP.json` records
the document `verification: "verified-from-repository-bytes"`, which is now a description of
what actually happens rather than a label over an attestation.

## What follows for every citation in this repository

1. **Never cite a bare section number.** Every citation of the blueprint names the
   version, the file and the digest, or it is not a citation. "v2.0 §14.3" without the
   file and digest is the R3 defect.
2. **A reader holding only the Version 1.0 document must not be misled.** Where this
   repository cites a requirement, it says which document that requirement is readable in.
   Two cases exist and both are marked:
   - Readable in Version 1.0 as well: e.g. the FBL-020 work order itself, at §14.5 there.
   - **Not** readable in Version 1.0: the quality ceilings `tsc-strict <=59`,
     `eslint <=136`, `format <=23`. That sentence occurs exactly once, in Version 2.0
     §14.3, and the string `ceiling` appears nowhere in the Version 1.0 document — both
     asserted from the two documents' own bytes by `tests/delivery-documentation.test.ts`.
     **A reader of THIS REPOSITORY can now verify those three numbers**, because the
     Version 2.0 file is committed here and `scripts/check-published-figures.ts` derives
     each of them from its paragraph text (`ceiling_tsc_strict`, `ceiling_eslint`,
     `ceiling_format`). A reader holding only the Version 1.0 **document** still cannot —
     which is why the marking stays.
     <!--final-state:withdrawn-->
     Two earlier revisions of this bullet are withdrawn. The first said the ceilings could
     be verified from the checked-in R5 order text, quoting a working rule "Ceilings are
     59/136/23 per the governing blueprint"; that was **false** — `grep -i ceiling
docs/orders/FBL-020-R5.md` returns nothing, because FBL-020-R5 sets no ceiling and restates
     none. The second labelled them _NOT GATE-CHECKED: readable only in the Version 2.0
     blueprint_ and called them an attestation; that was true until the Version 2.0 bytes
     were committed and is **false now**, so the label was removed rather than left standing
     over a figure a gate derives.
     <!--/final-state-->
3. **The repository does not depend on a document it does not hold.** The active order text
   is checked in (§3.2), both blueprints are checked in, and no gate reads a `.docx` that is
   not in the tree. The limit that remains is not about a missing document at all: it is
   that nothing here can observe the reviewer's own two project copies, and that limit is
   stated rather than papered over.

## One factual curiosity, recorded because it explains the mix-up

Both documents carry the identical line
`Source archive SHA-256: 1b8dff3bf159c4bdc45671ee97b839907590df26ea43e7fd14c289f09cd5543d`
— they were prepared from the same repository snapshot, five days apart. That is why the
two files look interchangeable on a quick read, and it is verifiable in the copy checked
in here.
