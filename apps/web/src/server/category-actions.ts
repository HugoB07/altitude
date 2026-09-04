'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import {
  addStandardCategories,
  applyRules,
  createCategory,
  createRule,
  createTag,
  deleteCategory,
  deleteRule,
  deleteTag,
  listCategories,
  listRules,
  ruleSetFor,
  setRuleSet,
  setTransactionCategory,
  setTransactionTags,
  suggestPattern,
  type ApplyResult,
} from '@altitude/core';
import { categoryId, isUuid } from '@altitude/shared';
import { toMessage } from './errors';
import { requireContext, scoped } from './context';
import { ensureTenantIsolation } from './startup';

/**
 * Categories and the rules that decide them (plan §8.6).
 *
 * Every one of these re-reads what it needs rather than trusting the form.
 * The browser says which rule to delete or which name to add; what that means
 * is worked out here, under the household the session is scoped to.
 */

export interface CategoryOutcome {
  readonly error?: string;
  readonly ok?: true;
}

/**
 * Turns a country's rule set on, or off.
 *
 * Nothing happens by itself: the rules run on the next import or the next
 * deliberate pass, both of which say what they did. Turning it off leaves every
 * categorisation it made in place - they were decisions, and withdrawing a set
 * is not a reason to undo them behind somebody's back. The next pass will
 * simply stop making new ones.
 */
export async function setRuleSetAction(formData: FormData): Promise<CategoryOutcome> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();
  const t = await getTranslations('categories');

  const country = String(formData.get('country') ?? '').trim();

  try {
    const done = await scoped((tx) => setRuleSet(tx, actor, country === '' ? null : country));
    if (!done) return { error: t('noSuchRuleSet') };
    revalidatePath('/app/categories');
    return { ok: true };
  } catch (error) {
    return { error: await toMessage(error) };
  }
}

/**
 * Creates the categories the active set points at.
 *
 * Named here rather than in the set, and that is the whole reason a set ships
 * keys instead of names: `groceries` is written "Courses" for a French reader
 * and "Groceries" for an English one, from the same file, and one shipped rule
 * points at both (ADR-0010).
 */
export async function addStandardCategoriesAction(): Promise<CategoryOutcome> {
  await ensureTenantIsolation();
  const { actor, ruleSet } = await requireContext();
  const t = await getTranslations('categories');

  const set = ruleSetFor(ruleSet);
  if (set === undefined) return { error: t('noSuchRuleSet') };

  try {
    await scoped((tx) =>
      addStandardCategories(
        tx,
        actor,
        set.categories.map((key) => ({
          key,
          name: t(`key.${key}`),
          id: categoryId(randomUUID()),
        })),
      ),
    );
    revalidatePath('/app/categories');
    return { ok: true };
  } catch (error) {
    return { error: await toMessage(error) };
  }
}

export async function createCategoryAction(formData: FormData): Promise<CategoryOutcome> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();
  const t = await getTranslations('categories');

  const name = String(formData.get('name') ?? '').trim();
  if (name === '') return { error: t('nameRequired') };

  try {
    const made = await scoped((tx) =>
      createCategory(tx, actor, { id: categoryId(randomUUID()), name }),
    );
    if (made === null) return { error: t('nameRequired') };
    revalidatePath('/app/categories');
    return { ok: true };
  } catch (error) {
    return { error: await toMessage(error) };
  }
}

export async function createRuleAction(formData: FormData): Promise<CategoryOutcome> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();
  const t = await getTranslations('categories');

  const name = String(formData.get('name') ?? '').trim();
  const pattern = String(formData.get('pattern') ?? '').trim();
  const category = String(formData.get('categoryId') ?? '');
  const counterparty = String(formData.get('counterparty') ?? '').trim();
  const tagIds = String(formData.get('tagIds') ?? '')
    .split(',')
    .filter((id) => isUuid(id));
  const priority = Number(formData.get('priority') ?? '100');
  const direction = String(formData.get('direction') ?? 'any');

  // A condition, and at least one of the three effects. A rule that files
  // nothing, names nobody and tags nothing is a rule that does nothing.
  if (name === '' || pattern === '') return { error: t('ruleIncomplete') };
  if (category === '' && counterparty === '' && tagIds.length === 0) {
    return { error: t('ruleIncomplete') };
  }

  /**
   * The sign, as a question rather than a pair of number fields.
   *
   * "Money out" is the condition almost every rule wants and nobody thinks to
   * write: without it a rule for the supermarket also claims the refund from
   * the supermarket. The bounds are wide because the intent is the sign, not
   * an amount - a rule about how much is a different rule.
   */
  const bounds: Record<string, readonly [string, string] | undefined> = {
    out: ['-999999999', '0'],
    in: ['0', '999999999'],
    any: undefined,
  };

  try {
    const made = await scoped((tx) =>
      createRule(tx, actor, {
        id: randomUUID(),
        name,
        priority: Number.isFinite(priority) ? priority : 100,
        conditions: {
          descriptionMatches: pattern,
          ...(bounds[direction] === undefined ? {} : { amountBetween: bounds[direction] }),
        },
        ...(category === '' ? {} : { categoryId: categoryId(category) }),
        ...(counterparty === '' ? {} : { counterparty }),
        ...(tagIds.length === 0 ? {} : { tagIds }),
      }),
    );
    // Null means the conditions did not survive being read back, which for a
    // form this small means one thing: the expression does not compile.
    if (made === null) return { error: t('patternInvalid') };

    revalidatePath('/app/categories');
    return { ok: true };
  } catch (error) {
    return { error: await toMessage(error) };
  }
}

