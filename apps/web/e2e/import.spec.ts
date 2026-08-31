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
/** A transfer into a PEA, a purchase inside it, and a purchase from the current account. */
const PEA = join(__dirname, 'fixtures', 'trade-republic-pea.csv');
/** Ten movements from outside, which is what it takes to overflow the dialog. */
const MANY = join(__dirname, 'fixtures', 'trade-republic-many.csv');

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

/** Chooses the bank and hands over a file, which is every import's first move. */
async function open(fixture: string) {
  await page.goto('/app/import');
  await page.getByRole('button', { name: 'Trade Republic' }).click();
  await page.locator('input[type="file"]').setInputFiles(fixture);
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

    // --- The accounts, in one press ------------------------------------------
    // The exporter's codes are shown, but they are not what is asked about: the
    // preset knows `DEFAULT` is the cash account and says so.
    await expect(
      page.getByRole('combobox', { name: /Trade Republic current account/ }),
    ).toBeVisible();
    await expect(page.getByText('DEFAULT · cash')).toBeVisible();

    // Nobody who has just installed this owns an account called PEA, so being
    // asked which of theirs it is has no answer. One press instead.
    await page.getByRole('button', { name: 'Create the 2 missing accounts' }).click();
    await expect(page.getByText('2 accounts created')).toBeVisible();

    // The outside world is folded into a sentence, because on a real file it is
    // the same answer forty times over.
    await expect(
      page.getByText('movements cross the edge of your household, filed under Opening balances'),
    ).toBeVisible();

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
    await expect(page.getByText('Trade Republic current account').first()).toBeVisible();
    await expect(page.getByText('€401.06')).toBeVisible();
    await expect(page.getByText('€100.00').first()).toBeVisible();

    // The tax is a line of its own, not folded into a net figure.
    await page.goto('/app/transactions');
    await expect(page.locator('li', { hasText: 'Interets' }).first()).toBeVisible();
  });
});

test('importing the same file twice is refused line by line, not silently', async () => {
  await expectNoConsoleErrors(async () => {
    await open(FIXTURE);

    // Nothing to press. The accounts the first import created carry the names
    // this screen would give them, so they are matched on sight and the offer
    // to create anything does not appear at all.
    await expect(page.getByRole('button', { name: /^Create the/ })).toHaveCount(0);
    await expect(
      page.getByRole('combobox', { name: /Trade Republic current account/ }),
    ).toContainText('Trade Republic current account');

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

    await open(TWO_SOURCES);
    await expect(page.getByRole('button', { name: /^Create the/ })).toHaveCount(0);

    // Two lines the file describes identically: both are money arriving from
    // outside Trade Republic. One is a salary and one is a transfer from an
    // account of your own, and no column in the export says which.
    //
    // The controls live in a dialog, not on every line of the review. On a real
    // statement the summary is right forty times and wrong twice, and the two
    // are the hardest things to find in a list of forty.
    await expect(page.locator('li', { hasText: 'Salaire' }).getByRole('combobox')).toHaveCount(0);
    await page.getByRole('button', { name: 'Change some of them' }).click();

    const dialogue = page.getByRole('dialog');
    await expect(dialogue).toBeVisible();
    const salary = dialogue.locator('li', { hasText: 'Salaire' }).first();
    const moved = dialogue.locator('li', { hasText: 'Virement depuis autre banque' }).first();

    await expect(salary.getByRole('combobox')).toContainText('Opening balances');
    await expect(moved.getByRole('combobox')).toContainText('Opening balances');

    await moved.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Autre banque', exact: true }).click();
    await expect(moved.getByRole('combobox')).toContainText('Autre banque');
    // And the other line kept its own answer.
    await expect(salary.getByRole('combobox')).toContainText('Opening balances');

    await dialogue.getByRole('button', { name: 'Done' }).click();
    await expect(dialogue).toBeHidden();

    await page.getByRole('button', { name: 'Import 2 transactions' }).click();
    await expect(page.getByText('2 transactions imported')).toBeVisible();

    // The claim, in one number. 2,300 arrived in the cash account and net worth
    // went up by 2,000: the salary is income and the transfer is the same money
    // in a different place. One answer for the whole file would have counted
    // 2,300 and quietly invented 300 euros.
    await page.goto('/app');
    await expect(page.getByText('€2,501.06').first()).toBeVisible();

    await page.goto('/app/accounts');
    await expect(page.getByText('€2,701.06')).toBeVisible();
    await expect(page.getByText('-€300.00')).toBeVisible();
  });
});

