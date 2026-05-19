const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};

const SCALES: Record<string, number> = {
  hundred: 100,
  thousand: 1000,
};

const ALL_WORDS = new Set<string>([
  ...Object.keys(UNITS),
  ...Object.keys(TENS),
  ...Object.keys(SCALES),
  'and',
]);

export function isAmountWord(token: string): boolean {
  return ALL_WORDS.has(token.toLowerCase());
}

/**
 * Parse a sequence of English number words into an integer.
 * Returns null if any token is unrecognized.
 * Examples: "fifty" → 50, "two hundred" → 200, "one thousand five hundred" → 1500.
 */
export function wordsToNumber(input: string): number | null {
  const tokens = input.toLowerCase().split(/[\s-]+/).filter(t => t && t !== 'and');
  if (tokens.length === 0) return null;

  let total = 0;
  let current = 0;

  for (const tok of tokens) {
    if (tok in UNITS) {
      current += UNITS[tok];
    } else if (tok in TENS) {
      current += TENS[tok];
    } else if (tok === 'hundred') {
      current = (current || 1) * 100;
    } else if (tok === 'thousand') {
      total += (current || 1) * 1000;
      current = 0;
    } else {
      return null;
    }
  }

  return total + current;
}

/** Consume amount words from the start of a token list. Returns [amount, remainingTokens] or null. */
export function consumeAmountWords(tokens: string[]): [number, string[]] | null {
  let take = 0;
  while (take < tokens.length && isAmountWord(tokens[take])) take++;
  if (take === 0) return null;
  const amount = wordsToNumber(tokens.slice(0, take).join(' '));
  if (amount === null) return null;
  return [amount, tokens.slice(take)];
}
