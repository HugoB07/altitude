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
/** A French statement: CP1252, semicolons, a junk header block, debit and credit apart. */
const FRENCH = join(__dirname, 'fixtures', 'releve-francais.csv');
/** The next month from the same bank: every row differs, the shape does not. */
const FRENCH_LATER = join(__dirname, 'fixtures', 'releve-francais-2.csv');
/** The November debit again, written two days later, as a re-export does. */
const FRENCH_AGAIN = join(__dirname, 'fixtures', 'releve-francais-3.csv');
/** A statement with a state column, holding a card payment that was reverted. */
const STATES = join(__dirname, 'fixtures', 'releve-etats.csv');

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
    await expect(page.getByRole('heading', { name: 'Import', exact: true })).toBeVisible();

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
    await expect(page.getByRole('heading', { name: 'The accounts this file needs' })).toBeVisible();

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
    await expect(page.getByRole('heading', { name: 'The accounts this file needs' })).toBeVisible();
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
    // Waited for before counting anything. `toHaveCount(1)` on a control that
    // only exists once the server has answered reads zero while the request is
    // still in flight, and zero is a legitimate-looking answer.
    await expect(page.getByRole('heading', { name: 'The accounts this file needs' })).toBeVisible();

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
    await expect(page.getByRole('heading', { name: 'The accounts this file needs' })).toBeVisible();
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

test('an import can be undone, and the undoing is itself in the ledger', async () => {
  await expectNoConsoleErrors(async () => {
    // The dollar account from the previous test is not in the totals, so net
    // worth here is what the euro accounts hold.
    await page.goto('/app');
    const before = '€2,501.06';
    await expect(page.getByText(before).first()).toBeVisible();

    await page.goto('/app/import');
    await expect(page.getByRole('heading', { name: 'Previous imports' })).toBeVisible();

    // The PEA file is the last one that was written, and undoing it should put
    // every account it touched back where it was.
    const run = page.locator('li', { hasText: 'trade-republic-pea.csv' }).first();
    await expect(run).toBeVisible();
    await run.getByRole('button', { name: 'Undo' }).click();

    const confirm = page.getByRole('dialog');
    // The dialog says what will happen. "Are you sure" is a question nobody can
    // answer without being told the consequence.
    await expect(confirm.getByText('will be cancelled by its opposite')).toBeVisible();
    await confirm.getByRole('button', { name: 'Undo the import' }).click();

    await expect(page.getByText('3 transactions reversed')).toBeVisible();
    await expect(confirm).toBeHidden();

    // Listed, and marked. A run that disappeared would answer "has this file
    // been imported?" with no.
    await expect(run.getByText('Undone')).toBeVisible();
    await expect(run.getByText('3 transactions')).toBeVisible();

    // The balances are back, by arithmetic rather than by deletion.
    await page.goto('/app/accounts');
    await expect(page.getByText('€2,701.06')).toBeVisible();
    await expect(page.getByText('€100.00').first()).toBeVisible();

    // Nothing was deleted: the three transactions and the three that cancelled
    // them are both in the list.
    await page.goto('/app/transactions?status=reversal');
    await expect(page.getByText('reverses an earlier transaction').first()).toBeVisible();
    await page.goto('/app/transactions?status=reversed');
    await expect(page.getByText('Achat PEA')).toBeVisible();

    // And the same run cannot be undone twice - the control is gone, not merely
    // guarded on the server.
    await page.goto('/app/import');
    await expect(run.getByRole('button', { name: 'Undo' })).toHaveCount(0);
  });
});

