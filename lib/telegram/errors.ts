/**
 * Error thrown by the Telegram API client. `code`/`description` come straight from
 * Telegram's response body (`error_code`/`description`); `retryAfter` is populated from
 * `parameters.retry_after` on a 429. For transport failures (network error, timeout, or an
 * externally aborted request) there is no Telegram error code, so `code` is 0 and
 * `description` explains the local reason instead.
 *
 * The bot token must only ever appear in the request URL path — never here, in
 * `description` or any other field of this error.
 */
export class TelegramError extends Error {
  constructor(
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number
  ) {
    super(`telegram api error ${code}: ${description}`);
    this.name = "TelegramError";
  }
}
