# Which blueprint governs, and which one the reviewer is holding

**Governing authority.** The active order is **FBL-020-R5**, checked into this repository at
[`docs/orders/FBL-020-R5.md`](FBL-020-R5.md), canonical-LF SHA-256
`75aa7500f804d51019a6e950a91ab3ef5f30a1a37bb15c743c6d952a2e2bd783` — reproduce with
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
document's status as verified-and-in-hand, which was true of one machine's filesystem and
not of the project record a reviewer reads. This file states the facts and the consequence.

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
| In this repository?     | **No** — see "Where each document is" below                                | **Yes**, `docs/orders/Car_Dealership_SaaS_Architecture_Blueprint.docx`, byte-identical |

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
verified to be withdrawn. The withdrawal has been made everywhere in this repository. The
supply has not been made in the project record, and this repository cannot make it.

**The facts, stated exactly and not overstated:**

- The Version 2.0 blueprint — 95,325 bytes, sha256
  `556d4e108c9db8b7dcfee284828f926157f7663d260d3d3e0d8774bb032feaaf` — **has NOT reached
  the reviewed project record.**
- **BOTH designated project copies are still the Version 1.0 file** — 88,931 bytes, sha256
  `d38ad00ad2cd5a13ac087dbb96a34a4c133d0e5bfe8c81d9820a0b69f31e03f9`.
- The operator has supplied the Version 2.0 bytes **separately**, outside this repository.
  **This repository cannot verify another party's record**, and does not claim to: nothing
  here can observe what the reviewer's project copies contain.
- **Checking the R5 order text into this repository does NOT close §3.1.** That discharges
  §3.2, which is a different clause. The two were run together in an earlier revision and
  the conflation is withdrawn here.

**§3.1 therefore remains OPEN AND EXTERNALLY BLOCKED.** It is not open because work was left
undone here; it is open because the act that closes it happens in a record this repository
cannot reach. **The operator has supplied the Version 2.0 bytes to the reviewer twice.**

**WHO MUST ACT: the reviewer**, by replacing BOTH designated project copies with the
Version 2.0 file. **WHAT THEY MUST VERIFY ON ARRIVAL**, on the copy that lands in the project
record:

| What to verify    | Expected                                                                   |
| ----------------- | -------------------------------------------------------------------------- |
| Title, line 1     | `Dealership Management & Sales Cloud`                                      |
| Title, line 2     | `Master Architecture Blueprint and Forward-Only Roadmap`                   |
| Version line      | `Version 2.0  \|  August 4, 2026  \|  Governing management-first baseline` |
| Governing section | §14.3, reading `14.3 First active instruction — FBL-020-R2`                |
| Byte size         | 95,325                                                                     |
| sha256            | `556d4e108c9db8b7dcfee284828f926157f7663d260d3d3e0d8774bb032feaaf`         |

When that happens and the file is also attached at
`docs/orders/Car_Dealership_Management_and_Sales_Cloud_Master_Blueprint.docx`,
`tests/delivery-documentation.test.ts` verifies the attached bytes against the recorded
facts and fails if it is the wrong file — but that is a check on THIS repository's copy, and
a green suite here would still not be evidence about the reviewer's copies.

No document in this repository claims the Version 2.0 document is in hand, verified, or
part of the project record. `tests/delivery-documentation.test.ts` carries R4's exact
in-hand-and-verified wording in its `BANNED_CLAIMS` list and fails if any delivery document
reintroduces it, and it asserts that the requirement map records
`present_in_repository: false` and `verification: "attested-not-in-repository"` for that
document.

## Where each document is

**The superseded Version 1.0 document is in this repository**, at
`docs/orders/Car_Dealership_SaaS_Architecture_Blueprint.docx`, byte-identical to the
digest above. It is checked in for one reason: it is the document a reviewer of this
project actually holds, and `tests/delivery-documentation.test.ts` reads it — its bytes,
its title, its version line and its §14 headings — so the facts in this file are checked
against a document rather than against another file we wrote.

