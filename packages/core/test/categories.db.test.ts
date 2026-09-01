import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import {
  Money,
  accountId,
  categoryId as toCategoryId,
  householdId,
  ledgerDate,
  transactionId,
  userId,
  type AccountId,
} from '@altitude/shared';
import { createClient, withHousehold, type Client } from '@altitude/db';
import {
  applyRules,
  createCategory,
  createRule,
  deleteRule,
  listCategories,
  listRules,
  postTransaction,
  reverseTransactionById,
  type Actor,
} from '../src/index';

/**
 * Step 7 of the import pipeline, against a real database (plan §8.6).
 *
 * The engine itself is tested without one in `rules.test.ts`. What needs a
 * database is everything around it: that a rule which cannot be read back is
 * treated as absent, that a pass leaves alone what a person decided, and that
 * one household's rules are invisible to another - a rule says which shops
 * somebody uses, which is not less private than the transactions themselves.
 *
 * Every label is invented.
 */

const MIGRATIONS = join(import.meta.dirname, '..', '..', 'db', 'migrations');

let container: StartedPostgreSqlContainer;
let admin: postgres.Sql;
let client: Client;
let cash: AccountId;
let opening: AccountId;

const HOUSE = householdId('aaaa5555-1111-4111-8111-111111111111');
const OTHER = householdId('bbbb5555-2222-4222-8222-222222222222');
const USER = userId('cccc5555-3333-4333-8333-333333333333');

const owner: Actor = { userId: USER, householdId: HOUSE, role: 'owner' };
const stranger: Actor = { userId: USER, householdId: OTHER, role: 'owner' };

const GROCERIES = toCategoryId('dddd5555-4444-4444-8444-000000000001');
const RENT = toCategoryId('dddd5555-4444-4444-8444-000000000002');

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('altitude')
    .withUsername('altitude')
    .withPassword('altitude')
    .start();

  admin = postgres(container.getConnectionUri(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE ROLE altitude_app LOGIN PASSWORD 'altitude_app';`);

  for (const file of (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort()) {
    const contents = await readFile(join(MIGRATIONS, file), 'utf8');
    for (const statement of contents.split('--> statement-breakpoint')) {
      if (statement.trim() !== '') await admin.unsafe(statement);
    }
  }

  await admin.unsafe(`ALTER ROLE altitude SET row_security = off;`);
  await admin`INSERT INTO users ${admin([
    { id: USER, email: 'categories@example.test', display_name: 'Categories' },
  ])}`;
  await admin`INSERT INTO households ${admin([
    { id: HOUSE, name: 'Mine', base_currency: 'EUR' },
    { id: OTHER, name: 'Theirs', base_currency: 'EUR' },
  ])}`;
  const [portfolio] = await admin<{ id: string }[]>`
    INSERT INTO portfolios ${admin([{ household_id: HOUSE, path: 'home', name: 'Home' }])}
    RETURNING id`;
  const made = await admin<{ id: string; name: string }[]>`
    INSERT INTO accounts ${admin([
      {
        household_id: HOUSE,
        portfolio_id: portfolio!.id,
        name: 'Cash',
        kind: 'cash',
        currency: 'EUR',
      },
      {
        household_id: HOUSE,
        portfolio_id: portfolio!.id,
        name: 'Opening',
        kind: 'opening_balance',
        currency: 'EUR',
      },
    ])} RETURNING id, name`;
  await admin.unsafe(`ALTER ROLE altitude RESET row_security;`);

  cash = accountId(made.find((a) => a.name === 'Cash')!.id);
  opening = accountId(made.find((a) => a.name === 'Opening')!.id);

  const uri = new URL(container.getConnectionUri());
  client = createClient({
    url: `postgres://altitude_app:altitude_app@${uri.hostname}:${uri.port}${uri.pathname}`,
    max: 2,
  });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await admin?.end();
  await container?.stop();
});

const as = <T>(
  actor: Actor,
  work: (tx: Parameters<Parameters<typeof withHousehold>[2]>[0]) => Promise<T>,
) => withHousehold(client, { householdId: actor.householdId, userId: actor.userId }, work);

/** A purchase: money leaves Cash, and the edge of the household takes it. */
async function spend(id: string, day: string, amount: string, description: string) {
  await as(owner, (tx) =>
    postTransaction(tx, owner, {
      id: transactionId(id),
      bookedOn: ledgerDate(day),
      kind: 'withdrawal',
      description,
      entries: [
        { accountId: cash, amount: Money.of(amount, 'EUR') },
        { accountId: opening, amount: Money.of(`-${amount}`, 'EUR') },
      ],
    }),
  );
}

