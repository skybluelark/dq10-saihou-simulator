export function encodeBaseN(value: bigint, alphabet: readonly string[]): string {
  const base = BigInt(alphabet.length);
  if (value < 0n) throw new Error('value must be non-negative');
  if (value === 0n) return alphabet[0];
  let s = '';
  let n = value;
  while (n > 0n) {
    s = alphabet[Number(n % base)] + s;
    n /= base;
  }
  return s;
}

export function decodeBaseN(text: string, alphabet: readonly string[]): bigint {
  const base = BigInt(alphabet.length);
  const index = new Map(alphabet.map((ch, i) => [ch, i]));
  let n = 0n;
  for (const ch of text) {
    const digit = index.get(ch);
    if (digit === undefined) {
      throw new Error(`character "${ch}" is not in the alphabet`);
    }
    n = n * base + BigInt(digit);
  }
  return n;
}
