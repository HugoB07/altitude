'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
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
 * Nothing here implements anything (ADR-0005). Each one translates a form
 * submission into a service call, and the twenty-line limit in that ADR is the
 * review rule that keeps it that way. The permission check lives in the
 * service, so it cannot be skipped by adding another caller.
 */

export interface ActionResult {
  readonly error?: string;
}

/** Turns a service refusal into something a form can display. */
function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export async function createHouseholdAction(formData: FormData): Promise<ActionResult> {
  await ensureTenantIsolation();
  // requireSessionUser, not requireContext: this is the flow for someone who
  // has no household yet, so demanding one here would make it unreachable.
  const user = await requireSessionUser();

  const name = String(formData.get('name') ?? '').trim();
  if (name === '') return { error: 'Give the household a name.' };

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
      }),
    );
  } catch (error) {
    return { error: toMessage(error) };
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

  if (from === '' || to === '') return { error: 'Choose both accounts.' };
  if (from === to) return { error: 'The two accounts must be different.' };
  if (!/^\d+(\.\d+)?$/.test(amount) || amount === '0') {
    return { error: 'Enter an amount using digits.' };
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
    return { error: toMessage(error) };
  }

  revalidatePath('/app');
  return {};
}
