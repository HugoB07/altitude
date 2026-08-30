import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * A file from a bank, read, reviewed and written.
 *
 * The whole point of the import screen is that nothing enters the ledger until
 * a person has looked at it, so the assertions are about what is shown before
 * the button is pressed as much as about what the balances say afterwards.
 *
 * Its own household, not the one `household.spec.ts` builds: the numbers below
 * are the file's alone, and sharing a ledger would make them a sum of two
 * tests. The suite runs one worker at a time, so this costs a signup and buys
 * arithmetic anybody can check against the fixture.
 *
 * One page for the whole file, opened once and kept. Signing in per test looked
 * tidier and hit the sign-in rate limiter on the fourth attempt across the
 * suite - reported on screen as "too many requests", which is the limiter doing
 * its job on tests that were behaving like an attack. It is also closer to how
 * the screen is used: somebody signs in once and then imports.
 */
test.describe.configure({ mode: 'serial' });

const stamp = Date.now();
const EMAIL = `noe-${stamp}@example.test`;
const PASSWORD = 'correct horse battery staple';

/**
 * A file in the shape the broker actually exports: commas, every field quoted,
 * ISO dates. Invented figures - SECURITY.md and CONTRIBUTING are explicit that
 * real financial data never enters the repository, and a fixture is exactly
 * where it would slip in unnoticed.
 *
 * The shape is the point. A reader that assumed semicolons parsed each line
 * into one field and reported the file as "not a Trade Republic export".
 */
// `__dirname`, not `import.meta`: Playwright transpiles specs to CommonJS.
const FIXTURE = join(__dirname, 'fixtures', 'trade-republic.csv');
/** Two rows the file describes identically and that are not the same kind of thing. */
const TWO_SOURCES = join(__dirname, 'fixtures', 'trade-republic-two-sources.csv');

test.use({ locale: 'en-GB' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ locale: 'en-GB' });
});

test.afterAll(async () => {
  await page.close();
});

async function expectNoConsoleErrors(run: () => Promise<void>) {
  const errors: string[] = [];
  const onConsole = (message: { type: () => string; text: () => string }) => {
    if (message.type() === 'error') errors.push(message.text());
  };
  const onError = (error: Error) => errors.push(error.message);

  page.on('console', onConsole);
  page.on('pageerror', onError);
  await run();
  // Both removed. The page outlives the test, so a listener left behind would
  // report the next test's errors against this one - and keep doing it.
  page.off('console', onConsole);
  page.off('pageerror', onError);

  expect(errors, 'the browser reported errors while rendering').toEqual([]);
}

