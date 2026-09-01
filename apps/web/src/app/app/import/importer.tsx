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
  Filter,
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
  rememberMappingAction,
  shapeFileAction,
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
import { decodeText } from '@altitude/shared';
import { CUSTOM_PRESET_ID } from '@/lib/import-custom';
import { MappingForm, type DraftMapping, type FileShapeView } from './mapping';
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
  /** Offered as the currency of a statement whose file does not say. */
  readonly baseCurrency: string;
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
  /**
   * The columns of a file nobody wrote a preset for, once they are named.
   *
   * Null for a coded preset, and null for a custom file until the mapping step
   * is finished - which is what tells the preview to wait rather than asking
   * the server to read a file with no description of it.
   */
  readonly mapping: DraftMapping | null;
}

const EMPTY: Run = {
  preset: null,
  filename: '',
  text: '',
  binding: {},
  overrides: {},
  mapping: null,
};

/** Above this, the review is folded by month. Below it, everything fits on a screen. */
const FOLD_ABOVE = 20;

type Step =
  | { readonly type: 'pick'; readonly preset: PresetChoice }
  | { readonly type: 'file'; readonly filename: string; readonly text: string }
  | { readonly type: 'bind'; readonly label: string; readonly accountId: string }
  | { readonly type: 'bindMany'; readonly binding: Readonly<Record<string, string>> }
  | { readonly type: 'counterpart'; readonly index: number; readonly accountId: string }
  | { readonly type: 'mapping'; readonly mapping: DraftMapping }
  | { readonly type: 'remap' }
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
      return {
        ...state,
        filename: step.filename,
        text: step.text,
        binding: {},
        overrides: {},
        mapping: null,
      };
    case 'bind':
      return { ...state, binding: { ...state.binding, [step.label]: step.accountId } };
    case 'bindMany':
      return { ...state, binding: { ...state.binding, ...step.binding } };
    case 'counterpart':
      return { ...state, overrides: { ...state.overrides, [step.index]: step.accountId } };
    case 'mapping':
      return { ...state, mapping: step.mapping };
    case 'remap':
      // Back to the questions, keeping the file. The draft still holds the
      // answers, so this reopens what was decided rather than a blank form -
      // and a bank that changes a column is a correction, not a fresh start.
      return { ...state, mapping: null, binding: {}, overrides: {} };
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
export function Importer({ presets, accounts, openingAccountId, baseCurrency }: Props) {
  const t = useTranslations('import');
  const locale = useLocale();

  const [run, dispatch] = useReducer(reduce, EMPTY);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState('');
  /** What the file turned out to look like, and the answers being collected. */
  const [shape, setShape] = useState<FileShapeView | null>(null);
  /** What identifies this file's shape, kept so the mapping can be stored under it. */
  const fingerprint = useRef('');
  const [draft, setDraft] = useState<DraftMapping>(BLANK_DRAFT);
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

  const { preset, binding, overrides, text, mapping } = run;
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
    // A custom file has no reader until its columns are named.
    if (preset.id === CUSTOM_PRESET_ID && mapping === null) return;

    const form = new FormData();
    form.set('preset', preset.id);
    form.set('text', text);
    if (mapping !== null) form.set('mapping', JSON.stringify(toColumnMapping(mapping)));
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
  }, [preset, text, binding, overrides, mapping, openingAccountId]);

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
    // Bytes, not `file.text()`. That method assumes UTF-8 and replaces
    // everything else with U+FFFD, so a CP1252 export - which is what Excel on
    // a French Windows writes - arrives with "VIREMENT SÉPA" already turned
    // into "VIREMENT S?PA", and no care downstream brings the letter back.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { text: contents } = decodeText(bytes);

    seededFrom.current = '';
    setShape(null);
    // The household's currency, as a real answer rather than a placeholder the
    // control drew. Left blank, the mapping carried no currency at all and
    // every row came back "no currency for this row, and none set".
    setDraft({ ...BLANK_DRAFT, currency: baseCurrency });
    dispatch({ type: 'file', filename: file.name, text: contents });

    // Described before anything is asked. The screen knows where the header is
    // and how the dates are written because the file says so; asking a person
    // to supply what it could work out is asking them to do its job.
    if (preset?.id === CUSTOM_PRESET_ID) {
      const form = new FormData();
      form.set('text', contents);
      start(() => {
        void shapeFileAction(form).then((result) => {
          if (result.error !== undefined) {
            toast.error(result.error);
            return;
          }
          const headers = result.headers ?? [];
          const categories = result.categories ?? {};
          fingerprint.current = result.fingerprint ?? '';
          setShape({ headers, sample: result.sample ?? [], dates: result.dates ?? {}, categories });

          // Described once already. Nothing to ask: the preview runs straight
          // away, which is what "without manual intervention" means.
          const kept = toDraft(result.remembered?.mapping);
          if (kept !== null) {
            setDraft(kept);
            dispatch({ type: 'mapping', mapping: kept });
            toast.success(t('mappingRemembered', { name: result.remembered?.name ?? '' }));
            return;
          }

          setDraft((current) => ({
            ...current,
            ...guess(headers, result.dates ?? {}, categories),
          }));
        });
      });
    }
  }

  /** Creates or matches every account nobody has chosen, in one press. */
  function openAccounts() {
    if (preset === null) return;
    const form = new FormData();
    form.set('preset', preset.id);
    form.set('text', text);
    if (mapping !== null) form.set('mapping', JSON.stringify(toColumnMapping(mapping)));
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
    if (mapping !== null) form.set('mapping', JSON.stringify(toColumnMapping(mapping)));
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

        // Kept now rather than when the mapping screen was finished: a
        // description that never imported anything is a guess nobody
        // confirmed, and it would answer the next file of this shape.
        if (mapping !== null && fingerprint.current !== '') {
          const keep = new FormData();
          keep.set('fingerprint', fingerprint.current);
          keep.set('name', run.filename);
          keep.set('mapping', JSON.stringify(toColumnMapping(mapping)));
          void rememberMappingAction(keep);
        }

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

          {/* Never filtered out by the search: it is the answer to a search
              that found nothing, so hiding it would empty the screen exactly
              when somebody has just learned their bank is not here. */}
          <button
            type="button"
            onClick={() => {
              dispatch({
                type: 'pick',
                preset: { id: CUSTOM_PRESET_ID, name: t('custom'), monogram: 'CSV' },
              });
            }}
            className="bg-card/60 hover:bg-muted/60 flex items-center gap-3 rounded-2xl border border-dashed p-4 text-left transition-colors"
          >
            <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-xl">
              <FileUp className="size-5" aria-hidden />
            </span>
            <span className="grid">
              <span className="text-[15px] font-medium">{t('custom')}</span>
              <span className="text-muted-foreground text-xs">{t('customHint')}</span>
            </span>
          </button>
        </div>

        {found.length === 0 && needle !== '' && (
          <p className="text-muted-foreground text-sm">{t('noBank', { query: query.trim() })}</p>
        )}
      </section>
    );
  }

  // --- Step two: the file -------------------------------------------------
  if (text === '') {
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

  // --- Step two and a half: which column is what --------------------------
  // Only for a file nobody wrote a preset for, and only until it is described.
  if (preset.id === CUSTOM_PRESET_ID && mapping === null) {
    return (
      <section className="grid grid-cols-1 gap-4">
        <Back onClick={reset} label={t('startOver')} />
        {shape === null ? (
          <p className="text-muted-foreground text-sm">{t('reading')}</p>
        ) : (
          <MappingForm
            shape={shape}
            draft={draft}
            baseCurrency={baseCurrency}
            onChange={setDraft}
            onDone={() => {
              dispatch({ type: 'mapping', mapping: draft });
            }}
          />
        )}
      </section>
    );
  }

  if (preview === null) {
    return (
      <section className="grid gap-4">
        <Back onClick={reset} label={t('startOver')} />
        <p className="text-muted-foreground text-sm">{t('reading')}</p>
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

      {/* Only for a file that was described rather than read by a preset. The
          description is kept once it has imported something, so this is how a
          person corrects one - a column read as the value date, a state that
          turned out to mean something else. */}
      {preset.id === CUSTOM_PRESET_ID && (
        <button
          type="button"
          onClick={() => {
            dispatch({ type: 'remap' });
          }}
          className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1.5 text-xs font-medium underline underline-offset-4 transition-colors"
        >
          <Pencil className="size-3.5" aria-hidden />
          {t('changeMapping')}
        </button>
      )}

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

      {/* Said, not hidden. A row left out on purpose is still a row somebody
          can see in their own file, and a reader that dropped it silently would
          be right about the balance and unable to explain itself. */}
      {(preview.skipped ?? []).length > 0 && (
        <Alert>
          <Filter className="size-4" aria-hidden />
          <AlertDescription>
            {t('skippedRows', {
              count: (preview.skipped ?? []).length,
              states: [...new Set((preview.skipped ?? []).map((row) => row.reason))].join(', '),
            })}
          </AlertDescription>
        </Alert>
      )}

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
        <DialogContent className="sm:max-w-xl">
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
            <Verdict kind={line.verdict} daysApart={line.daysApart} checked={checked} t={t} />
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
  daysApart,
  checked,
  t,
}: {
  kind: string;
  daysApart: number | null;
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
      {/* Only when the dates differ. On the same day the badge is the whole
          story, and appending "0 days apart" to it says nothing. */}
      {kind === 'probable' && daysApart !== null && daysApart > 0
        ? ` - ${t('verdictDaysApart', { days: daysApart })}`
        : ''}
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

/** Nothing chosen, and the date order a European statement most often uses. */
const BLANK_DRAFT: DraftMapping = {
  bookedOn: '',
  description: '',
  amountMode: 'one',
  amount: '',
  debit: '',
  credit: '',
  externalId: '',
  status: '',
  skipStatuses: [],
  currency: '',
  dateOrder: 'dmy',
};

/**
 * A first answer, from the column names the file uses.
 *
 * Offered, not decided: every one of these is a control a person can change,
 * and the screen shows the file above them. The point is that a statement whose
 * columns are called "Date" and "Montant" should not need four answers to say
 * what it plainly says.
 *
 * Matched without accents or case, because "Libellé" and "libelle" are the same
 * word to everyone except a string comparison.
 */
function guess(
  headers: readonly string[],
  dates: Readonly<Record<string, { order: string; ambiguous: boolean }>>,
  categories: Readonly<Record<string, readonly string[]>>,
): Partial<DraftMapping> {
  const fold = (value: string) =>
    value
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .trim();

  const find = (...words: string[]) =>
    headers.find((name) => words.some((word) => fold(name).includes(word))) ?? '';

  const debit = find('debit');
  const credit = find('credit');
  const amount = find('montant', 'amount', 'valeur');

  // A column the file itself says holds dates beats one that only sounds like
  // it does: `readShape` looked at the values, and a name did not.
  const dated = Object.keys(dates);
  const bookedOn = dated.find((name) => fold(name).includes('date')) ?? dated[0] ?? find('date');

  const order = dates[bookedOn]?.order;

  // A status column, from the ones the file repeats. Only its name is guessed;
  // which of its values mean "did not happen" is a fact about the bank, and the
  // screen asks rather than assuming that RENVOYE means what it looks like.
  const status =
    Object.keys(categories).find((name) =>
      ['etat', 'statut', 'status', 'state'].includes(fold(name)),
    ) ?? '';

  return {
    status,
    bookedOn,
    description: find('libelle', 'label', 'description', 'nature', 'operation'),
    externalId: find('reference', 'numero', 'id'),
    ...(debit !== '' && credit !== ''
      ? { amountMode: 'two' as const, debit, credit }
      : { amountMode: 'one' as const, amount }),
    ...(order === 'dmy' || order === 'mdy' || order === 'ymd' ? { dateOrder: order } : {}),
  };
}

/**
 * The draft, as the domain wants it.
 *
 * The screen collects empty strings for "not chosen", which is what a select
 * with no value gives; the mapping wants those fields absent. Two shapes rather
 * than one, because a control that binds to `undefined` is a control React
 * calls uncontrolled halfway through typing.
 */
function toColumnMapping(draft: DraftMapping) {
  const named = (value: string) => (value.trim() === '' ? undefined : value);

  return {
    columns: {
      bookedOn: draft.bookedOn,
      ...(named(draft.description) === undefined ? {} : { description: draft.description }),
      ...(draft.amountMode === 'one'
        ? { amount: draft.amount }
        : { debit: draft.debit, credit: draft.credit }),
      ...(named(draft.externalId) === undefined ? {} : { externalId: draft.externalId }),
      ...(named(draft.status) === undefined ? {} : { status: draft.status }),
    },
    ...(draft.skipStatuses.length === 0 ? {} : { skipStatuses: draft.skipStatuses }),
    currency: draft.currency,
    dateOrder: draft.dateOrder,
  };
}

/**
 * A stored mapping, back in the shape the controls bind to.
 *
 * The inverse of `toColumnMapping`, and it exists for the same reason: the
 * domain leaves absent what the screen holds as an empty string, and a control
 * bound to `undefined` is one React calls uncontrolled halfway through typing.
 *
 * Returns null for anything it does not recognise, so a row written by an older
 * version means "ask again" rather than a half-filled form nobody can trust.
 */
function toDraft(stored: unknown): DraftMapping | null {
  if (typeof stored !== 'object' || stored === null) return null;
  const raw = stored as { columns?: Record<string, unknown>; [key: string]: unknown };
  const columns = raw.columns;
  if (typeof columns !== 'object' || columns === null) return null;

  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const bookedOn = text(columns['bookedOn']);
  if (bookedOn === '') return null;

  const amount = text(columns['amount']);
  const order = raw['dateOrder'];

  return {
    bookedOn,
    description: text(columns['description']),
    amountMode: amount === '' ? 'two' : 'one',
    amount,
    debit: text(columns['debit']),
    credit: text(columns['credit']),
    externalId: text(columns['externalId']),
    status: text(columns['status']),
    skipStatuses: Array.isArray(raw['skipStatuses'])
      ? raw['skipStatuses'].filter((value): value is string => typeof value === 'string')
      : [],
    currency: text(raw['currency']),
    dateOrder: order === 'mdy' || order === 'ymd' ? order : 'dmy',
  };
}