/** The category on each entry of a transaction, by account. */
async function categoriesOf(id: string): Promise<Record<string, string | null>> {
  const rows = await admin<{ account_id: string; name: string | null }[]>`
    SELECT e.account_id::text AS account_id, c.name
      FROM entries e
      LEFT JOIN categories c ON c.id = e.category_id
     WHERE e.transaction_id = ${id}::uuid`;
  return Object.fromEntries(rows.map((row) => [row.account_id, row.name]));
}

describe('categories', () => {
  it('creates one and finds it again', async () => {
    const made = await as(owner, (tx) =>
      createCategory(tx, owner, { id: GROCERIES, name: 'Courses' }),
    );
    expect(made?.name).toBe('Courses');
    expect(await as(owner, (tx) => listCategories(tx, owner))).toHaveLength(1);
  });

  it('gives back the one that exists rather than making a second of the same name', async () => {
    // Case-folded: "Courses" and "courses" are one category, not two somebody
    // has to notice they created.
    const again = await as(owner, (tx) =>
      createCategory(tx, owner, {
        id: toCategoryId('dddd5555-4444-4444-8444-00000000000f'),
        name: 'courses',
      }),
    );
    expect(again?.id).toBe(GROCERIES);
    expect(await as(owner, (tx) => listCategories(tx, owner))).toHaveLength(1);
  });
});

describe('rules', () => {
  it('keeps one and reads it back in priority order', async () => {
    await as(owner, (tx) => createCategory(tx, owner, { id: RENT, name: 'Logement' }));

    await as(owner, (tx) =>
      createRule(tx, owner, {
        id: 'eeee5555-0000-4000-8000-000000000002',
        name: 'Loyer',
        priority: 10,
        conditions: { descriptionMatches: 'loyer' },
        categoryId: RENT,
      }),
    );
    await as(owner, (tx) =>
      createRule(tx, owner, {
        id: 'eeee5555-0000-4000-8000-000000000001',
        name: 'Courses',
        priority: 100,
        conditions: { descriptionMatches: 'carrefour|leclerc' },
        categoryId: GROCERIES,
      }),
    );

    const rules = await as(owner, (tx) => listRules(tx, owner));
    expect(rules.map((rule) => rule.name)).toEqual(['Loyer', 'Courses']);
    expect(rules[0]?.categoryName).toBe('Logement');
  });

  it('refuses a rule it could not read back', async () => {
    // An expression that cannot be compiled would throw once per entry of
    // every import from then on.
    const refused = await as(owner, (tx) =>
      createRule(tx, owner, {
        id: 'eeee5555-0000-4000-8000-00000000000b',
        name: 'Broken',
        conditions: { descriptionMatches: '([unclosed' },
        categoryId: GROCERIES,
      }),
    );
    expect(refused).toBeNull();
    expect(await as(owner, (tx) => listRules(tx, owner))).toHaveLength(2);
  });

  it('treats a row this version cannot read as absent, without deleting it', async () => {
    // A rule with no conditions at all would take every entry it was offered.
    await admin.unsafe(`ALTER ROLE altitude SET row_security = off;`);
    await admin`INSERT INTO categorisation_rules ${admin([
      {
        id: 'eeee5555-0000-4000-8000-00000000000c',
        household_id: HOUSE,
        name: 'From another version',
        priority: 1,
        conditions: {},
        category_id: GROCERIES,
      },
    ])}`;
    await admin.unsafe(`ALTER ROLE altitude RESET row_security;`);

    expect(await as(owner, (tx) => listRules(tx, owner))).toHaveLength(2);
    const [row] = await admin<{ count: string }[]>`
      SELECT count(*)::text FROM categorisation_rules WHERE name = 'From another version'`;
    expect(row?.count).toBe('1');
  });
});

