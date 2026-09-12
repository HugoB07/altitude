'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import {
  accountBalances,
  applyRules,
  closeAccount,
  createAccount,
  createHousehold,
  postTransaction,
  renameAccount,
  reopenAccount,
  reverseTransactionById,
} from '@altitude/core';
import { withHousehold } from '@altitude/db';
import {
  Money,
  accountId,
  householdId,
  ledgerDate,
  todayIn,
  transactionId,
} from '@altitude/shared';
import { getAuthDbClient } from './auth';
import { defaultBaseCurrency } from './config';
import { AccountsMissingError, toMessage } from './errors';
import { requireContext, requireSessionUser, scoped } from './context';
import { ensureTenantIsolation } from './startup';

/**
 * Server Actions: validate the form, call the service, revalidate.
 *
 * Nothing here implements anything (ADR-0005). Each one reads its form,
 * validates the fields, calls one service function, and turns the outcome into
 * a redirect or a message. Parsing input is transport work and belongs here;
 * anything that computes money, decides a permission or knows a ledger rule
 * does not. The permission check lives in the service, so it cannot be skipped
 * by adding another caller.
 */

export interface ActionResult {
  readonly error?: string;
  /**
   * The category a rule gave what was just recorded, when one did.
   *
   * Returned so the confirmation can say it. A rule that files a movement
   * without a word is the same rule working invisibly, and this screen has no
   * preview to show it on the way in the way the import does.
   */
  readonly filedUnder?: string;
}

/**
 * Turns a service refusal into something a form can display.
 *
 * A service message is passed through rather than replaced. "This transaction
 * does not balance" and "you may not do that" are different problems, and
 * flattening both into one translated sentence would hide which one occurred.
 * The fallback is translated because it is the only case with nothing to say.
 */
export async function createHouseholdAction(formData: FormData): Promise<ActionResult> {
  await ensureTenantIsolation();
  // requireSessionUser, not requireContext: this is the flow for someone who
  // has no household yet, so demanding one here would make it unreachable.
  const user = await requireSessionUser();

  const t = await getTranslations('setup');
  const accounts = await getTranslations('starterAccounts');
  const name = String(formData.get('name') ?? '').trim();
  if (name === '') return { error: t('nameRequired') };

  // Minted here rather than by the database: the tenant has to be declared
  // before the row defining it can satisfy its own INSERT policy.
  const newId = householdId(randomUUID());

  try {
    await withHousehold(getAuthDbClient(), { householdId: newId, userId: user.userId }, (tx) =>
      createHousehold(tx, {
        householdId: newId,
        name,
        baseCurrency: String(formData.get('currency') ?? defaultBaseCurrency()).trim(),
        ownerUserId: user.userId,
        ownerDisplayName: user.displayName,
        accountNames: {
          current: accounts('current'),
          savings: accounts('savings'),
          opening: accounts('opening'),
        },
      }),
    );
  } catch (error) {
    return { error: await toMessage(error) };
  }

  redirect('/app');
}

export async function quickAddAction(formData: FormData): Promise<ActionResult> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();

  const from = String(formData.get('from') ?? '');
  const to = String(formData.get('to') ?? '');
  // A comma is what a French keyboard produces for a decimal point, and
  // rejecting it would be rejecting the way the target user writes numbers.
  const amount = String(formData.get('amount') ?? '')
    .replace(',', '.')
    .trim();
  const description = String(formData.get('description') ?? '').trim();
  const on = String(formData.get('bookedOn') ?? '');

  const t = await getTranslations('quickAdd');
  if (from === '' || to === '') return { error: t('bothAccounts') };
  if (from === to) return { error: t('sameAccount') };
  if (!/^\d+(\.\d+)?$/.test(amount) || amount === '0') {
    return { error: t('invalidAmount') };
  }

  let filedUnder: string | undefined;

  try {
    await scoped(async (tx) => {
      // The accounts' own currency, not the household's and not a literal.
      // Written as `'EUR'` here, a transfer between two dollar accounts posted
      // two euro entries against them: balanced, accepted, and silently wrong
      // in every balance afterwards.
      const balances = await accountBalances(tx, actor);
      const source = balances.find((account) => account.accountId === from);
      const target = balances.find((account) => account.accountId === to);
      if (source === undefined || target === undefined) throw new AccountsMissingError();

      // Two accounts in different currencies are not checked here. Posting in
      // the source's currency makes the other entry disagree with its own
      // account, and `postTransaction` refuses that by name - one rule, in the
      // domain, saying which account and which two currencies. A second check
      // here would be a second wording of it, free to drift.
      const code = source.currency;
      const id = transactionId(randomUUID());
      await postTransaction(tx, actor, {
        id,
        bookedOn: on === '' ? todayIn() : ledgerDate(on),
        kind: 'transfer',
        ...(description === '' ? {} : { description }),
        // Two lines with opposite signs: the smallest balanced transaction
        // there is. The service validates it anyway.
        entries: [
          { accountId: accountId(from), amount: Money.of(`-${amount}`, code) },
          { accountId: accountId(to), amount: Money.of(amount, code) },
        ],
      });

      // The rules, on what was just written. An import runs them as its step
      // seven and this did not run them at all, so a rule somebody wrote
      // applied to their statements and not to what they typed - which is a
      // difference about how a movement arrived, and rules are not about that.
      //
      // Inside the same unit of work: a categorisation that fails takes the
      // movement with it rather than leaving it half recorded.
      const filed = await applyRules(tx, actor, { transactionId: id });
      filedUnder = filed.byCategory[0]?.name;
    });
  } catch (error) {
    return { error: await toMessage(error) };
  }

  revalidatePath('/app');
  return filedUnder === undefined ? {} : { filedUnder };
}

