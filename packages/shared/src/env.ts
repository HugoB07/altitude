/**
 * Reading configuration that must be present.
 *
 * The pattern this exists to replace:
 *
 *   const url = process.env.DATABASE_URL ?? 'postgres://user:pass@localhost/db';
 *
 * A fallback turns a missing variable into a silent connection to the wrong
 * place. Nothing errors; the process starts, reports itself healthy, and reads
 * or writes somewhere nobody intended. A migration lands on a developer's
 * laptop database. A production worker quietly finds nothing to do. The failure
 * surfaces hours later as missing data, with no line pointing at the cause.
 *
 * Worse for a secret: the fallback is the literal, in the repository, in the
 * history, forever — and it keeps working, so nobody notices it is being used.
 *
 * Missing configuration is a startup failure. It is loud, immediate, and names
 * what is missing.
 */

export class MissingConfigurationError extends Error {
  readonly code = 'MISSING_CONFIGURATION';
  readonly variable: string;

  constructor(variable: string, hint?: string) {
    super(
      `${variable} is not set.` +
        (hint === undefined ? '' : ` ${hint}`) +
        ' See .env.example for the expected value.',
    );
    this.name = 'MissingConfigurationError';
    this.variable = variable;
  }
}

/**
 * Reads a required variable, throwing when it is absent or blank.
 *
 * Blank counts as absent: `DATABASE_URL=` in an env file is a variable someone
 * meant to fill in, not a deliberate empty string.
 *
 * @param hint added to the message — say what the value is for, not what it looks
 *   like, and never include an example containing credentials.
 */
export function requireEnv(name: string, hint?: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new MissingConfigurationError(name, hint);
  }
  return value;
}

/**
 * Reads an optional variable. Only for settings with a genuine, non-secret
 * default — a base currency, a port, a feature flag.
 *
 * Never for a credential, a connection string, or a key. If the absence of a
 * value should change where the process connects or what it can decrypt, it is
 * required: use `requireEnv`.
 */
export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value;
}

/** Reads a boolean flag. Anything other than a recognised true value is false. */
export function envFlag(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}
