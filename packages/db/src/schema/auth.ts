import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity';

/**
 * Tables owned by Better Auth.
 *
 * Prefixed `auth_` because Better Auth's default names collide with the domain:
 * its `account` is an OAuth credential, ours is a bank or brokerage account
 * (`accounts` in structure.ts). Two tables called account in one schema is a
 * mistake waiting to be made in a join.
 *
 * The `user` model maps onto the existing `users` table rather than a second
 * one, so `memberships.user_id` and `owners.user_id` keep pointing at the same
 * row a session refers to.
 *
 * None of these carry row-level security. They are consulted before a household
 * is known - at sign-in there is no tenant yet - and a user may belong to
 * several households. Tenancy starts once a session resolves to a membership.
 */

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    /**
     * The household this session is currently acting for.
     *
     * A user may belong to several; the active one is part of the session
     * rather than of the user, so two browsers can sit in two households at
     * once without one switching the other.
     */
    activeHouseholdId: uuid('active_household_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_sessions_user_idx').on(t.userId)],
);

export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: text('id').primaryKey(),
    /** Identifier at the provider, or the user id for the credential provider. */
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    /**
     * The OAuth issuer this credential came from. Null for the credential
     * provider, which has no issuer - the household's own instance is it.
     */
    issuer: text('issuer'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    /** Argon2id hash for the credential provider. Never a plaintext password. */
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_accounts_user_idx').on(t.userId)],
);

export const authVerifications = pgTable(
  'auth_verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_verifications_identifier_idx').on(t.identifier)],
);

export const authSessionsRelations = relations(authSessions, ({ one }) => ({
  user: one(users, { fields: [authSessions.userId], references: [users.id] }),
}));

export const authAccountsRelations = relations(authAccounts, ({ one }) => ({
  user: one(users, { fields: [authAccounts.userId], references: [users.id] }),
}));

/** Re-exported under the names Better Auth's adapter expects to be given. */
export const authSchema = {
  user: users,
  session: authSessions,
  account: authAccounts,
  verification: authVerifications,
} as const;