/** Picks the account named `name` for the file's label `label`. */
async function bind(label: string, name: string) {
  await page.getByLabel(label, { exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}

test('a bank export is read, reviewed and written into the ledger', async () => {
  await expectNoConsoleErrors(async () => {
    // --- A household of its own ---------------------------------------------
    await page.goto('/login');
    await page.getByRole('button', { name: 'New here? Sign up' }).click();
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account', exact: true }).click();

    await page.waitForURL('**/setup');
    await page.getByLabel('Household name').fill('Ferrand');
    await page.getByRole('button', { name: 'Create household' }).click();
    await page.waitForURL('**/app');

    // --- The bank ------------------------------------------------------------
    await page.goto('/app/import');
    await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible();

    // The path for a bank with no preset is shown and visibly inert, which is
    // the same promise the sidebar makes about the sections not built yet.
    await expect(page.getByText('Other bank')).toBeVisible();

    await page.getByRole('button', { name: 'Trade Republic' }).click();

    // --- The file ------------------------------------------------------------
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);

    // Three movements from four rows: the transfer is two lines of the file and
    // one transaction, which is the reason this preset is code and not a column
    // mapping.
    await expect(page.getByText('Virement recu')).toBeVisible();
    await expect(page.getByText('Versement epargne')).toBeVisible();
    await expect(page.getByText('Interets')).toBeVisible();
    await expect(page.getByText('from lines 3, 4')).toBeVisible();

    // Nothing has been compared to the ledger yet, and the screen says so
    // rather than calling every line new.
    await expect(
      page.getByText('Duplicates are checked once every account is chosen.'),
    ).toBeVisible();

    // --- The accounts --------------------------------------------------------
    await bind('DEFAULT', 'Current account');
    await bind('PEA', 'Savings');

    // The outside world is asked about separately, because it is not one of the
    // file's accounts: it is where each transaction's money came from.
    await expect(page.getByRole('heading', { name: 'Money from outside' })).toBeVisible();
    await expect(page.getByText('Your file does not say where')).toBeVisible();

    // Already the opening balance account, offered because that is what it
    // usually is. Asserted rather than chosen.
    await expect(page.getByLabel('Usually', { exact: true })).toContainText('Opening balances');

    // Bound, so the ledger has now been looked at - and it is empty.
    await expect(
      page.getByText('Duplicates are checked once every account is chosen.'),
    ).toBeHidden();

    // --- Write it ------------------------------------------------------------
    await page.getByRole('button', { name: 'Import 3 transactions' }).click();
    await expect(page.getByText('3 transactions imported')).toBeVisible();

    // --- The arithmetic ------------------------------------------------------
    // 500 arrived from outside and 1.06 of interest was credited net of tax.
    // The 100 moved between two of the household's own accounts is not in that
    // number, which is the claim ADR-0002 exists for.
    await page.goto('/app');
    await expect(page.getByText('€501.06').first()).toBeVisible();

    await page.goto('/app/accounts');
    await expect(page.getByText('€401.06')).toBeVisible();
    await expect(page.getByText('€100.00').first()).toBeVisible();

    // The tax is a line of its own, not folded into a net figure.
    await page.goto('/app/transactions');
    const interest = page.locator('li', { hasText: 'Interets' }).first();
    await expect(interest).toBeVisible();
  });
});

test('importing the same file twice is refused line by line, not silently', async () => {
  await expectNoConsoleErrors(async () => {
    await page.goto('/app/import');
    await page.getByRole('button', { name: 'Trade Republic' }).click();
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);

    await bind('DEFAULT', 'Current account');
    await bind('PEA', 'Savings');

    // Every row carries the provider's own identifier and every one of them is
    // already in the ledger, so all three are certain rather than probable.
    await expect(page.getByText('already imported')).toHaveCount(3);

    // And none of them is ticked: what is already there starts unselected, so
    // pressing import again by reflex does nothing.
    await expect(page.getByRole('button', { name: /^Import \d/ })).toBeDisabled();

    // The balances did not move.
    await page.goto('/app');
    await expect(page.getByText('€501.06').first()).toBeVisible();
  });
});

test('the outside world is answered per transaction, not once for the file', async () => {
  await expectNoConsoleErrors(async () => {
    // Somewhere for the money that is not income to have come from.
    await page.goto('/app/accounts');
    await page.getByRole('button', { name: 'New account' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Autre banque');
    await dialog.getByRole('button', { name: 'Add account' }).click();
    await expect(dialog).toBeHidden();

    await page.goto('/app/import');
    await page.getByRole('button', { name: 'Trade Republic' }).click();
    await page.locator('input[type="file"]').setInputFiles(TWO_SOURCES);
    await bind('DEFAULT', 'Current account');

    // Two lines the file describes identically: both are money arriving from
    // outside Trade Republic. One is a salary and one is a transfer from an
    // account of your own, and no column in the export says which.
    const salary = page.locator('li', { hasText: 'Salaire' }).first();
    const moved = page.locator('li', { hasText: 'Virement depuis autre banque' }).first();

    // Both start on the default, which is the usual answer and wrong for one.
    await expect(salary.getByRole('combobox')).toContainText('Opening balances');
    await expect(moved.getByRole('combobox')).toContainText('Opening balances');

    await moved.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Autre banque', exact: true }).click();
    await expect(moved.getByRole('combobox')).toContainText('Autre banque');
    // And the other line kept its own answer.
    await expect(salary.getByRole('combobox')).toContainText('Opening balances');

    await page.getByRole('button', { name: 'Import 2 transactions' }).click();
    await expect(page.getByText('2 transactions imported')).toBeVisible();

    // The claim, in one number. 2,300 arrived in the current account and net
    // worth went up by 2,000: the salary is income and the transfer is the same
    // money in a different place. One answer for the whole file would have
    // counted 2,300 and quietly invented 300 euros.
    await page.goto('/app');
    await expect(page.getByText('€2,501.06').first()).toBeVisible();

    await page.goto('/app/accounts');
    await expect(page.getByText('€2,701.06')).toBeVisible();
    await expect(page.getByText('-€300.00')).toBeVisible();
  });
});
