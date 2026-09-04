import { expect, test, type Page } from '@playwright/test';

/**
 * Step 7 of the import pipeline, from an empty household to a categorised
 * ledger (plan §8.6).
 *
 * One journey rather than five tests, for the reason the household suite gives:
 * each step needs the one before it, and five tests sharing state report four
 * confusing failures alongside the real one.
 *
 * What it is really checking is that nothing here happens on its own. A rule
 * exists because somebody wrote it, a pass happens because somebody pressed a
 * button, and the count comes before the act.
 */

const stamp = Date.now();
const EMAIL = `remi-${stamp}@example.test`;
const PASSWORD = 'correct horse battery staple';
const HOUSEHOLD = 'Lanvin';

test.use({ locale: 'en-GB' });

async function expectNoConsoleErrors(page: Page, run: () => Promise<void>) {
  const errors: string[] = [];
  const onConsole = (message: { type: () => string; text: () => string }) => {
    if (message.type() === 'error') errors.push(message.text());
  };
  page.on('console', onConsole);
  page.on('pageerror', (error) => errors.push(error.message));
  await run();
  page.off('console', onConsole);
  expect(errors, 'the browser reported errors while rendering').toEqual([]);
}

test('a rule is written, previewed, applied, and shows on the transaction', async ({ page }) => {
  await expectNoConsoleErrors(page, async () => {
    // --- A household with one movement in it -------------------------------
    await page.goto('/login');
    await page.getByRole('button', { name: 'New here? Sign up' }).click();
    await page.getByLabel('Name').fill('Remi');
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByRole('heading', { name: 'Create your household' })).toBeVisible();
    await page.getByLabel('Household name').fill(HOUSEHOLD);
    await page.getByRole('button', { name: 'Create household' }).click();
    await page.waitForURL('**/app');
    await expect(page.getByText('Net worth')).toBeVisible();

    // Money out of the current account, worded the way a card payment is.
    await page.getByRole('button', { name: 'Move money' }).click();
    const move = page.getByRole('dialog');
    await move.getByLabel('From').click();
    await page.getByRole('option', { name: 'Current account', exact: true }).click();
    await move.getByLabel('To').click();
    await page.getByRole('option', { name: 'Savings', exact: true }).click();
    await move.getByLabel('Amount').fill('54,90');
    await move.getByLabel('Description').fill('CARTE 12/03 CARREFOUR MARKET 4972');
    await move.getByRole('button', { name: 'Record' }).click();
    await expect(move).toBeHidden();

    // --- A category and a rule ---------------------------------------------
    await page.goto('/app/categories');
    await expect(page.getByRole('heading', { name: 'Categories', level: 1 })).toBeVisible();

    await page.getByLabel('Category name').fill('Groceries');
    await page.getByRole('button', { name: 'Add category' }).click();
    await expect(page.getByText('Groceries').first()).toBeVisible();

    await page.getByLabel('What this rule is for').fill('Supermarkets');
    // Written against the normalised label, which is why no date and no card
    // number appear in it even though both are in the description above.
    await page.getByLabel('Words to look for').fill('carrefour|leclerc');
    await page.getByLabel('Files it under').click();
    await page.getByRole('option', { name: 'Groceries' }).click();
    // A tag, so the rule form has one to offer.
    await page.getByLabel('Tag name').fill('spain-2027');
    await page.getByRole('button', { name: 'Add tag' }).click();
    await expect(page.getByText('spain-2027').first()).toBeVisible();

    await page.getByRole('button', { name: 'Add rule' }).click();
    await expect(page.getByText('carrefour|leclerc')).toBeVisible();

    // --- A rule with no category at all ------------------------------------
    /**
     * Which is why the column stopped being mandatory. A rule that marks every
     * line of a trip decides no category, and refusing it would mean tags could
     * only ever be applied by hand.
     */
    await page.getByLabel('What this rule is for').fill('Trip');
    await page.getByLabel('Words to look for').fill('madrid|barcelona');
    // Inside the rule's own "then" block: the tag also appears in the list
    // above, where the same name is a delete button.
    await page
      .getByRole('group', { name: /Then do this/ })
      .getByRole('button', { name: 'spain-2027' })
      .click();
    await page.getByRole('button', { name: 'Add rule' }).click();
    await expect(page.getByText('madrid|barcelona')).toBeVisible();

    // --- The count comes before the act ------------------------------------
    await page.getByRole('button', { name: 'See what would change' }).click();
    await expect(page.getByText('1 entry would change')).toBeVisible();
    await expect(page.getByText('1 entry into Groceries')).toBeVisible();

    // Nothing written yet: the transaction is still uncategorised.
    await page.goto('/app/transactions');
    await expect(page.getByText('CARTE 12/03 CARREFOUR MARKET 4972')).toBeVisible();
    await expect(page.getByText('Groceries')).toHaveCount(0);

    // --- Applied ------------------------------------------------------------
    await page.goto('/app/categories');
    await page.getByRole('button', { name: 'See what would change' }).click();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByText('1 entry categorised')).toBeVisible();

    await page.goto('/app/transactions');
    await expect(page.getByText('Groceries').first()).toBeVisible();

    // --- Filing one by hand, and being offered a rule for the rest ---------
    /**
     * What the plan calls explicit learning (§8.6).
     *
     * The offer is an offer: the pattern is suggested from the description,
     * and nothing is written until somebody presses. A tool that quietly wrote
     * a rule every time you corrected it is a tool you stop correcting.
     */
    await page.goto('/app/categories');
    await page.getByLabel('Category name').fill('Household');
    await page.getByRole('button', { name: 'Add category' }).click();
    await expect(page.getByText('Household').first()).toBeVisible();

    await page.goto('/app/transactions');
    await page.getByLabel('File under').first().click();
    await page.getByRole('option', { name: 'Household' }).click();
    await expect(page.getByText('Filed under Household')).toBeVisible();

    // Suggested from "CARTE 12/03 CARREFOUR MARKET 4972": no date, no card
    // number, no word the bank writes on every line.
    await page.getByRole('button', { name: 'Make a rule' }).click();
    await expect(page.getByText('Rule added for CARREFOUR MARKET')).toBeVisible();

    // --- And a pass does not undo what a person decided --------------------
    await page.goto('/app/categories');
    await page.getByRole('button', { name: 'See what would change' }).click();
    await expect(page.getByText('Nothing would change')).toBeVisible();

    await page.goto('/app/transactions');
    await expect(page.getByText('Household').first()).toBeVisible();

    // --- Removing a category takes its rules with it -----------------------
    await page.goto('/app/categories');
    await expect(page.getByText('CARREFOUR MARKET')).toBeVisible();

    await page.getByRole('button', { name: 'Delete Household' }).click();
    await expect(page.getByText('Category deleted')).toBeVisible();

    // The rule that filed into it is gone too: one that cannot be applied
    // would be a line in the list that does nothing.
    await expect(page.getByText('CARREFOUR MARKET')).toHaveCount(0);
    // And the transaction keeps its history, without the label.
    await page.goto('/app/transactions');
    await expect(page.getByText('Household')).toHaveCount(0);

    // --- And a movement typed by hand is filed as it is written ------------
    /**
     * After the steps above rather than beside the import, and that is not
     * cosmetic: this records a second movement dated today, and the step that
     * files one by hand takes `.first()` on a list ordered by date. Two rows
     * on one day are separated by a random id, so placed earlier this made
     * that step pick either of them.
     *
     * An import runs the rules as its step seven, and this used not to run
     * them at all - so a rule somebody wrote applied to their statements and
     * not to what they typed. That is a difference about how a movement
     * arrived, and a rule is not about that.
     *
     * Said out loud, because there is no preview on the way in here the way
     * there is for an import: this toast is the only place a person learns
     * that something other than them chose the category.
     */
    await page.goto('/app');
    await page.getByRole('button', { name: 'Move money' }).click();
    const again = page.getByRole('dialog');
    await again.getByLabel('From').click();
    await page.getByRole('option', { name: 'Current account', exact: true }).click();
    await again.getByLabel('To').click();
    await page.getByRole('option', { name: 'Savings', exact: true }).click();
    await again.getByLabel('Amount').fill('31,20');
    await again.getByLabel('Description').fill('CB E.LECLERC DRIVE 8820');
    await again.getByRole('button', { name: 'Record' }).click();

    await expect(page.getByText('a rule filed it under Groceries')).toBeVisible();

    // --- And the rules that came with the application ----------------------
    /**
     * The plan's community set (§8.6): rules nobody in this household wrote,
     * running after the household's own and only filling what they left empty.
     * Off until it is turned on, which is the point of the first assertion.
     */
    await page.goto('/app/categories');

    // Every rule this household wrote, gone. What is left is the state the set
    // exists for: somebody who has written nothing.
    const remove = page.getByRole('button', { name: 'Delete this rule' });
    // Counted down rather than iterated: the list re-renders after each delete,
    // so a snapshot of the buttons goes stale on the second one.
    for (let left = await remove.count(); left > 0; left -= 1) {
      await remove.first().click();
      await expect(remove).toHaveCount(left - 1);
    }

    // And with no rules at all there is nothing to run, which the control says
    // by being unavailable rather than by failing when pressed.
    await expect(page.getByRole('button', { name: 'See what would change' })).toBeDisabled();

    await expect(page.getByText('No set is in use.')).toBeVisible();
    await page.getByRole('button', { name: 'Use the France set' }).click();
    await expect(page.getByText(/rules from the France set/)).toBeVisible();

    // A shipped rule names a category by key, and this household has no row
    // carrying one - so it would name the shop and file nothing. The screen
    // says so rather than looking broken.
    await expect(page.getByText(/categories it needs are missing/)).toBeVisible();
    await page.getByRole('button', { name: 'Add the missing categories' }).click();
    await expect(page.getByText('Every category it needs exists.')).toBeVisible();

    // Folded, so the sixty-two rules do not push the button that runs them a
    // screen and a half down the page. Hidden rather than absent: a closed
    // <details> keeps its contents in the document, which is what makes them
    // findable by a browser's own search.
    await expect(page.getByText('E.Leclerc', { exact: true })).toBeHidden();
    await page.getByText('The 62 rules').click();
    // Grouped by what they file under, so the effect is said once per group
    // rather than stranded at the right edge of every row.
    await expect(page.getByRole('term').filter({ hasText: 'Groceries' })).toBeVisible();
    await expect(page.getByText('E.Leclerc', { exact: true })).toBeVisible();

    // The count comes before the act here too - and the control is live again,
    // on sixty-two rules this household did not write. Counting only its own
    // was the bug: a set turned on, and a button that did nothing.
    await expect(page.getByRole('button', { name: 'See what would change' })).toBeEnabled();
    await page.getByRole('button', { name: 'See what would change' }).click();
    await expect(page.getByText(/entry would change|entries would change/)).toBeVisible();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByText(/entry categorised|entries categorised/)).toBeVisible();

    // "CARTE 12/03 CARREFOUR MARKET 4972", read by rules this household never
    // wrote. The shop is the part only the set could give: it comes from a
    // label that also carries a date and a card number, and no category
    // answers "how much at Carrefour".
    await page.goto('/app/transactions');
    await expect(page.getByLabel('File under').first()).toContainText('Groceries');
    await expect(page.getByText('Carrefour').first()).toBeVisible();
  });
});