describe('applying rules to the ledger', () => {
  const PURCHASE = 'ffff5555-0000-4000-8000-000000000001';
  const SALARY = 'ffff5555-0000-4000-8000-000000000002';

  it('counts what would change without changing it', async () => {
    await spend(PURCHASE, '2027-01-05', '54.90', 'CARTE 05/01 CARREFOUR MARKET 4972');

    const preview = await as(owner, (tx) => applyRules(tx, owner, { preview: true }));
    expect(preview.changed).toBe(1);
    expect(preview.byCategory).toEqual([{ name: 'Courses', count: 1 }]);

    // Nothing written: the plan asks for a count in front of the act (§8.6).
    expect(await categoriesOf(PURCHASE)).toEqual({ [cash]: null, [opening]: null });
  });

  it('categorises the household side and leaves the edge alone', async () => {
    const done = await as(owner, (tx) => applyRules(tx, owner));
    expect(done.changed).toBe(1);

    /**
     * The mistake that would double every total.
     *
     * A purchase is two entries: Cash goes down, and an equity account - the
     * edge of the household - takes the other side. One trip to the shop is
     * one expense, so only one of the two carries the category.
     */
    expect(await categoriesOf(PURCHASE)).toEqual({ [cash]: 'Courses', [opening]: null });
  });

  it('changes nothing on a second pass', async () => {
    expect((await as(owner, (tx) => applyRules(tx, owner))).changed).toBe(0);
  });

  it('leaves alone what a person categorised by hand', async () => {
    // Salary, which no rule describes, filed by hand under Logement - an odd
    // choice, and precisely the point: a pass must not correct it.
    await spend(SALARY, '2027-01-28', '1900', 'VIREMENT SALAIRE JANVIER');
    await admin.unsafe(`ALTER ROLE altitude SET row_security = off;`);
    await admin`UPDATE entries SET category_id = ${RENT}::uuid, categorised_by = NULL
                 WHERE transaction_id = ${SALARY}::uuid AND account_id = ${cash}::uuid`;
    await admin.unsafe(`ALTER ROLE altitude RESET row_security;`);

    // A rule that would take it if it were allowed to.
    await as(owner, (tx) =>
      createRule(tx, owner, {
        id: 'eeee5555-0000-4000-8000-000000000003',
        name: 'Salaire',
        priority: 50,
        conditions: { descriptionMatches: 'salaire' },
        categoryId: GROCERIES,
      }),
    );

    expect((await as(owner, (tx) => applyRules(tx, owner))).changed).toBe(0);
    expect((await categoriesOf(SALARY))[cash]).toBe('Logement');
  });

  it('applies a rule again after it is edited, because a rule owns what it decided', async () => {
    // The other half of the same guarantee: `categorised_by` is what makes a
    // second pass able to move what rules put there without touching the rest.
    await admin.unsafe(`ALTER ROLE altitude SET row_security = off;`);
    await admin`UPDATE categorisation_rules
                   SET category_id = ${RENT}::uuid
                 WHERE name = 'Courses'`;
    await admin.unsafe(`ALTER ROLE altitude RESET row_security;`);

    expect((await as(owner, (tx) => applyRules(tx, owner))).changed).toBe(1);
    expect((await categoriesOf(PURCHASE))[cash]).toBe('Logement');
  });

  /**
   * The defect a real ledger found and these tests did not.
   *
   * The query excluded reversals and the transactions they cancel, copied from
   * the duplicate finder where that is right. Here it is the opposite: a
   * purchase filed under groceries whose reversal stays uncategorised leaves
   * the groceries total wrong by the amount of a thing that did not happen.
   *
   * And a reversal carries its own description - "Reversal of ..." - not the
   * one it cancels, so it takes a rule of its own. Somebody wrote that rule,
   * pressed the button, and nothing happened, with no way to tell why.
   */
  it('categorises a reversal, which needs a rule of its own', async () => {
    const original = 'ffff5555-0000-4000-8000-000000000003';
    await spend(original, '2027-02-10', '80', 'CARTE 10/02 CARREFOUR MARKET 4972');
    const reversal = 'ffff5555-0000-4000-8000-000000000004';
    await as(owner, (tx) =>
      reverseTransactionById(
        tx,
        owner,
        transactionId(original),
        transactionId(reversal),
        ledgerDate('2027-02-11'),
      ),
    );

    await as(owner, (tx) =>
      createCategory(tx, owner, {
        id: toCategoryId('dddd5555-4444-4444-8444-000000000003'),
        name: 'Annulations',
      }),
    );
    await as(owner, (tx) =>
      createRule(tx, owner, {
        id: 'eeee5555-0000-4000-8000-000000000004',
        name: 'Contrepassations',
        priority: 5,
        // The uuid in the description normalises to "#", so the words are all
        // there is to match on - which is what makes this rule writable at all.
        conditions: { descriptionMatches: 'reversal of', amountBetween: ['-999999999', '0'] },
        categoryId: toCategoryId('dddd5555-4444-4444-8444-000000000003'),
      }),
    );

    const done = await as(owner, (tx) => applyRules(tx, owner));

    // The purchase by its own rule, and the entry that cancels it by this one.
    expect(done.changed).toBe(2);
    expect((await categoriesOf(original))[cash]).toBe('Logement');
    expect((await categoriesOf(reversal))[cash]).toBe('Annulations');
  });
});

describe('a rule belongs to one household', () => {
  it('is invisible to another, which cannot delete it either', async () => {
    expect(await as(stranger, (tx) => listRules(tx, stranger))).toEqual([]);
    expect(await as(stranger, (tx) => listCategories(tx, stranger))).toEqual([]);

    const mine = await as(owner, (tx) => listRules(tx, owner));
    await as(stranger, (tx) => deleteRule(tx, stranger, mine[0]!.id));
    expect(await as(owner, (tx) => listRules(tx, owner))).toHaveLength(mine.length);
  });

  it('refuses an actor whose household is not the one the connection is scoped to', async () => {
    await expect(as(owner, (tx) => listRules(tx, stranger))).rejects.toThrow();
  });
});