test('a bank nobody wrote a preset for is described and read', async () => {
  await expectNoConsoleErrors(async () => {
    await page.goto('/app/import');

    // The path for a bank with no preset. It used to be shown and inert.
    await page.getByRole('button', { name: 'Other bank' }).click();
    await page.locator('input[type="file"]').setInputFiles(FRENCH);

    await expect(page.getByRole('heading', { name: 'Which column is what' })).toBeVisible();

    // Written in CP1252, which is what Excel on a French Windows produces.
    // Read as UTF-8 - which is what `file.text()` does - the accent becomes a
    // replacement character and never comes back.
    await expect(page.getByRole('cell', { name: 'Loyer octobre régularisé' })).toBeVisible();

    // Each choice echoes a real value from the column it names. Two columns
    // called "Date de debut" and "Date de fin" are told apart by what they
    // hold, not by what they are called.
    await expect(page.getByText(/^e\.g\. /).first()).toBeVisible();

    // Four lines of identification block above the header, semicolons, and a
    // debit/credit pair. None of that was said; all of it was worked out.
    await expect(page.getByRole('combobox', { name: /^Date/ })).toContainText('Date');
    await expect(page.getByLabel('How the amounts are written')).toContainText(
      'Two columns, both positive',
    );
    await expect(page.getByRole('combobox', { name: /Debit/ })).toContainText('Debit');
    await expect(page.getByRole('combobox', { name: /Credit/ })).toContainText('Credit');

    // 18 October settles the order, so the question is not asked.
    await expect(page.getByText('is the third of April or the fourth of March')).toHaveCount(0);

    await page.getByRole('button', { name: 'Continue' }).click();

    // From here it is the same screen as any preset: accounts, then review.
    await expect(page.getByRole('heading', { name: 'The accounts this file needs' })).toBeVisible();
    await expect(page.getByText('Loyer octobre régularisé')).toBeVisible();
    await expect(page.getByText('Salaire octobre')).toBeVisible();

    await page.getByRole('button', { name: /^Create the/ }).click();
    await expect(page.getByText(/account(s)? created/)).toBeVisible();

    await page.getByRole('button', { name: 'Import 3 transactions' }).click();
    await expect(page.getByText('3 transactions imported')).toBeVisible();

    // The arithmetic, which is what proves the reading rather than the screen.
    // 1,800 in and 812.40 out, so the statement account holds 987.60 - and the
    // thousands space in "1 800,00" is a non-breaking one.
    await page.goto('/app/accounts');
    await expect(page.getByText('€987.60')).toBeVisible();

    // Money crossing the household's edge, so net worth moved by the same.
    await page.goto('/app');
    await expect(page.getByText('€3,488.66').first()).toBeVisible();
  });
});