test('a PEA holds its own shares, and a CTO does not', async () => {
  await expectNoConsoleErrors(async () => {
    await open(PEA);

    // Three accounts, not four. The current account and the CTO beside it are
    // two places; the PEA is one place holding cash and holdings together, so
    // asking for a separate "PEA securities" account would ask a person to
    // invent one. That is a fact about this bank's products, so the preset
    // says it - Fortuneo would say something else.
    await expect(page.getByRole('combobox', { name: /Trade Republic PEA/ })).toHaveCount(1);
    await expect(page.getByRole('combobox', { name: /PEA:SECURITIES/ })).toHaveCount(0);
    await expect(page.getByText('DEFAULT:SECURITIES · securities')).toBeVisible();

    // The current account and the PEA are matched on sight from the first
    // import, so only the CTO is new.
    await page.getByRole('button', { name: 'Create the missing account' }).click();
    await expect(page.getByText('1 account created')).toBeVisible();

    await page.getByRole('button', { name: 'Import 3 transactions' }).click();
    await expect(page.getByText('3 transactions imported')).toBeVisible();

    await page.goto('/app/accounts');
    // 500 left the current account and 100 bought a share from it.
    await expect(page.getByText('€2,101.06')).toBeVisible();
    // The PEA received 500 and spent 200 of it on a fund. It still holds 600:
    // buying inside a PEA moves nothing out of it. Booked to two accounts, this
    // would read 400 and put 200 somewhere nobody chose.
    await expect(page.getByText('€600.00')).toBeVisible();
    // And the CTO holds the share bought from the current account.
    await expect(page.getByText('Trade Republic securities').first()).toBeVisible();
    await expect(page.getByText('€100.00').first()).toBeVisible();

    // Every movement was internal, so net worth did not budge.
    await page.goto('/app');
    await expect(page.getByText('€2,501.06').first()).toBeVisible();
  });
});

test('the counterpart rail scrolls inside the dialog rather than out of it', async () => {
  await expectNoConsoleErrors(async () => {
    // Ten movements, and nothing is imported: this is about the dialog holding
    // its shape, so the ledger is left exactly as the previous test left it.
    await open(MANY);
    await page.getByRole('button', { name: 'Change some of them' }).click();

    const dialogue = page.getByRole('dialog');
    await expect(dialogue).toBeVisible();

    // The defect this catches is invisible to every other kind of test. The
    // dialog is a grid, a grid item's default `min-width: auto` lets it grow to
    // its content, and a rail of cards pushed the dialog off the side of the
    // screen. It compiled, it rendered, and it was wrong to look at.
    const shape = await dialogue.evaluate((el) => {
      const list = el.querySelector('ul');
      return {
        dialog: el.clientWidth,
        rail: list?.clientWidth ?? -1,
        content: list?.scrollWidth ?? -1,
      };
    });

    // The defect this catches is invisible to every other kind of test. The
    // dialog is a grid, its implicit column is `auto` - meaning max-content -
    // and `min-w-0` on the child does not help, because it is the track that
    // grows. Ten cards made the rail 2,508 pixels wide inside a 576 pixel
    // dialog, and the cards ran off the side of the screen. `grid-cols-1`,
    // which Tailwind writes as `minmax(0, 1fr)`, is the fix.
    expect(
      shape.rail,
      `the rail is wider than the dialog: ${JSON.stringify(shape)}`,
    ).toBeLessThanOrEqual(shape.dialog);

    // And it really does have more than it shows, so the buttons have
    // something to do and the clipped card is a promise rather than a defect.
    expect(shape.content).toBeGreaterThan(shape.rail);

    await dialogue.getByRole('button', { name: 'Done' }).click();
    await expect(dialogue).toBeHidden();
  });
});

