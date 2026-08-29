'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { createHousehold, postTransaction } from '@altitude/core';
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
}

/**
 * Turns a service refusal into something a form can display.
 *
 * A service message is passed through rather than replaced. "This transaction
 * does not balance" and "you may not do that" are different problems, and
 * flattening both into one translated sentence would hide which one occurred.
 * The fallback is translated because it is the only case with nothing to say.
 */
async function toMessage(error: unknown): Promise<string> {
  if (error instanceof Error) return error.message;
  const t = await getTranslations('quickAdd');
  return t('genericError');
}

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
        baseCurrency: String(formData.get('currency') ?? 'EUR').trim(),
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

  try {
    await scoped((tx) =>
      postTransaction(tx, actor, {
        id: transactionId(randomUUID()),
        bookedOn: on === '' ? todayIn() : ledgerDate(on),
        kind: 'transfer',
        ...(description === '' ? {} : { description }),
        // Two lines with opposite signs: the smallest balanced transaction
        // there is. The service validates it anyway.
        entries: [
          { accountId: accountId(from), amount: Money.of(`-${amount}`, 'EUR') },
          { accountId: accountId(to), amount: Money.of(amount, 'EUR') },
        ],
      }),
    );
  } catch (error) {
    return { error: await toMessage(error) };
  }

  revalidatePath('/app');
  return {};
}
