// 位置による重み付け合計mod基数のチェックデジット(ISBN方式に類似)。
// 1文字の入力ミスや隣接2文字の入れ替えを高確率で検出する。
// 重みは (i % (base - 1)) + 1 とし、常に 1〜base-1 の範囲に収まるようにする
// (単純な (i + 1) % base だと i = base-1 の位置で重みが0になり、その位置の置換誤りを検出できなくなるため)。
export function computeChecksumChar(payload: string, alphabet: readonly string[]): string {
  const base = alphabet.length;
  const index = new Map(alphabet.map((ch, i) => [ch, i]));
  let sum = 0;
  for (let i = 0; i < payload.length; i++) {
    const digit = index.get(payload[i]);
    if (digit === undefined) {
      throw new Error(`character "${payload[i]}" is not in the alphabet`);
    }
    const weight = (i % (base - 1)) + 1;
    sum = (sum + digit * weight) % base;
  }
  return alphabet[sum];
}

export function verifyChecksum(payload: string, checksumChar: string, alphabet: readonly string[]): boolean {
  return computeChecksumChar(payload, alphabet) === checksumChar;
}
