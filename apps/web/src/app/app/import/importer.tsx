'use client';

import { useEffect, useReducer, useRef, useState, useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileUp,
  Pencil,
  Search,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  commitImportAction,
  openAccountsAction,
  previewImportAction,
  type PreviewLine,
  type PreviewResult,
} from '@/server/import-actions';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

export interface PresetChoice {
  readonly id: string;
  readonly name: string;
  readonly monogram: string;
  readonly logo?: string;
}

interface Props {
  readonly presets: readonly PresetChoice[];
  readonly accounts: readonly { id: string; name: string }[];
  /** Offered for the outside world, which no file names. */
  readonly openingAccountId: string | null;
}

/** Everything one run of the importer knows. */
interface Run {
  readonly preset: PresetChoice | null;
  readonly filename: string;
  readonly text: string;
  /** One account per label the file names, for the whole file. */
  readonly binding: Readonly<Record<string, string>>;
  /** One account for one transaction's counterpart, overriding the above. */
  readonly overrides: Readonly<Record<number, string>>;
}

const EMPTY: Run = { preset: null, filename: '', text: '', binding: {}, overrides: {} };

/** Above this, the review is folded by month. Below it, everything fits on a screen. */
const FOLD_ABOVE = 20;

type Step =
  | { readonly type: 'pick'; readonly preset: PresetChoice }
  | { readonly type: 'file'; readonly filename: string; readonly text: string }
  | { readonly type: 'bind'; readonly label: string; readonly accountId: string }
  | { readonly type: 'bindMany'; readonly binding: Readonly<Record<string, string>> }
  | { readonly type: 'counterpart'; readonly index: number; readonly accountId: string }
  | { readonly type: 'reset' };

/**
 * A reducer rather than four pieces of state, and the reason is a real bug.
 *
 * Choosing two accounts in quick succession runs two handlers against the same
 * render. Written as `setBinding({ ...binding, [label]: id })`, the second reads
 * `binding` as it was before the first and the first choice disappears - which
 * on this screen means an account silently reverting while somebody is looking
 * at the next one. A reducer sees the latest state on every dispatch, so the
 * two compose.
 */
function reduce(state: Run, step: Step): Run {
  switch (step.type) {
    case 'pick':
      return { ...EMPTY, preset: step.preset };
    case 'file':
      // A new file means new labels and new line numbers, so every previous
      // answer is an answer to a question nobody asked.
      return { ...state, filename: step.filename, text: step.text, binding: {}, overrides: {} };
    case 'bind':
      return { ...state, binding: { ...state.binding, [step.label]: step.accountId } };
    case 'bindMany':
      return { ...state, binding: { ...state.binding, ...step.binding } };
    case 'counterpart':
      return { ...state, overrides: { ...state.overrides, [step.index]: step.accountId } };
    case 'reset':
      return EMPTY;
  }
}

/**
 * Choose a bank, hand over a file, name its accounts, review, import.
 *
 * The file's text is held here and sent with every action. The server re-reads
 * it each time rather than trusting anything about a transaction that came back
 * from the browser - which costs milliseconds and removes a whole class of
 * question about what a client could send.
 */
