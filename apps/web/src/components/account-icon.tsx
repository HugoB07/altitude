import {
  Banknote,
  Bitcoin,
  Building2,
  CandlestickChart,
  Car,
  CreditCard,
  Gem,
  HandCoins,
  Landmark,
  LineChart,
  PiggyBank,
  Scale,
  ShieldCheck,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * An icon per account kind.
 *
 * A wealth tracker is a list of amounts, and a column of amounts with nothing
 * beside it is read line by line. A glyph gives each row a shape the eye can
 * find again without reading, which is most of why an interface feels quick.
 *
 * Every kind is listed rather than defaulting: a new kind should fail the
 * exhaustiveness check here and be given a glyph deliberately, not silently
 * inherit a wallet.
 */
const ICONS: Record<string, LucideIcon> = {
  cash: Wallet,
  savings: PiggyBank,
  securities: CandlestickChart,
  life_insurance: ShieldCheck,
  retirement: Landmark,
  crypto: Bitcoin,
  real_estate: Building2,
  vehicle: Car,
  collectible: Gem,
  private_equity: LineChart,
  receivable: HandCoins,
  loan: Scale,
  credit_card: CreditCard,
  other_liability: Scale,
  opening_balance: Banknote,
};

export function AccountIcon({ kind, className }: { kind: string; className?: string }) {
  const Icon = ICONS[kind] ?? Wallet;
  return (
    <span
      className={cn(
        'bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg',
        className,
      )}
      aria-hidden
    >
      <Icon className="size-4.5" />
    </span>
  );
}
