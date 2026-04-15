/**
 * Hard caps on exec stdout/stderr before they enter tool-result Parts.
 *
 * Prior to this, a runaway command (`yes | head -c 50M`, verbose build
 * output, etc.) would pass its full text through the message pipeline:
 * into the scene broadcast, into the DB message row, and into the model
 * context on the next turn. This is both a heap and a token disaster.
 *
 * Cap sizes are defensive — the runner usually truncates too, but we
 * don't trust it. Overflow bytes spill into the blob store so the full
 * output can still be retrieved on demand.
 */
import { putBlob } from "@/lib/media/blob-store.ts";

export const STDOUT_CAP_BYTES = Number(process.env.EXEC_STDOUT_CAP ?? 1_000_000);
export const STDERR_CAP_BYTES = Number(process.env.EXEC_STDERR_CAP ?? 256_000);
const TAIL_KEEP = 8_000;

export interface CappedStream {
  text: string;
  /** Present iff the original exceeded cap. */
  overflow?: { hash: string; size: number; originalBytes: number };
}

export async function capExecText(
  s: string,
  cap: number,
  label: string,
  projectId?: string,
): Promise<CappedStream> {
  const byteLen = Buffer.byteLength(s, "utf8");
  if (byteLen <= cap) return { text: s };
  const bytes = Buffer.from(s, "utf8");
  const { hash, size } = await putBlob(bytes, "text/plain; charset=utf-8", projectId);
  // Compute head/tail by byte boundaries so we don't split a UTF-8 code point.
  const headBytes = Math.max(0, cap - TAIL_KEEP - 256);
  const head = sliceByBytes(bytes, 0, headBytes);
  const tail = sliceByBytes(bytes, Math.max(0, bytes.byteLength - TAIL_KEEP), bytes.byteLength);
  return {
    text: `${head}\n\n[… ${label} truncated, ${byteLen} bytes total — full output at blob:${hash} …]\n\n${tail}`,
    overflow: { hash, size, originalBytes: byteLen },
  };
}

/** Decode a byte range of a UTF-8 buffer, trimming any partial leading/trailing code points. */
function sliceByBytes(buf: Buffer, start: number, end: number): string {
  // Node's TextDecoder with fatal:false replaces partial sequences, but we'd
  // rather drop them. Nudge start forward / end backward off continuation bytes.
  let s = start;
  while (s < end && (buf[s]! & 0xc0) === 0x80) s++;
  let e = end;
  while (e > s && (buf[e - 1]! & 0xc0) === 0x80) e--;
  // Also back off if the last byte starts a multi-byte sequence that we've cut short.
  if (e > s) {
    const last = buf[e - 1]!;
    if ((last & 0xe0) === 0xc0) e -= 1;
    else if ((last & 0xf0) === 0xe0) e -= 1;
    else if ((last & 0xf8) === 0xf0) e -= 1;
  }
  return buf.toString("utf8", s, e);
}

export async function capExecResult(
  stdout: string,
  stderr: string,
  projectId?: string,
): Promise<{ stdout: string; stderr: string; stdoutOverflow?: CappedStream["overflow"]; stderrOverflow?: CappedStream["overflow"] }> {
  const [out, err] = await Promise.all([
    capExecText(stdout, STDOUT_CAP_BYTES, "stdout", projectId),
    capExecText(stderr, STDERR_CAP_BYTES, "stderr", projectId),
  ]);
  return {
    stdout: out.text,
    stderr: err.text,
    stdoutOverflow: out.overflow,
    stderrOverflow: err.overflow,
  };
}