export function Importer({ presets, accounts, openingAccountId }: Props) {
  const t = useTranslations('import');
  const locale = useLocale();

  const [run, dispatch] = useReducer(reduce, EMPTY);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState('');
  const [perLine, setPerLine] = useState(false);
  /** Months whose folded state a person has changed. See `isOpen`. */
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();

  /** The counterpart rail, scrolled by its own buttons rather than by a bar. */
  const rail = useRef<HTMLUListElement>(null);
  const slide = (direction: 1 | -1) => {
    const list = rail.current;
    if (list === null) return;
    // A card and its gap, so a press lands on the next card rather than part
    // way through it - which is what snapping is for.
    list.scrollBy({ left: direction * (list.clientWidth - 48), behavior: 'smooth' });
  };

  // Only the newest reading may win. A binding chosen while an older preview is
  // still in flight would otherwise be answered by the older one.
  const asked = useRef(0);
  /** The verdicts the current selection was seeded from. See below. */
  const seededFrom = useRef('');

  const { preset, binding, overrides, text } = run;
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name ?? '';

  /**
   * One reading per state of the run, asked for by the state itself.
   *
   * In an effect rather than in each handler, so there is exactly one place
   * that decides when the server is asked - and so the question always carries
   * the run as it is now rather than as some handler's closure remembers it.
   */
  useEffect(() => {
    if (preset === null || text === '') return;

    const form = new FormData();
    form.set('preset', preset.id);
    form.set('text', text);
    for (const [label, id] of Object.entries(binding)) form.set(`account:${label}`, id);
    for (const [index, id] of Object.entries(overrides)) form.set(`counterpart:${index}`, id);

    asked.current += 1;
    const mine = asked.current;

    start(() => {
      void previewImportAction(form).then((result) => {
        if (mine !== asked.current) return;
        setPreview(result);
        if (result.error !== undefined) {
          toast.error(result.error);
          return;
        }

        // Everything not already in the ledger starts ticked: a person removes
        // what they do not want rather than hunting for what they do.
        //
        // Re-seeded only when the verdicts themselves changed, which is what
        // binding an account does. Re-seeding on every reading would quietly
        // undo the boxes somebody had just unticked.
        const verdicts = (result.lines ?? []).map((line) => line.verdict).join(',');
        if (verdicts !== seededFrom.current) {
          seededFrom.current = verdicts;
          setSelected(
            new Set(
              (result.lines ?? []).filter((l) => l.verdict !== 'certain').map((l) => l.index),
            ),
          );
        }

        // Two kinds of answer the server can give without being asked, taken
        // together so they cost one round trip rather than two.
        //
        // A suggestion is an account of yours that already carries the name
        // this account would be created under, which is how the second import
        // of a bank asks nothing at all. The outside world gets the opening
        // balance account, because that is what it is: the counterpart of money
        // crossing the household's edge, and no file names it.
        const offered: Record<string, string> = {};
        for (const account of result.requested ?? []) {
          if (account.suggested === true && account.accountId !== null) {
            offered[account.label] = account.accountId;
          } else if (
            account.nature === 'counterpart' &&
            account.accountId === null &&
            openingAccountId !== null
          ) {
            offered[account.label] = openingAccountId;
          }
        }
        // Dispatched only when there is something to say, or the effect that
        // asked for this reading would ask for another one just like it.
        if (Object.keys(offered).length > 0) dispatch({ type: 'bindMany', binding: offered });
      });
    });
  }, [preset, text, binding, overrides, openingAccountId]);

  function reset() {
    asked.current += 1;
    seededFrom.current = '';
    dispatch({ type: 'reset' });
    setPreview(null);
    setSelected(new Set());
    setPerLine(false);
    setToggled(new Set());
  }

  async function onFile(file: File) {
    const contents = await file.text();
    seededFrom.current = '';
    dispatch({ type: 'file', filename: file.name, text: contents });
  }

  /** Creates or matches every account nobody has chosen, in one press. */
  function openAccounts() {
    if (preset === null) return;
    const form = new FormData();
    form.set('preset', preset.id);
    form.set('text', text);
    for (const [label, id] of Object.entries(binding)) form.set(`account:${label}`, id);

    start(() => {
      void openAccountsAction(form).then((result) => {
        if (result.error !== undefined) {
          toast.error(result.error);
          return;
        }
        dispatch({ type: 'bindMany', binding: result.bound ?? {} });
        toast.success(t('opened', { count: result.created ?? 0 }));
      });
    });
  }

  function commit() {
    if (preset === null) return;
    const form = new FormData();
    form.set('preset', preset.id);
    form.set('text', text);
    form.set('filename', run.filename);
    form.set('selected', [...selected].join(','));
    for (const [label, id] of Object.entries(binding)) form.set(`account:${label}`, id);
    for (const [index, id] of Object.entries(overrides)) form.set(`counterpart:${index}`, id);

    start(() => {
      void commitImportAction(form).then((result) => {
        if (result.error !== undefined) {
          toast.error(result.error);
          return;
        }
        toast.success(t('imported', { count: result.written ?? 0 }));
        reset();
      });
    });
  }

  // --- Step one: the bank -------------------------------------------------
  if (preset === null) {
    // Accent-insensitive, because half the banks a French list will hold are
    // spelled with one and nobody types it into a search box.
    const fold = (value: string) =>
      value
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase();
    const needle = fold(query.trim());
    const found = needle === '' ? presets : presets.filter((p) => fold(p.name).includes(needle));

    return (
      <section className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[13px] font-semibold tracking-wide uppercase">{t('chooseBank')}</h2>
          <div className="relative w-full sm:w-64">
            <Search
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
              aria-hidden
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder={t('searchBank')}
              aria-label={t('searchBank')}
              // The browser draws its own clear button on a search field, in
              // its own grey, at its own size, and it cannot be styled. Hidden
              // here and replaced below with one that matches everything else.
              className="pr-9 pl-9 [&::-webkit-search-cancel-button]:appearance-none"
            />
            {query !== '' && (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                }}
                aria-label={t('clearSearch')}
                className="text-muted-foreground hover:text-foreground hover:bg-muted absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full transition-colors"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            )}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {found.map((choice) => (
            <button
              key={choice.id}
              type="button"
              onClick={() => {
                dispatch({ type: 'pick', preset: choice });
              }}
              className="bg-card/60 hover:bg-muted/60 flex items-center gap-3 rounded-2xl border p-4 text-left transition-colors"
            >
              <Logo preset={choice} />
              <span className="text-[15px] font-medium">{choice.name}</span>
            </button>
          ))}

          {/* Shown and visibly inert. A person whose bank is missing should see
              that the path exists rather than conclude the feature does not.
              Never filtered out: it is the answer to a search that found
              nothing, so hiding it would empty the screen exactly when someone
              has just learned their bank is not here. */}
          <span
            aria-disabled
            className="text-muted-foreground flex items-center gap-3 rounded-2xl border border-dashed p-4"
          >
            <span className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-xl">
              <FileUp className="size-5" aria-hidden />
            </span>
            <span className="grid">
              <span className="text-[15px] font-medium">{t('custom')}</span>
              <span className="text-xs">
                {t('customSoon')} · {t('soon')}
              </span>
            </span>
          </span>
        </div>

        {found.length === 0 && needle !== '' && (
          <p className="text-muted-foreground text-sm">{t('noBank', { query: query.trim() })}</p>
        )}
      </section>
    );
  }

  // --- Step two: the file -------------------------------------------------
  if (preview === null) {
    return (
      <section className="grid gap-4">
        <Back onClick={reset} label={t('startOver')} />
        <h2 className="text-[13px] font-semibold tracking-wide uppercase">{t('chooseFile')}</h2>
        <label className="bg-card/60 hover:bg-muted/60 flex cursor-pointer items-center gap-3 rounded-2xl border border-dashed p-6 transition-colors">
          <Upload className="text-muted-foreground size-5" aria-hidden />
          <span className="text-sm">{preset.name}</span>
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            className="sr-only"
            disabled={pending}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void onFile(file);
            }}
          />
        </label>
      </section>
    );
  }

  const lines = preview.lines ?? [];
  const requested = preview.requested ?? [];
  const own = requested.filter((account) => account.nature !== 'counterpart');
  const counterparts = requested.filter((account) => account.nature === 'counterpart');
  const missing = own.filter((account) => account.accountId === null);

  const crossings = lines.filter((line) => line.entries.some((entry) => entry.counterpart));
  const counterpartName = nameOf(counterparts[0]?.accountId ?? '');

  const months = groupByMonth(lines);
  /**
   * Folded by month above twenty transactions, and never a month that needs a
   * decision. A person's own toggle flips whichever it is: a short file opens
   * everything, and clicking a month closes it.
   */
  const isOpen = (month: string, group: readonly PreviewLine[]) => {
    const byDefault = lines.length <= FOLD_ABOVE || group.some((line) => line.verdict !== 'new');
    return byDefault !== toggled.has(month);
  };

  const toggleMonth = (month: string) => {
    const next = new Set(toggled);
    if (next.has(month)) next.delete(month);
    else next.add(month);
    setToggled(next);
  };

  const setMany = (indices: readonly number[], on: boolean) => {
    const next = new Set(selected);
    for (const index of indices) {
      if (on) next.add(index);
      else next.delete(index);
    }
    setSelected(next);
  };

  return (
    <section className="grid gap-6">
      <Back onClick={reset} label={t('startOver')} />

      {preview.looksWrong === true && (
        <Alert>
          <AlertTriangle className="size-4" aria-hidden />
          <AlertDescription>{t('wrongShape', { name: preset.name })}</AlertDescription>
        </Alert>
      )}

      {/* --- The accounts the file needs ----------------------------------- */}
      <div className="bg-card/60 grid gap-4 rounded-2xl border p-5">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold tracking-wide uppercase">
              {t('accountsTitle')}
            </h2>
            <p className="text-muted-foreground mt-1 max-w-prose text-sm">{t('accountsHint')}</p>
          </div>

          {/* The whole panel answered at once. "Which of your accounts is PEA?"
              has no answer for somebody who has just installed this, and asking
              it four times before showing a transaction was most of what made
              this screen hard. */}
          {missing.length > 0 && (
            <Button type="button" variant="secondary" onClick={openAccounts} disabled={pending}>
              <Sparkles className="size-4" aria-hidden />
              {t('openAll', { count: missing.length })}
            </Button>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {own.map((account) => (
            <div key={account.label} className="grid gap-1.5">
              <Label
                htmlFor={`bind-${account.label}`}
                className="flex flex-wrap items-baseline gap-2"
              >
                {account.name}
                {/* The exporter's own code, kept and made small. It is how a
                    person checks this against the file they are holding, and
                    it is not what they should have to read first. */}
                <span className="text-muted-foreground text-[11px] font-normal">
                  {account.label} ·{' '}
                  {account.nature === 'securities' ? t('natureSecurities') : t('natureCash')}
                </span>
              </Label>
              <AccountSelect
                id={`bind-${account.label}`}
                accounts={accounts}
                value={account.accountId ?? ''}
                onChange={(accountId) => {
                  dispatch({ type: 'bind', label: account.label, accountId });
                }}
              />
            </div>
          ))}
        </div>

        {/* --- The outside world, folded ----------------------------------- */}
        {counterparts.length > 0 && crossings.length > 0 && (
          <div className="grid gap-3 border-t pt-4">
            <p className="text-muted-foreground max-w-prose text-sm">
              {t('counterpartSummary', {
                count: crossings.length,
                account: counterpartName,
              })}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <div className="grid gap-1.5 sm:w-64">
                <AccountSelect
                  id={`bind-${counterparts[0]!.label}`}
                  aria-label={counterparts[0]!.name}
                  accounts={accounts}
                  value={counterparts[0]!.accountId ?? ''}
                  onChange={(accountId) => {
                    dispatch({ type: 'bind', label: counterparts[0]!.label, accountId });
                  }}
                />
              </div>
              {/* The exceptions get a room of their own. Inline controls put
                  the question on every line of a long review, where the four
                  that need answering are the hardest to find. */}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPerLine(true);
                }}
              >
                <Pencil className="size-3.5" aria-hidden />
                {t('counterpartOpen')}
              </Button>
            </div>
          </div>
        )}
      </div>

      {(preview.problems ?? []).length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" aria-hidden />
          <AlertDescription>
            <p className="font-medium">{t('problems')}</p>
            <ul className="mt-1 grid gap-0.5 text-xs">
              {(preview.problems ?? []).map((problem) => (
                <li key={problem.line}>
                  {problem.line} · {problem.reason}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* --- Review, by month ---------------------------------------------- */}
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[13px] font-semibold tracking-wide uppercase">{t('reviewTitle')}</h2>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground text-xs font-medium"
            onClick={() => {
              setMany(
                lines.map((line) => line.index),
                selected.size !== lines.length,
              );
            }}
          >
            {selected.size === lines.length ? t('unselectAll') : t('selectAll')}
          </button>
        </div>

        {preview.checked !== true && (
          <p className="text-muted-foreground text-xs">{t('notCheckedYet')}</p>
        )}

        <div className="grid gap-2">
          {months.map(([month, group]) => {
            const indices = group.map((line) => line.index);
            const ticked = indices.filter((index) => selected.has(index)).length;
            const attention = group.some((line) => line.verdict !== 'new');
            const open = isOpen(month, group);

            return (
              <div key={month} className="overflow-hidden rounded-xl border">
                <div className="bg-card/60 flex items-center gap-3 p-3">
                  <Checkbox
                    aria-label={monthName(month, locale)}
                    checked={ticked === indices.length}
                    indeterminate={ticked > 0 && ticked < indices.length}
                    onCheckedChange={(value) => {
                      setMany(indices, value === true);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      toggleMonth(month);
                    }}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className="truncate text-sm font-medium">{monthName(month, locale)}</span>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {t('monthCount', { count: group.length })}
                    </span>
                    {attention && (
                      <span className="bg-chart-4/20 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase">
                        {t('needsLook')}
                      </span>
                    )}
                    <ChevronDown
                      className={cn(
                        'text-muted-foreground ml-auto size-4 shrink-0 transition-transform',
                        open && 'rotate-180',
                      )}
                      aria-hidden
                    />
                  </button>
                </div>

                {open && (
                  <ul className="grid gap-2 border-t p-2">
                    {group.map((line) => (
                      <li key={line.index}>
                        <Row
                          line={line}
                          t={t}
                          selected={selected.has(line.index)}
                          checked={preview.checked === true}
                          nameOf={nameOf}
                          onToggle={(on) => {
                            setMany([line.index], on);
                          }}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* --- The exceptions, one at a time --------------------------------- */}
      <Dialog open={perLine} onOpenChange={setPerLine}>
        {/* `grid-cols-1`, which Tailwind writes as `minmax(0, 1fr)`. The dialog's
            implicit column is `auto`, meaning max-content, so `min-w-0` on the
            child changes nothing: it is the track that grows, and a rail of ten
            cards made the dialog 1,733 pixels wider than the window. */}
        <DialogContent className="grid-cols-1 sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('counterpartDialogTitle')}</DialogTitle>
            <DialogDescription>{t('counterpartDialogHint')}</DialogDescription>
          </DialogHeader>

          {/* A rail, not a scrolling list. A vertical list of fifteen puts a
              scrollbar down the side of the dialog and squeezes every name and
              every account into a truncated half-line. Sideways, each movement
              gets a whole card: the description on two lines, the amount large
              enough to read, and an account control the full width of it. */}
          {/* `min-w-0`, and it is not decoration. The dialog is a grid, and a
              grid item's default `min-width: auto` lets it grow to whatever it
              contains - so a rail of fifteen cards stretched the row and the
              cards ran out of the dialog and off the page. */}
          <div className="min-w-0">
            <ul
              ref={rail}
              className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {crossings.map((line) => {
                const side = line.entries.find((entry) => entry.counterpart);
                return (
                  <li
                    key={line.index}
                    className="bg-card/60 flex w-60 shrink-0 snap-start flex-col justify-between gap-3 rounded-xl border p-4"
                  >
                    <div className="min-w-0">
                      <p className="line-clamp-2 text-sm leading-snug font-medium">
                        {line.description ?? line.kind}
                      </p>
                      <p className="text-muted-foreground mt-1 text-xs">{line.bookedOn}</p>
                      <p className="mt-2 text-lg font-semibold tabular-nums">
                        {side?.amount} {side?.currency}
                      </p>
                    </div>
                    <AccountSelect
                      id={`counterpart-${String(line.index)}`}
                      aria-label={t('counterpartFor', {
                        description: line.description ?? line.kind,
                      })}
                      size="sm"
                      className="w-full"
                      accounts={accounts}
                      value={side?.accountId ?? ''}
                      onChange={(accountId) => {
                        dispatch({ type: 'counterpart', index: line.index, accountId });
                      }}
                    />
                  </li>
                );
              })}
            </ul>
          </div>

          <DialogFooter className="sm:justify-between">
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t('scrollLeft')}
                onClick={() => {
                  slide(-1);
                }}
              >
                <ChevronLeft className="size-4" aria-hidden />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t('scrollRight')}
                onClick={() => {
                  slide(1);
                }}
              >
                <ChevronRight className="size-4" aria-hidden />
              </Button>
              <span className="text-muted-foreground ml-2 text-xs">
                {t('monthCount', { count: crossings.length })}
              </span>
            </div>
            <Button
              type="button"
              onClick={() => {
                setPerLine(false);
              }}
            >
              {t('counterpartClose')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          onClick={commit}
          disabled={pending || selected.size === 0 || missing.length > 0}
        >
          <Check className="size-4" aria-hidden />
          {t('commit', { count: selected.size })}
        </Button>
        {missing.length > 0 && (
          <p className="text-muted-foreground text-xs">
            {t('accountMissing', { label: missing.map((a) => a.name).join(', ') })}
          </p>
        )}
      </div>
    </section>
  );
}

/** One candidate transaction, with its entries and the choice it may still need. */
function Row({
  line,
  t,
  selected,
  checked,
  nameOf,
  onToggle,
}: {
  line: PreviewLine;
  t: ReturnType<typeof useTranslations<'import'>>;
  selected: boolean;
  checked: boolean;
  nameOf: (id: string) => string;
  onToggle: (on: boolean) => void;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border p-3 transition-colors',
        selected
          ? 'bg-card/60'
          : // Not faded. An unticked row is still one somebody has to read to
            // decide about, and 60% opacity put it at 2.7:1.
            'bg-muted/30 border-dashed',
      )}
    >
      {/* The label covers the checkbox and the summary, and stops there.
          Wrapping the whole row in one put the counterpart control inside a
          label, where every click also toggled the tick beside it. */}
      <label className="flex cursor-pointer items-start gap-3">
        <Checkbox
          className="mt-0.5 shrink-0"
          checked={selected}
          onCheckedChange={(value) => {
            onToggle(value === true);
          }}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{line.description ?? line.kind}</span>
            <Verdict kind={line.verdict} checked={checked} t={t} />
          </span>
          <span className="text-muted-foreground mt-0.5 block text-xs">
            {line.bookedOn} · {line.kind} ·{' '}
            {t('sourceLines', {
              count: line.sourceLines.length,
              lines: line.sourceLines.join(', '),
            })}
          </span>
        </span>
      </label>

      <div className="pl-7">
        <ul className="mt-1.5 grid gap-1">
          {line.entries.map((entry, index) => (
            <li
              key={`${entry.label}-${String(index)}`}
              className="flex items-center justify-between gap-3 text-xs"
            >
              <span className="text-muted-foreground truncate">
                {nameOf(entry.accountId ?? '') || entry.label}
              </span>

              <span className="flex shrink-0 items-baseline gap-2">
                {/* What this line is, when the reader had something to say:
                    "Gross", "Withholding tax". Without it, an interest payment
                    is three numbers against two names and nobody can tell
                    which is which. */}
                {(entry.memo ?? entry.instrument) !== null && (
                  <span className="text-muted-foreground">{entry.memo ?? entry.instrument}</span>
                )}
                <span className="tabular-nums">
                  {entry.amount} {entry.currency}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Candidates by `YYYY-MM`, newest first, keeping each month's own order. */
function groupByMonth(lines: readonly PreviewLine[]): [string, PreviewLine[]][] {
  const months = new Map<string, PreviewLine[]>();
  for (const line of lines) {
    const month = line.bookedOn.slice(0, 7);
    const group = months.get(month);
    if (group === undefined) months.set(month, [line]);
    else group.push(line);
  }
  return [...months.entries()].sort(([a], [b]) => b.localeCompare(a));
}

function monthName(month: string, locale: string): string {
  const [year, index] = month.split('-');
  const date = new Date(Number(year), Number(index) - 1, 1);
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(date);
}

/**
 * One account, chosen from the household's.
 *
 * Extracted because the same control answers three different questions on this
 * screen - which of yours is `PEA`, what stands for the outside world, and what
 * it is for this one transaction - and three copies of it is three places for
 * the empty-value handling to drift.
 */
function AccountSelect({
  id,
  accounts,
  value,
  onChange,
  size,
  className,
  'aria-label': ariaLabel,
}: {
  id: string;
  accounts: readonly { id: string; name: string }[];
  value: string;
  onChange: (accountId: string) => void;
  size?: 'sm' | 'default';
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <Select
      name={id}
      value={value}
      onValueChange={(next) => {
        onChange(next ?? '');
      }}
    >
      <SelectTrigger
        id={id}
        size={size}
        aria-label={ariaLabel}
        className={cn('w-full min-w-0', className)}
      >
        <SelectValue className="truncate">
          {accounts.find((a) => a.id === value)?.name ?? ''}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {accounts.map((account) => (
          <SelectItem key={account.id} value={account.id}>
            {account.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Logo({ preset }: { preset: PresetChoice }) {
  if (preset.logo !== undefined) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={preset.logo} alt="" className="size-10 shrink-0 rounded-xl object-contain" />;
  }
  return (
    <span
      className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-xl text-sm font-semibold"
      aria-hidden
    >
      {preset.monogram}
    </span>
  );
}

function Verdict({
  kind,
  checked,
  t,
}: {
  kind: string;
  checked: boolean;
  t: ReturnType<typeof useTranslations<'import'>>;
}) {
  if (!checked || kind === 'new') return null;

  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase',
        kind === 'certain' ? 'bg-muted text-muted-foreground' : 'bg-chart-4/20 text-foreground',
      )}
    >
      {kind === 'certain' ? t('verdictCertain') : t('verdictProbable')}
    </span>
  );
}

function Back({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-xs font-medium transition-colors"
    >
      <ArrowLeft className="size-3.5" aria-hidden />
      {label}
    </button>
  );
}