test('a line the statement says did not happen is left out, and said so', async () => {
  await expectNoConsoleErrors(async () => {
    await page.goto('/app/import');
    await page.getByRole('button', { name: 'Other bank' }).click();
    await page.locator('input[type="file"]').setInputFiles(STATES);

    await expect(page.getByRole('heading', { name: 'Which column is what' })).toBeVisible();

    // Dates carrying a time, which used to make a whole column stop looking
    // like dates - and then made the screen ask whether 03/04 was March.
    await expect(page.getByText(/^e\.g\. 2026-11-24 13:12:06/).first()).toBeVisible();
    await expect(page.getByText(/Which day is/)).toHaveCount(0);

    // The state column is found by shape, not by name: it repeats a handful of
    // values where an amount column does not.
    await expect(page.getByRole('combobox', { name: /State/ })).toContainText('Etat');
    await expect(page.getByRole('group', { name: 'Leave these out' })).toBeVisible();

    // The example under the state control reads out of the state column. It
    // used to index into a shorter list and echo "Valeur actuelle", which is
    // what the Produit column holds.
    await expect(page.getByText('e.g. RENVOYÉ')).toBeVisible();

    // And the file itself marks what has been named, so the questions and the
    // evidence are not two lists to hold side by side.
    await expect(page.getByRole('columnheader', { name: /Etat State/ })).toBeVisible();

    // Which states mean "did not happen" is a fact about the bank, so it is
    // asked. The values offered are the ones the file actually holds.
    await page.getByRole('checkbox', { name: 'RENVOYÉ' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();

    // Two movements from three rows, and the third is accounted for rather
    // than missing.
    await expect(page.getByText('1 line was left out, because RENVOYÉ')).toBeVisible();
    await expect(page.getByText('Paiement envoye')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import 2 transactions' })).toBeVisible();

    // The statement accounts already exist from the previous test and are
    // matched on sight, so there is nothing to create.
    await expect(page.getByRole('button', { name: /^Create the/ })).toHaveCount(0);

    await page.getByRole('button', { name: 'Import 2 transactions' }).click();
    await expect(page.getByText('2 transactions imported')).toBeVisible();

    // 50 in and 2.55 out, on top of the 987.60 the previous statement left.
    // The reverted 2.55 is not in that number: imported, the balance would be
    // short by exactly what was refunded.
    await page.goto('/app/accounts');
    await expect(page.getByText('€1,035.05')).toBeVisible();
  });
});

test('a bank described once is not described again', async () => {
  await expectNoConsoleErrors(async () => {
    // The same statement as the test that described it, a month later: every
    // row differs, the shape does not. That is what the fingerprint keys on.
    await page.goto('/app/import');
    await page.getByRole('button', { name: 'Other bank' }).click();
    await page.locator('input[type="file"]').setInputFiles(FRENCH_LATER);

    // No mapping screen. The description was kept when the first import was
    // written, and the toast says which file it came from.
    await expect(page.getByText(/Read with the description kept from/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Which column is what' })).toHaveCount(0);

    // Straight to the accounts, already matched, and the rows read correctly -
    // debit negated, thousands space and decimal comma understood.
    await expect(page.getByRole('heading', { name: 'The accounts this file needs' })).toBeVisible();
    await expect(page.getByText('Assurance habitation')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Create the/ })).toHaveCount(0);

    // A kept description is not a decision a person is stuck with. A column
    // read as the value date, a state that turned out to mean something else -
    // this is how it gets corrected, with the answers still in the form.
    await page.getByRole('button', { name: 'Change how this file is read' }).click();
    await expect(page.getByRole('heading', { name: 'Which column is what' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: /^Date/ })).toContainText('Date');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'The accounts this file needs' })).toBeVisible();

    await page.getByRole('button', { name: 'Import 2 transactions' }).click();
    await expect(page.getByText('2 transactions imported')).toBeVisible();

    // 1,035.05 from before, plus 1,900 in and 340.50 out.
    await page.goto('/app/accounts');
    await expect(page.getByText('€2,594.55')).toBeVisible();
  });
});

test('a wide statement scrolls inside its panel rather than pushing the page', async () => {
  await expectNoConsoleErrors(async () => {
    // The Trade Republic export read through the "other bank" path, for its
    // twenty-three columns. Nothing is imported: this is about the table
    // staying inside the panel that holds it.
    await page.goto('/app/import');
    await page.getByRole('button', { name: 'Other bank' }).click();
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);

    await expect(page.getByRole('heading', { name: 'Which column is what' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'account_type' })).toBeVisible();
    // A grid's implicit column is `auto`, meaning max-content, so without
    // `grid-cols-1` the track grows to the table and the whole page draws past
    // the right edge - the same defect as the counterpart rail in its dialog,
    // and this time on the page itself.
    const spill = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(spill, 'the page scrolls sideways').toBe(0);

    // And the table itself does scroll, which is what the panel is for.
    const table = page.locator('table').first();
    const scrolls = await table.evaluate((el) => {
      const box = el.parentElement!;
      return box.scrollWidth > box.clientWidth;
    });
    expect(scrolls, 'the table is not scrollable, so its columns are unreachable').toBe(true);
  });
});

