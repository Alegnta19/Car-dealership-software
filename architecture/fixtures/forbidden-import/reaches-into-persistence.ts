/**
 * NEGATIVE FIXTURE (FBL-010 section C) — this file is deliberately WRONG.
 *
 * It reaches into @dealer/database's persistence internals (the pool adapter) through a
 * relative path instead of the package's public entry point. The architecture test runs
 * dependency-cruiser over this directory and passes only when the checker REJECTS it.
 * It is excluded from every tsconfig and never compiled into anything.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { getPool } from '../../../packages/database/src/pool';