test('a dialog holds its contents, whatever the accounts are called', async () => {
  await expectNoConsoleErrors(async () => {
    // Not a regression test: the defect it was written for turned out to be
    // fixed by the dialog change proved in the test above, and this one stayed
    // green when that change was reverted. It is kept as a standing check that
    // a two-column dialog holding the longest name this suite makes draws
    // nothing outside itself, which is cheap and is what a person sees.
    await page.goto('/app');
    await page.getByRole('button', { name: 'Move money' }).click();

    const dialogue = page.getByRole('dialog');
    await expect(dialogue).toBeVisible();

    // Measured on the text, not on the boxes. An overflowing label does not
    // widen the element that holds it, so comparing rectangles saw nothing
    // while "Trade Republic securities (CTO)" was being drawn across the edge
    // of the dialog. `scrollWidth` is what notices.
    const spills = await dialogue.evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>('*')]
        .filter(
          (c) =>
            c.scrollWidth > c.clientWidth + 1 &&
            // Wide enough to be something a person looks at. A select keeps a
            // one-pixel input for the form value, and every icon carries a
            // screen-reader name; neither is drawn.
            c.clientWidth > 24 &&
            !c.classList.contains('sr-only'),
        )
        .map(
          (c) =>
            `${c.tagName}.${c.className.toString().slice(0, 40)}: ${String(c.scrollWidth)} > ${String(c.clientWidth)}`,
        ),
    );
    expect(spills, 'text is drawn wider than the control holding it').toEqual([]);

    await page.keyboard.press('Escape');
    await expect(dialogue).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 720 });
  });
});

test('an account in another currency is left out of the totals, and said so', async () => {
  await expectNoConsoleErrors(async () => {
    await page.goto('/app/accounts');
    await page.getByRole('button', { name: 'New account' }).click();

    const dialogue = page.getByRole('dialog');
    await dialogue.getByLabel('Name').fill('Compte USD');
    await dialogue.getByLabel('Currency').click();
    await page.getByRole('option', { name: 'USD - US dollar' }).click();
    // Said before the account exists, because nothing changes it afterwards.
    await expect(dialogue.getByText('will sit outside your totals')).toBeVisible();
    await dialogue.getByRole('button', { name: 'Add account' }).click();
    await expect(dialogue).toBeHidden();

    // `Money.plus` throws on a currency mismatch, so before this the page did
    // not merely mislead - it failed to render at all.
    await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
    await expect(page.getByText('not in these totals')).toBeVisible();
    await expect(page.getByText('Compte USD (USD)')).toBeVisible();

    // The totals are unchanged, the dollar account being none of their business.
    await page.goto('/app');
    await expect(page.getByText('€2,501.06').first()).toBeVisible();

    // And moving money into it is refused rather than posted in the wrong
    // currency, which is what a hardcoded 'EUR' used to do in silence. The
    // refusal comes from the domain and names the account and both currencies,
    // rather than from a second wording of the rule in the web layer.
    await page.getByRole('button', { name: 'Move money' }).click();
    const move = page.getByRole('dialog');
    await move.getByLabel('From').click();
    await page.getByRole('option', { name: 'Compte USD', exact: true }).click();
    await move.getByLabel('To').click();
    await page.getByRole('option', { name: 'Trade Republic PEA', exact: true }).click();
    await move.getByLabel('Amount').fill('10');
    await move.getByRole('button', { name: 'Record' }).click();

    await expect(page.getByText(/is held in EUR, and this entry is in USD/).first()).toBeVisible();
    await expect(move).toBeVisible();

    // And what reached the screen is a sentence, not the driver's. A raw
    // "Failed query: insert into transactions (...)" with the parameters
    // printed after it is what a person saw before `toMessage` stopped
    // relaying anything that was not written for them.
    await expect(page.getByText(/Failed query/)).toHaveCount(0);
  });
});