/**
 * Removes a category, and with it the rules that filed into it.
 *
 * Said plainly on the button rather than discovered afterwards: a rule whose
 * category no longer exists could not be applied, so keeping it would leave a
 * line in the list that does nothing.
 */
export async function deleteCategoryAction(formData: FormData): Promise<CategoryOutcome> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();

  const id = String(formData.get('id') ?? '');
  if (id === '') return { ok: true };

  try {
    await scoped((tx) => deleteCategory(tx, actor, id));
    revalidatePath('/app/categories');
    revalidatePath('/app/transactions');
    return { ok: true };
  } catch (error) {
    return { error: await toMessage(error) };
  }
}

export async function deleteRuleAction(formData: FormData): Promise<CategoryOutcome> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();

  const id = String(formData.get('id') ?? '');
  if (id === '') return { ok: true };

  try {
    await scoped((tx) => deleteRule(tx, actor, id));
    revalidatePath('/app/categories');
    return { ok: true };
  } catch (error) {
    return { error: await toMessage(error) };
  }
}

export interface ApplyOutcome {
  readonly error?: string;
  readonly result?: ApplyResult;
}

/**
 * What a pass would change, or what it changed.
 *
 * Two actions rather than one with a flag, because the difference matters at
 * the call site: one of them writes. The plan asks for the count to come
 * first (§8.6), and the preview runs the same code path so the number is what
 * would happen rather than an estimate of it.
 */
export async function previewRulesAction(): Promise<ApplyOutcome> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();

  try {
    return { result: await scoped((tx) => applyRules(tx, actor, { preview: true })) };
  } catch (error) {
    return { error: await toMessage(error) };
  }
}

export async function applyRulesAction(): Promise<ApplyOutcome> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();

  try {
    const result = await scoped((tx) => applyRules(tx, actor));
    revalidatePath('/app/categories');
    revalidatePath('/app/transactions');
    return { result };
  } catch (error) {
    return { error: await toMessage(error) };
  }
}

/**
 * Files one transaction by hand, and offers a rule for the ones like it.
 *
 * The offer is the plan's explicit learning (§8.6): the pattern is suggested
 * from the description this transaction carries, and nothing is written from
 * it until somebody asks. A tool that quietly wrote a rule every time you
 * corrected it would be a tool you stop correcting.
 */
export async function setCategoryAction(
  formData: FormData,
): Promise<CategoryOutcome & { readonly suggestion?: string }> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();

  const transaction = String(formData.get('transactionId') ?? '');
  const category = String(formData.get('categoryId') ?? '');
  const description = String(formData.get('description') ?? '');
  if (transaction === '') return { ok: true };

  try {
    await scoped((tx) =>
      setTransactionCategory(tx, actor, {
        transactionId: transaction,
        categoryId: category === '' ? null : categoryId(category),
      }),
    );
    revalidatePath('/app/transactions');

    const suggestion = description === '' ? '' : suggestPattern(description);
    return suggestion === '' ? { ok: true } : { ok: true, suggestion };
  } catch (error) {
    return { error: await toMessage(error) };
  }
}

/** Replaces the tags on one transaction with the set that was ticked. */
export async function setTagsAction(formData: FormData): Promise<CategoryOutcome> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();

  const transactionId = String(formData.get('transactionId') ?? '');
  if (!isUuid(transactionId)) return { ok: true };

  const tagIds = String(formData.get('tagIds') ?? '')
    .split(',')
    .filter((id) => isUuid(id));

  try {
    await scoped((tx) => setTransactionTags(tx, actor, { transactionId, tagIds }));
    revalidatePath('/app/transactions');
    return { ok: true };
  } catch (error) {
    return { error: await toMessage(error) };
  }
}

export async function createTagAction(formData: FormData): Promise<CategoryOutcome> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();
  const t = await getTranslations('categories');

  const name = String(formData.get('name') ?? '').trim();
  if (name === '') return { error: t('nameRequired') };

  try {
    const made = await scoped((tx) => createTag(tx, actor, { id: randomUUID(), name }));
    if (made === null) return { error: t('nameRequired') };
    revalidatePath('/app/categories');
    revalidatePath('/app/transactions');
    return { ok: true };
  } catch (error) {
    return { error: await toMessage(error) };
  }
}

/** Removes a tag, and every mark it made. The database cascades both. */
export async function deleteTagAction(formData: FormData): Promise<CategoryOutcome> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();

  const id = String(formData.get('id') ?? '');
  if (id === '') return { ok: true };

  try {
    await scoped((tx) => deleteTag(tx, actor, id));
    revalidatePath('/app/categories');
    revalidatePath('/app/transactions');
    return { ok: true };
  } catch (error) {
    return { error: await toMessage(error) };
  }
}

/** What the page needs, read once. */
export async function readCategoryPage() {
  await ensureTenantIsolation();
  const { actor } = await requireContext();

  return scoped(async (tx) => ({
    categories: await listCategories(tx, actor),
    rules: await listRules(tx, actor),
  }));
}