**The governing Version 2.0 document is NOT in this repository and is not part of the
project record.** The operator is supplying it separately. Until it is attached:

- No test, script or gate requires it. The documentation battery asserts that the
  repository records it as absent, and verifies its recorded facts **only if** a file
  appears at `docs/orders/Car_Dealership_Management_and_Sales_Cloud_Master_Blueprint.docx`
  — so attaching the wrong file fails the suite rather than passing silently.
- **Its facts in the table above do not all have the same standing, and the citation that
  used to cover them did not resolve.** This bullet read "an attestation transcribed from the
  R5 order text (`docs/orders/FBL-020-R5.md`, §3.1, which the operator states as already
  established)". **§3.1 of that order carries none of those facts.** It reads, in full:
  "Supply the actual management-first Version 2.0 blueprint bytes and exact checksum in both
  project copies, or withdraw every claim that the document is 'in hand and verified.'" A
  pointer that does not land is worse than no pointer, so the facts are split here by what
  actually backs each one:

  | Fact                                                       | What backs it                                                                                                                       |
  | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
  | sha256 `556d4e10…`                                         | **RESOLVES.** `docs/orders/FBL-020-R5.md`, **Appendix A item 8**, which states it as the claimed SHA-256 of the file to be attached |
  | Byte size 95,325                                           | **NO IN-REPOSITORY CITATION.** Attested from the operator's own copy                                                                |
  | Title lines, version line, §14 headings, governing section | **NO IN-REPOSITORY CITATION.** Attested from the operator's own copy                                                                |

  Only the digest is derivable here, and `scripts/check-published-figures.ts` reads it out of
  Appendix A item 8, so this record cannot drift from the order text. **Everything else in
  the GOVERNING column is an attestation and nothing more**
  (_NOT GATE-CHECKED: attested, and not derivable in this repository_): it is not a
  measurement a reader of this repository can reproduce, and it is labelled that way in
  `docs/FBL-020-R5-REQUIREMENT-MAP.json` (`verification: "attested-not-in-repository"`).

## What follows for every citation in this repository

1. **Never cite a bare section number.** Every citation of the blueprint names the
   version, the file and the digest, or it is not a citation. "v2.0 §14.3" without the
   file and digest is the R3 defect.
2. **A reader holding only the Version 1.0 document must not be misled.** Where this
   repository cites a requirement, it says whether that requirement is readable in the
   document the reviewer has. Two cases exist and both are marked:
   - Readable in Version 1.0: e.g. the FBL-020 work order itself, at §14.5 there.
   - **Not** readable in Version 1.0: the quality ceilings `tsc-strict <=59`,
     `eslint <=136`, `format <=23`
     (_NOT GATE-CHECKED: readable only in the Version 2.0 blueprint_). That sentence occurs
     once, in Version 2.0 §14.3, and
     the string `ceiling` appears nowhere in the Version 1.0 document — asserted from that
     document's own bytes by `tests/delivery-documentation.test.ts`. **A reviewer holding
     only Version 1.0 cannot verify those numbers from anything in the project record.**
     An earlier revision of this bullet said they could be verified from the checked-in R5
     order text, quoting a working rule "Ceilings are 59/136/23 per the governing
     blueprint". That was **false and is withdrawn**: `grep -i ceiling
docs/orders/FBL-020-R5.md` returns nothing — FBL-020-R5 sets no ceiling and restates
     none. The numbers rest on the Version 2.0 document alone and are recorded here as an
     attestation.
3. **The repository does not depend on the absent document for its gates.** The active
   order text is checked in (§3.2) and no gate reads a `.docx` that is not in the tree.
   What the repository cannot supply from its own contents is the ceilings sentence above,
   and that limit is stated rather than papered over.

## One factual curiosity, recorded because it explains the mix-up

Both documents carry the identical line
`Source archive SHA-256: 1b8dff3bf159c4bdc45671ee97b839907590df26ea43e7fd14c289f09cd5543d`
— they were prepared from the same repository snapshot, five days apart. That is why the
two files look interchangeable on a quick read, and it is verifiable in the copy checked
in here.
