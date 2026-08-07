/**
 * NEGATIVE FIXTURE — EVASION (o): a template tag that is not `String.raw`.
 *
 * A tag is a function. It receives the literal pieces and returns whatever it
 * likes, so nothing static can say what `sql\`…\`` sends to the database — and a
 * guard that skipped tagged templates, as it once skipped `String.raw`, would
 * hand every author a one-word way to disappear a statement.
 *
 * The guard therefore renders the template's own pieces, which is what makes this
 * recognisable as an unguarded role-bindings read and reports it as one, and
 * marks the TAG unresolvable on top of that. There is no interpolation in the
 * statement below, so the tag is the only thing the run cannot resolve, and it
 * says so by name.
 */
interface FixtureExecutor {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: Array<{ role: string }> }>;
}

/** A perfectly ordinary-looking helper. It could return anything at all. */
function sql(strings: TemplateStringsArray, ...values: readonly unknown[]): string {
  return strings.raw.join(String(values.length));
}

export async function driftingViaCustomTag(
  executor: FixtureExecutor,
  userLinkId: string,
): Promise<number> {
  const result = await executor.query(
    sql`SELECT rb.role FROM role_bindings rb
      WHERE rb.user_link_id = $1 AND rb.status = 'active'
      ORDER BY rb.role`,
    [userLinkId],
  );
  return result.rows.length;
}
