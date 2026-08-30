'use client';

import { useEffect, useReducer, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ArrowLeft, Check, FileUp, Search, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  commitImportAction,
  previewImportAction,
  type PreviewResult,
} from '@/server/import-actions';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  /** Chosen for EXTERNAL by default: money from outside has to land somewhere. */
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

type Step =
  | { readonly type: 'pick'; readonly preset: PresetChoice }
  | { readonly type: 'file'; readonly filename: string; readonly text: string }
  | { readonly type: 'bind'; readonly label: string; readonly accountId: string }
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
    case 'counterpart':
      return { ...state, overrides: { ...state.overrides, [step.index]: step.accountId } };
    case 'reset':
      return EMPTY;
  }
}

/**
 * Choose a bank, read a file, bind its accounts, review, import.
 *
 * The file's text is held here and sent with every action. The server re-reads
 * it each time rather than trusting anything about a transaction that came back
 * from the browser - which costs milliseconds and removes a whole class of
 * question about what a client could send.
 */
export function Importer({ presets, accounts, openingAccountId }: Props) {
  const t = useTranslations('import');

  const [run, dispatch] = useReducer(reduce, EMPTY);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState('');
  const [pending, start] = useTransition();

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

        // EXTERNAL is offered the opening balance account, because that is what
        // it is: the counterpart of money crossing the household's edge, and no
        // file names it.
        for (const label of result.counterparts ?? []) {
          if (binding[label] === undefined && openingAccountId !== null) {
            dispatch({ type: 'bind', label, accountId: openingAccountId });
          }
        }
      });
    });
  }, [preset, text, binding, overrides, openingAccountId]);

  function reset() {
    asked.current += 1;
    seededFrom.current = '';
    dispatch({ type: 'reset' });
    setPreview(null);
    setSelected(new Set());
  }

  async function onFile(file: File) {
    const contents = await file.text();
    seededFrom.current = '';
    dispatch({ type: 'file', filename: file.name, text: contents });
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
              onChange={(event) => setQuery(event.target.value)}
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
  const labels = preview.accounts ?? [];
  const securities = preview.securities ?? [];
  const counterparts = preview.counterparts ?? [];
  const unbound = [...labels, ...securities].filter((label) => binding[label] === undefined);

  return (
    <section className="grid gap-6">
      <Back onClick={reset} label={t('startOver')} />

      {preview.looksWrong === true && (
        <Alert>
          <AlertTriangle className="size-4" aria-hidden />
          <AlertDescription>{t('wrongShape', { name: preset.name })}</AlertDescription>
        </Alert>
      )}

      {/* --- Accounts ------------------------------------------------------ */}
      <div className="bg-card/60 grid gap-4 rounded-2xl border p-5">
        <div>
          <h2 className="text-[13px] font-semibold tracking-wide uppercase">
            {t('accountsTitle')}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">{t('accountsHint')}</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {labels.map((label) => (
            <div key={label} className="grid gap-1.5">
              <Label htmlFor={`bind-${label}`}>{label}</Label>
              <AccountSelect
                id={`bind-${label}`}
                accounts={accounts}
                value={binding[label] ?? ''}
                onChange={(accountId) => {
                  dispatch({ type: 'bind', label, accountId });
                }}
              />
            </div>
          ))}
        </div>

        {/* A broker names one account and means two. Asked in the same panel,
            because it is the same kind of question - one answer for the file -
            but set apart, because picking the cash account here is the mistake
            this section exists to prevent. */}
        {securities.length > 0 && (
          <div className="grid gap-3 border-t pt-4">
            <p className="text-muted-foreground max-w-prose text-sm">{t('securitiesHint')}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {securities.map((label) => (
                <div key={label} className="grid gap-1.5">
                  <Label htmlFor={`bind-${label}`}>{label}</Label>
                  <AccountSelect
                    id={`bind-${label}`}
                    accounts={accounts}
                    value={binding[label] ?? ''}
                    onChange={(accountId) => {
                      dispatch({ type: 'bind', label, accountId });
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* --- The outside world --------------------------------------------- */}
      {counterparts.map((label) => (
        <div key={label} className="bg-card/60 grid gap-3 rounded-2xl border border-dashed p-5">
          <div>
            <h2 className="text-[13px] font-semibold tracking-wide uppercase">
              {t('counterpartTitle')}
            </h2>
            <p className="text-muted-foreground mt-1 max-w-prose text-sm">
              {t('externalExplained')}
            </p>
          </div>
          <div className="grid gap-1.5 sm:max-w-sm">
            <Label htmlFor={`bind-${label}`}>{t('counterpartDefault')}</Label>
            <AccountSelect
              id={`bind-${label}`}
              accounts={accounts}
              value={binding[label] ?? ''}
              onChange={(accountId) => {
                dispatch({ type: 'bind', label, accountId });
              }}
            />
          </div>
        </div>
      ))}

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

      {/* --- Review -------------------------------------------------------- */}
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[13px] font-semibold tracking-wide uppercase">{t('reviewTitle')}</h2>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground text-xs font-medium"
            onClick={() =>
              setSelected(
                selected.size === lines.length ? new Set() : new Set(lines.map((l) => l.index)),
              )
            }
          >
            {selected.size === lines.length ? t('unselectAll') : t('selectAll')}
          </button>
        </div>

        {preview.checked !== true && (
          <p className="text-muted-foreground text-xs">{t('notCheckedYet')}</p>
        )}

        <ul className="grid gap-2">
          {lines.map((line) => (
            <li key={line.index}>
              <div
                className={cn(
                  'rounded-xl border p-3 transition-colors',
                  selected.has(line.index)
                    ? 'bg-card/60'
                    : // Not faded. An unticked row is still one somebody has to
                      // read to decide about, and 60% opacity put it at 2.7:1.
                      'bg-muted/30 border-dashed',
                )}
              >
                {/* The label covers the checkbox and the summary, and stops
                    there. Wrapping the whole row in one put the counterpart
                    control inside a label, where every click also toggled the
                    tick beside it. */}
                <label className="flex cursor-pointer items-start gap-3">
                  <Checkbox
                    className="mt-0.5 shrink-0"
                    checked={selected.has(line.index)}
                    onCheckedChange={(value) => {
                      const next = new Set(selected);
                      if (value === true) next.add(line.index);
                      else next.delete(line.index);
                      setSelected(next);
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {line.description ?? line.kind}
                      </span>
                      <Verdict kind={line.verdict} checked={preview.checked === true} />
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
                        {entry.counterpart &&
                        // One control per transaction, on the first line that
                        // needs it. Interest has two counterpart lines - the
                        // income and the tax that went with it - and putting a
                        // select on each asks the same question twice and lets
                        // the two answers disagree.
                        index === line.entries.findIndex((e) => e.counterpart) ? (
                          <AccountSelect
                            id={`counterpart-${String(line.index)}`}
                            aria-label={t('counterpartFor', {
                              description: line.description ?? line.kind,
                            })}
                            size="sm"
                            accounts={accounts}
                            value={entry.accountId ?? ''}
                            onChange={(accountId) => {
                              dispatch({ type: 'counterpart', index: line.index, accountId });
                            }}
                          />
                        ) : (
                          <span className="text-muted-foreground truncate">
                            {nameOf(entry.accountId ?? '') || entry.label}
                          </span>
                        )}

                        <span className="flex shrink-0 items-baseline gap-2">
                          {/* What this line is, when the reader had something to
                              say: "Gross", "Withholding tax". Without it, an
                              interest payment is four numbers against two
                              account names and nobody can tell which is which. */}
                          {(entry.memo ?? entry.instrument) !== null && (
                            <span className="text-muted-foreground">
                              {entry.memo ?? entry.instrument}
                            </span>
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
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          onClick={commit}
          disabled={pending || selected.size === 0 || unbound.length > 0}
        >
          <Check className="size-4" aria-hidden />
          {t('commit', { count: selected.size })}
        </Button>
        {unbound.length > 0 && (
          <p className="text-muted-foreground text-xs">
            {t('accountMissing', { label: unbound.join(', ') })}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * One account, chosen from the household's.
 *
 * Extracted because the same control answers three different questions on this
 * screen - which of yours is `PEA`, what stands for the outside world by
 * default, and what it is for this one transaction - and three copies of it is
 * three places for the empty-value handling to drift.
 */
function AccountSelect({
  id,
  accounts,
  value,
  onChange,
  size,
  'aria-label': ariaLabel,
}: {
  id: string;
  accounts: readonly { id: string; name: string }[];
  value: string;
  onChange: (accountId: string) => void;
  size?: 'sm' | 'default';
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
        className={size === 'sm' ? 'min-w-0 max-w-[60%]' : 'w-full'}
      >
        <SelectValue>{accounts.find((a) => a.id === value)?.name ?? ''}</SelectValue>
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

function Verdict({ kind, checked }: { kind: string; checked: boolean }) {
  const t = useTranslations('import');
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