test('a line the bank moved by two days is offered as a look-alike', async () => {
  await expectNoConsoleErrors(async () => {
    // The same direct debit as the November statement, dated the 7th instead
    // of the 5th. A bank re-exporting a month writes the operation date one
    // time and the value date the next, and on an exact-date match this came
    // back as new - a second 340.50 nobody asked for.
    await page.goto('/app/import');
    await page.getByRole('button', { name: 'Other bank' }).click();
    await page.locator('input[type="file"]').setInputFiles(FRENCH_AGAIN);

    await expect(page.getByRole('heading', { name: 'The accounts this file needs' })).toBeVisible();

    // The distance is named. Without it a person is asked to judge a duplicate
    // against a date they can see is not the same, with nothing said about why.
    await expect(page.getByText('looks like a duplicate - 2 days apart')).toBeVisible();

    // And both halves of the question are on screen. Judging a duplicate
    // against a row in another page is not judging, it is guessing.
    await expect(page.getByText('In your file')).toBeVisible();
    await expect(page.getByText('Already recorded')).toBeVisible();

    // The third answer of the plan: not a second transaction, not a line
    // thrown away, but "this is the one I already have".
    await page.getByRole('button', { name: 'Same one', exact: true }).click();
    await page.getByRole('button', { name: /^Import/ }).click();
    await expect(page.getByText('1 line matched to what you already had')).toBeVisible();

    // Nothing was posted: the balance is what it was.
    await page.goto('/app/accounts');
    await expect(page.getByText('€2,594.55')).toBeVisible();
  });
});

test('a line merged once is decided the next time, not asked about again', async () => {
  await expectNoConsoleErrors(async () => {
    // The same file once more. The transaction now carries the hash of this
    // line, so the exact level of the plan (§8.5) answers before anybody is
    // asked - which is what makes re-importing an overlapping period painless.
    await page.goto('/app/import');
    await page.getByRole('button', { name: 'Other bank' }).click();
    await page.locator('input[type="file"]').setInputFiles(FRENCH_AGAIN);

    // Said once, up front, from the digest the run kept of the file. The
    // line-by-line verdicts say it again below; this says it before.
    await expect(page.getByText(/You imported this exact file on/)).toBeVisible();

    await expect(page.getByRole('heading', { name: 'The accounts this file needs' })).toBeVisible();
    await expect(page.getByText('already imported')).toBeVisible();
    await expect(page.getByText('looks like a duplicate')).toHaveCount(0);
  });
});

test('a file past what the application accepts is refused with the number', async () => {
  await expectNoConsoleErrors(async () => {
    /**
     * Step 1 of the plan, which nothing enforced (§8.2).
     *
     * Next caps a server action body at one megabyte by default, so a large
     * statement already failed - with a framework error naming nothing, after
     * the whole file had crossed the network. This refuses in the browser,
     * before anything is sent, and says the limit.
     *
     * Built as a buffer rather than a fixture: a file this long has no place
     * in the repository, and its shape is one narrow column and years of rows,
     * which weighs little and reads long.
     */
    await page.goto('/app/import');
    await page.getByRole('button', { name: 'Other bank' }).click();
    // Counted, because the point of refusing in the browser is that nothing is
    // sent. The server refuses too, from the same key and with the same words,
    // so without this the test passes with the browser check deleted - and the
    // half that saves the upload would go quietly.
    const posts: string[] = [];
    const onRequest = (request: { method: () => string; url: () => string }) => {
      if (request.method() === 'POST') posts.push(request.url());
    };
    page.on('request', onRequest);

    const rows = '01/01/2027;1\n'.repeat(60_000);
    await page.locator('input[type="file"]').setInputFiles({
      name: 'dix-ans.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(`Date;Montant\n${rows}`),
    });

    await expect(page.getByText(/over 50000 lines/)).toBeVisible();
    page.off('request', onRequest);
    expect(posts, 'the file was sent before being refused').toEqual([]);

    // And nothing was read: the screen is still asking for a file.
    await expect(page.getByRole('heading', { name: 'Which column is what' })).toHaveCount(0);
  });
});
