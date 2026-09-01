import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { householdId, userId } from '@altitude/shared';
import { createClient, withHousehold, type Client } from '@altitude/db';
import {
  findMapping,
  forgetMapping,
  listMappings,
  rememberMapping,
  type Actor,
} from '../src/index';

/**
 * Remembering how to read a bank's file, and keeping it to one household.
 *
 * The scoping is the decision worth testing. A mapping holds no figures, but
 * its existence says which bank somebody uses - so unlike `instruments`
 * (ADR-0011), it does not sit outside every household, and the isolation is a
 * claim rather than an implementation detail.
 */

const MIGRATIONS = join(import.meta.dirname, '..', '..', 'db', 'migrations');

let container: StartedPostgreSqlContainer;
let admin: postgres.Sql;
let client: Client;

const HOUSE = householdId('aaaa1111-1111-4111-8111-111111111111');
const OTHER = householdId('bbbb2222-2222-4222-8222-222222222222');
const USER = userId('cccc3333-3333-4333-8333-333333333333');

const mine: Actor = { userId: USER, householdId: HOUSE, role: 'owner' };
const theirs: Actor = { userId: USER, householdId: OTHER, role: 'owner' };

const MAPPING = {
  columns: { bookedOn: 'Date', description: 'Libelle', debit: 'Debit', credit: 'Credit' },
  currency: 'EUR',
};

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
    { id: USER, email: 'mappings@example.test', display_name: 'Mappings' },
  ])}`;
  await admin`INSERT INTO households ${admin([
    { id: HOUSE, name: 'Mine', base_currency: 'EUR' },
    { id: OTHER, name: 'Theirs', base_currency: 'EUR' },
  ])}`;
  await admin.unsafe(`ALTER ROLE altitude RESET row_security;`);

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

describe('remembering a mapping', () => {
  it('finds nothing before anything is kept', async () => {
    expect(await as(mine, (tx) => findMapping(tx, mine, 'nothing'))).toBeNull();
  });

  it('keeps one and finds it again by fingerprint', async () => {
    await as(mine, (tx) =>
      rememberMapping(tx, mine, { name: 'Ma banque', fingerprint: 'semi:date', mapping: MAPPING }),
    );

    const found = await as(mine, (tx) => findMapping(tx, mine, 'semi:date'));
    expect(found?.name).toBe('Ma banque');
    expect(found?.mapping.columns.debit).toBe('Debit');
    expect(found?.mapping.currency).toBe('EUR');
  });

  it('replaces rather than duplicating, because a second answer is a correction', async () => {
    await as(mine, (tx) =>
      rememberMapping(tx, mine, {
        name: 'Ma banque',
        fingerprint: 'semi:date',
        // Somebody realised the date column was the value date.
        mapping: { ...MAPPING, columns: { ...MAPPING.columns, bookedOn: 'Date de valeur' } },
      }),
    );

    const kept = await as(mine, (tx) => listMappings(tx, mine));
    expect(kept).toHaveLength(1);
    expect(kept[0]?.mapping.columns.bookedOn).toBe('Date de valeur');
  });

  it('refuses a mapping it cannot parse rather than storing one that comes back unusable', async () => {
    const stored = await as(mine, (tx) =>
      rememberMapping(tx, mine, {
        name: 'Broken',
        fingerprint: 'broken',
        // No amount column and no debit/credit pair: this describes no file.
        mapping: { columns: { bookedOn: 'Date' } },
      }),
    );

    expect(stored).toBeNull();
    expect(await as(mine, (tx) => findMapping(tx, mine, 'broken'))).toBeNull();
  });

  it('treats a row this version cannot read as absent, without deleting it', async () => {
    // What an older version, or a hand-edited row, leaves behind. Cast rather
    // than parsed, it would produce a reader indexing every row by `undefined`.
    await admin.unsafe(`ALTER ROLE altitude SET row_security = off;`);
    await admin`INSERT INTO imports_mappings ${admin([
      {
        household_id: HOUSE,
        name: 'From another version',
        fingerprint: 'stale',
        mapping: { columns: { bookedOn: 'Date' } },
      },
    ])}`;
    await admin.unsafe(`ALTER ROLE altitude RESET row_security;`);

    expect(await as(mine, (tx) => findMapping(tx, mine, 'stale'))).toBeNull();
    // Still there: what somebody meant is worth keeping even when this version
    // cannot use it.
    const [row] = await admin<{ count: string }[]>`
      SELECT count(*)::text FROM imports_mappings WHERE fingerprint = 'stale'`;
    expect(row?.count).toBe('1');
  });

  it('forgets one on request', async () => {
    const kept = await as(mine, (tx) => listMappings(tx, mine));
    await as(mine, (tx) => forgetMapping(tx, mine, kept[0]!.id));
    expect(await as(mine, (tx) => findMapping(tx, mine, 'semi:date'))).toBeNull();
  });
});

describe('a mapping belongs to one household', () => {
  /**
   * The point of scoping this table, tested rather than assumed.
   *
   * A mapping says which bank somebody uses. Shared across an instance, a
   * member of one household would learn that somebody here banks with a
   * particular bank - a leak nothing later dissolves, unlike the instruments
   * dictionary whose catalogue phase 3 will seed.
   */
  it('is invisible to another household, and both may keep their own', async () => {
    await as(mine, (tx) =>
      rememberMapping(tx, mine, { name: 'Mine', fingerprint: 'shared', mapping: MAPPING }),
    );
    await as(theirs, (tx) =>
      rememberMapping(tx, theirs, { name: 'Theirs', fingerprint: 'shared', mapping: MAPPING }),
    );

    // The same fingerprint in both, which the unique index allows because it is
    // unique per household rather than globally.
    expect((await as(mine, (tx) => findMapping(tx, mine, 'shared')))?.name).toBe('Mine');
    expect((await as(theirs, (tx) => findMapping(tx, theirs, 'shared')))?.name).toBe('Theirs');

    expect(await as(mine, (tx) => listMappings(tx, mine))).toHaveLength(1);
    expect(await as(theirs, (tx) => listMappings(tx, theirs))).toHaveLength(1);
  });

  it('cannot be deleted from another household, even by id', async () => {
    const theirId = (await as(theirs, (tx) => listMappings(tx, theirs)))[0]!.id;

    // Row-level security makes this match nothing rather than the wrong row.
    await as(mine, (tx) => forgetMapping(tx, mine, theirId));
    expect(await as(theirs, (tx) => findMapping(tx, theirs, 'shared'))).not.toBeNull();
  });
});
