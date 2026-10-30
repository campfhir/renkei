/**
 * One file's bytes sent to a route, with progress and a way to stop.
 * `fetch` reports nothing about an upload while it runs, so this is an
 * XMLHttpRequest whose upload events feed `onProgress`; an aborted
 * `signal` cancels the request. Resolves with the status and the parsed
 * JSON body (null when there was none); rejects only when the network
 * failed or the send was aborted (`DOMException` named AbortError).
 */
export interface UploadResponse {
  status: number;
  body: unknown;
}

export function uploadFile(
  url: string,
  file: Blob,
  options: {
    method?: 'PUT' | 'POST';
    headers?: Record<string, string>;
    onProgress?: (loaded: number, total: number) => void;
    signal?: AbortSignal;
  } = {}
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException('The upload was cancelled.', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open(options.method ?? 'PUT', url);
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded, event.total);
    };
    xhr.onload = () => {
      let body: unknown;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => reject(new TypeError('network error'));
    xhr.onabort = () => reject(new DOMException('The upload was cancelled.', 'AbortError'));
    options.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}
