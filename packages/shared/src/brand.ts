declare const brand: unique symbol;

/**
 * A nominal type over a structural one.
 *
 * `AccountId` and `PortfolioId` are both strings at runtime, so without branding
 * the compiler will happily let you pass one where the other is expected - and
 * that mistake surfaces as data attached to the wrong entity, which is exactly
 * the class of bug that is hardest to notice in a ledger.
 */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type AccountId = Brand<string, 'AccountId'>;
export type PortfolioId = Brand<string, 'PortfolioId'>;
export type HouseholdId = Brand<string, 'HouseholdId'>;
export type OwnerId = Brand<string, 'OwnerId'>;
export type UserId = Brand<string, 'UserId'>;
export type InstrumentId = Brand<string, 'InstrumentId'>;
export type TransactionId = Brand<string, 'TransactionId'>;
export type CategoryId = Brand<string, 'CategoryId'>;

/**
 * Shape only: 8-4-4-4-12 hexadecimal.
 *
 * Deliberately not enforcing the RFC 4122 version and variant nibbles. Postgres's
 * own `uuid` type accepts any well-formed UUID, and being stricter than the column
 * would reject values the database is happy to store - the nil UUID, ids minted by
 * an external provider, or rows migrated from another system. Our own ids come
 * from `gen_random_uuid()` and are v4 regardless.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Casts a string to a branded id after checking it looks like a UUID.
 *
 * Every branded id in the schema is a `uuid` column, so an id that is not a UUID
 * is a bug at the point it is created, not at the point the database rejects it.
 */
function makeId<T extends Brand<string, string>>(label: string) {
  return (value: string): T => {
    if (!isUuid(value)) {
      throw new TypeError(`Invalid ${label}: expected a UUID, received ${JSON.stringify(value)}.`);
    }
    return value as T;
  };
}

export const accountId = makeId<AccountId>('AccountId');
export const portfolioId = makeId<PortfolioId>('PortfolioId');
export const householdId = makeId<HouseholdId>('HouseholdId');
export const ownerId = makeId<OwnerId>('OwnerId');
export const userId = makeId<UserId>('UserId');
export const instrumentId = makeId<InstrumentId>('InstrumentId');
export const transactionId = makeId<TransactionId>('TransactionId');
export const categoryId = makeId<CategoryId>('CategoryId');
