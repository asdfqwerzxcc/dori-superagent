import { renameSync } from "node:fs";

// Windows refuses to replace a file another process has open for reading (EPERM/EBUSY). The reader closes it within
// a moment, so a bounded synchronous retry turns that sharing violation back into the atomic rename it should be.
const REPLACE_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const REPLACE_ATTEMPTS = 20;
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

export function replaceFile(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt === REPLACE_ATTEMPTS || code === undefined || !REPLACE_RETRY_CODES.has(code)) throw e;
      Atomics.wait(PAUSE, 0, 0, 1);
    }
  }
}
