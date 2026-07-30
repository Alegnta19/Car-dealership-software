# ADR-004 — Database Migration and Rollback Policy

Status: Accepted (FBL-010) · Owner: architect · Date: 2026-07-30

## Context

Migrations live at the repository root (000, 049–054), applied in filename order, each
in its own transaction, recorded in `schema_migrations`. CI proves: empty-database
apply, idempotent re-run, and an upgrade from the byte-retained f76a27a fixture with
legacy data present, with fresh-vs-upgraded schema fingerprints compared in-job. The
authoritative fingerprint is CI's (40420288…): catalog-rendered definitions differ
across PostgreSQL builds, so local fingerprints are never authoritative.

## Decision

This policy is retained unchanged by FBL-010 (which alters no schema). Rules for future
orders: migrations are append-only and immutable once merged (the runner keys on
filename); constraint additions over populated tables use NOT VALID with a later,
deliberate VALIDATE; destructive or contracting changes require an expand/contract
sequence across releases and their own order; every migration must keep the three CI
proofs green; rollback is forward-only (a reverting migration), never history rewrite.
RLS and tenant-qualified keys arrive in FBL-030 as new migrations under these rules.

## Consequences

Schema changes stay reviewable, reproducible and provably upgrade-safe from the earliest
retained baseline.

## Rejected alternatives

Checksummed migration tables and advisory locking (real, but FBL-030+ concerns — this
order changes no schema and adds no migration machinery); ORM-managed schema (hides the
SQL this platform's invariants live in).

## Migration effect

None — FBL-010 ships zero schema changes; fingerprint 40420288… must be unchanged.

## Rollback implications

Nothing to roll back at the database layer.
