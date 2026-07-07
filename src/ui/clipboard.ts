// リプレイテキストのクリップボードコピー (F6)。
// clipboard API が使えない/失敗する環境では window.prompt へフォールバックし、
// 手動コピーさせる。

/**
 * text をクリップボードへコピーする。成功時のみ onSuccess を呼ぶ
 * (フォールバック時はユーザーが手動でコピーするため呼ばない)。
 */
export function copyReplayText(text: string, onSuccess: () => void): void {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(onSuccess)
      .catch(() => {
        window.prompt('コピーしてください', text);
      });
  } else {
    window.prompt('コピーしてください', text);
  }
}
