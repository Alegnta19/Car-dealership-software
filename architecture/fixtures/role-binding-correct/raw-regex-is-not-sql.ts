/**
 * POSITIVE FIXTURE — FALSE POSITIVE (4): `String.raw` that really does build
 * regular expressions.
 *
 * This is why the guard used to SKIP raw templates: in this repository they
 * assemble patterns, several of which quote SQL keywords and name the
 * role-bindings table on purpose — `scripts/check-role-binding-effectiveness.ts`
 * is itself full of them, and it is inside the guard's own scope.
 *
 * Skipping was the wrong answer, because it was also a one-token off switch for
 * real SQL (see `role-binding-drift/evasion-l-string-raw.ts`). The right answer is
 * to RESOLVE the raw text and judge it like anything else: these patterns are
 * inspected, and they pass, because a pattern that spells `\s+` has no whitespace
 * in it and so never reads `FROM role_bindings` in the sense the rules mean. This
 * file is what fails if that stops being true and the guard starts reporting its
 * own regular expressions.
 */
export const QUALIFIED = String.raw`(?:[a-z_][a-z0-9_]*\.)?role_bindings\b`;

export const READ_SOURCE = new RegExp(String.raw`\b(?:FROM|JOIN)\s+${QUALIFIED}`, 'gi');

export const WRITE_TARGET = new RegExp(
  String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+${QUALIFIED}`,
  'i',
);

export const GUARDED_COLUMN = String.raw`\brb\.(?:status|effective_from|effective_to)\s*=`;
