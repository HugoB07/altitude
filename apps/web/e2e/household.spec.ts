import { expect, test, type Page } from '@playwright/test';

/**
 * One journey, end to end, against a real database.
 *
 * Sign up, create a household, add an account, move money, and read the number
 * back. Every screen the application has is rendered on the way through, which
 * is the point: the bug that prompted this suite compiled, typechecked, linted
 * and built, and threw on first render. Nothing but rendering it could catch it.
 *
 * Written as a single test rather than five, because each step depends on the
 * one before it. Five tests sharing state are five tests that fail together and
 * report four confusing failures alongside the real one.
 */

/** Unique per run, so a rerun against a surviving database still signs up. */
const stamp = Date.now();
const EMAIL = `claire-${stamp}@example.test`;
const PASSWORD = 'correct horse battery staple';
const HOUSEHOLD = 'Vasseur';

/** The interface follows Accept-Language; the assertions below read English. */
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

test('a household is created, funded and read back', async ({ page }) => {
  await expectNoConsoleErrors(page, async () => {
    // --- Sign up -----------------------------------------------------------
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Altitude' })).toBeVisible();

    // Two controls, deliberately named differently: the one that switches the
    // form and the one that submits it. They read the same in French until this
    // suite made someone look at them.
    await page.getByRole('button', { name: 'New here? Sign up' }).click();
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account', exact: true }).click();

    // --- The household this account has none of ------------------------------
    await page.waitForURL('**/setup');
    await page.getByLabel('Household name').fill(HOUSEHOLD);
    await page.getByRole('button', { name: 'Create household' }).click();

    // --- The dashboard, empty -----------------------------------------------
    await page.waitForURL('**/app');
    await expect(page.getByText('Net worth')).toBeVisible();
    // Three starter accounts, and nothing has moved yet.
    await expect(page.getByText('€0.00').first()).toBeVisible();

    // --- An account ----------------------------------------------------------
    await page.getByRole('link', { name: /manage accounts/i }).click();
    await page.waitForURL('**/app/accounts');

    await page.getByRole('button', { name: 'New account' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Name').fill('Livret A');
    await dialog.getByRole('button', { name: 'Add account' }).click();

    // The toast is the confirmation, and its absence is a real failure: the
    // dialog closing on its own would look identical to a cancelled one.
    await expect(page.getByText('Account created')).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Livret A')).toBeVisible();
  });
});

test('money moved between accounts leaves net worth alone', async ({ page }) => {
  await expectNoConsoleErrors(page, async () => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/app');

    // --- Money in -----------------------------------------------------------
    // From the opening balance account into an asset: this is the one
    // transaction that changes net worth, and the amount it changes it by.
    await deposit(page, 'Opening balances', 'Current account', '1000');
    await expect(page.getByText('€1,000.00').first()).toBeVisible();

    // --- Money moved --------------------------------------------------------
    // The claim the whole product rests on (ADR-0002): an internal transfer
    // must not inflate net worth. A flat transactions table reports 1,300 here.
    await deposit(page, 'Current account', 'Livret A', '300');

    await expect(page.getByText('€1,000.00').first()).toBeVisible();
    await expect(page.getByText('€1,300.00')).toHaveCount(0);

    // And the money did move, which is the other half of the same claim.
    await expect(page.getByText('€700.00')).toBeVisible();
    await expect(page.getByText('€300.00').first()).toBeVisible();
  });
});

test('a mistake is corrected by adding its opposite, not by editing it', async ({ page }) => {
  await expectNoConsoleErrors(page, async () => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/app');

    const worth = '€1,000.00';

    // A transaction that should not have happened.
    await deposit(page, 'Opening balances', 'Current account', '250', 'A mistake');
    await expect(page.getByText('€1,250.00').first()).toBeVisible();

    await page.goto('/app/transactions');
    const mistake = page.locator('li', { hasText: 'A mistake' }).first();
    await expect(mistake).toBeVisible();
    // A two-sided movement is shown as the sentence it is, with both accounts
    // named: the money came from somewhere, which is the point of ADR-0002.
    await expect(mistake.getByText('€250.00')).toBeVisible();
    await expect(mistake.getByText('Opening balances')).toBeVisible();
    await expect(mistake.getByText('Current account')).toBeVisible();

    await mistake.getByRole('button', { name: 'Reverse' }).click();
    await expect(page.getByText('Transaction reversed')).toBeVisible();

    // Nothing was deleted. The original is still there, now marked, and the
    // entry that cancelled it sits beside it.
    await expect(page.getByText('A mistake')).toBeVisible();
    await expect(page.getByText('reversed').first()).toBeVisible();
    await expect(page.getByText('reverses an earlier transaction')).toBeVisible();

    // A page number past the end is an empty page, not a crash. That is the
    // path a stale bookmark takes after a reversal shortens the ledger.
    await page.goto('/app/transactions?page=99');
    await expect(page.getByRole('heading', { name: 'Transactions' })).toBeVisible();

    // And the number went back to where it was.
    await page.goto('/app');
    await expect(page.getByText(worth).first()).toBeVisible();
    await expect(page.getByText('€1,250.00')).toHaveCount(0);
  });
});

/** Opens the dialog, fills it, and waits for the confirmation. */
async function deposit(page: Page, from: string, to: string, amount: string, description?: string) {
  await page.getByRole('button', { name: 'Move money' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('From').click();
  await page.getByRole('option', { name: from, exact: true }).click();
  await dialog.getByLabel('To').click();
  await page.getByRole('option', { name: to, exact: true }).click();

  await dialog.getByLabel('Amount').fill(amount);
  if (description !== undefined) await dialog.getByLabel('Description').fill(description);
  await dialog.getByRole('button', { name: 'Record' }).click();

  await expect(page.getByText('Transaction recorded')).toBeVisible();
  await expect(dialog).toBeHidden();
}