/**
 * Account management, one service call each.
 *
 * The id arrives from a hidden field, which sounds like a way to reach another
 * household's account. It is not: the service runs inside `scoped`, so
 * row-level security narrows every statement to the caller's household, and an
 * id from elsewhere matches no row and comes back as not-found (ADR-0007).
 */
export async function createAccountAction(formData: FormData): Promise<ActionResult> {
  await ensureTenantIsolation();
  // The household's own currency, not the instance's default: an account
  // created without one belongs to this household, and this household has
  // already answered the question once.
  const { actor, baseCurrency } = await requireContext();

  const t = await getTranslations('accounts');
  const name = String(formData.get('name') ?? '').trim();
  if (name === '') return { error: t('nameRequired') };

  try {
    await scoped((tx) =>
      createAccount(tx, actor, {
        name,
        kind: String(formData.get('kind') ?? ''),
        currency: String(formData.get('currency') ?? baseCurrency),
        institution: String(formData.get('institution') ?? ''),
      }),
    );
  } catch (error) {
    return { error: await toMessage(error) };
  }

  revalidatePath('/app/accounts');
  revalidatePath('/app');
  return {};
}

export async function renameAccountAction(formData: FormData): Promise<ActionResult> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();

  const t = await getTranslations('accounts');
  const name = String(formData.get('name') ?? '').trim();
  if (name === '') return { error: t('nameRequired') };

  try {
    await scoped((tx) => renameAccount(tx, actor, accountId(String(formData.get('id'))), name));
  } catch (error) {
    return { error: await toMessage(error) };
  }

  revalidatePath('/app/accounts');
  revalidatePath('/app');
  return {};
}

export async function closeAccountAction(formData: FormData): Promise<ActionResult> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();

  try {
    await scoped((tx) => closeAccount(tx, actor, accountId(String(formData.get('id'))), todayIn()));
  } catch (error) {
    return { error: await toMessage(error) };
  }

  revalidatePath('/app/accounts');
  revalidatePath('/app');
  return {};
}

export async function reopenAccountAction(formData: FormData): Promise<ActionResult> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();

  try {
    await scoped((tx) => reopenAccount(tx, actor, accountId(String(formData.get('id')))));
  } catch (error) {
    return { error: await toMessage(error) };
  }

  revalidatePath('/app/accounts');
  revalidatePath('/app');
  return {};
}

/**
 * Undo, the only way a ledger allows one: by adding the opposite.
 *
 * The reversal's id is minted here rather than by the database, for the same
 * reason every other write does it - the domain builds the transaction before
 * anything is inserted, and it needs the id to do that.
 */
export async function reverseTransactionAction(formData: FormData): Promise<ActionResult> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();

  try {
    await scoped((tx) =>
      reverseTransactionById(
        tx,
        actor,
        transactionId(String(formData.get('id'))),
        transactionId(randomUUID()),
        todayIn(),
      ),
    );
  } catch (error) {
    return { error: await toMessage(error) };
  }

  revalidatePath('/app/transactions');
  revalidatePath('/app');
  revalidatePath('/app/accounts');
  return {};
}
