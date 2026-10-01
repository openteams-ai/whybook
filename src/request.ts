import { URLExt } from '@jupyterlab/coreutils';

import { ServerConnection } from '@jupyterlab/services';

import type { StreamEvent } from './tokens';

/**
 * Call the server extension
 *
 * @param endPoint API REST end point for the extension
 * @param serverSettings The server settings to use for the request
 * @param init Initial values for the request
 * @returns The response body interpreted as JSON
 */
export async function requestAPI<T>(
  endPoint: string,
  serverSettings: ServerConnection.ISettings,
  init: RequestInit = {}
): Promise<T> {
  // Make request to Jupyter API
  const requestUrl = URLExt.join(
    serverSettings.baseUrl,
    'whybook', // our server extension's API namespace
    endPoint
  );

  let response: Response;
  try {
    response = await ServerConnection.makeRequest(
      requestUrl,
      init,
      serverSettings
    );
  } catch (error) {
    // fetch rejects with a TypeError when the server cannot be reached.
    throw new ServerConnection.NetworkError(error as Error);
  }

  const text = await response.text();
  let data: unknown = text;

  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      console.log('Not a JSON response body.', response);
    }
  }

  if (!response.ok) {
    // The error's text: the message of a JSON body, else the body.
    const message = (data as { message?: unknown }).message || data;
    throw new RequestError(response, String(message), data);
  }

  return data as T;
}

/**
 * An error answer of the server extension, with its body: the fields of a
 * JSON body besides its message say more, such as how the check of a key
 * ended (whybook/server/routes.py, check_failed).
 */
export class RequestError extends ServerConnection.ResponseError {
  constructor(
    response: Response,
    message: string,
    readonly body: unknown
  ) {
    super(response, message);
  }
}

/**
 * Call an end point that streams newline-delimited JSON events.
 *
 * Calls `onEvent` once per event, and resolves when the stream ends.
 * Aborting `signal` closes the connection, which stops the call to Claude.
 */
export async function streamAPI(
  endPoint: string,
  serverSettings: ServerConnection.ISettings,
  body: unknown,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const requestUrl = URLExt.join(serverSettings.baseUrl, 'whybook', endPoint);
  let response: Response;
  try {
    response = await ServerConnection.makeRequest(
      requestUrl,
      { method: 'POST', body: JSON.stringify(body), signal },
      serverSettings
    );
  } catch (error) {
    // A TypeError when the server cannot be reached, a DOMException on abort.
    throw new ServerConnection.NetworkError(error as Error);
  }
  if (!response.ok || !response.body) {
    const text = await response.text();
    let message = text;
    try {
      message = JSON.parse(text).message ?? text;
    } catch {
      // The body is not JSON; keep the text.
    }
    throw new ServerConnection.ResponseError(response, message);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf('\n');
    while (end >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line) {
        onEvent(JSON.parse(line) as StreamEvent);
      }
      end = buffer.indexOf('\n');
    }
  }
}
