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

export async function capExecText(s: string, cap: number, label: string): Promise<CappedStream> {
  if (s.length <= cap) return { text: s };
  const bytes = Buffer.from(s, "utf8");
  const { hash, size } = await putBlob(bytes, "text/plain; charset=utf-8");
  const headLen = Math.max(0, cap - TAIL_KEEP - 256);
  const head = s.slice(0, headLen);
  const tail = s.slice(-TAIL_KEEP);
  return {
    text: `${head}\n\n[… ${label} truncated, ${bytes.byteLength} bytes total — full output at blob:${hash} …]\n\n${tail}`,
    overflow: { hash, size, originalBytes: bytes.byteLength },
  };
}

export async function capExecResult(
  stdout: string,
  stderr: string,
): Promise<{ stdout: string; stderr: string; stdoutOverflow?: CappedStream["overflow"]; stderrOverflow?: CappedStream["overflow"] }> {
  const [out, err] = await Promise.all([
    capExecText(stdout, STDOUT_CAP_BYTES, "stdout"),
    capExecText(stderr, STDERR_CAP_BYTES, "stderr"),
  ]);
  return {
    stdout: out.text,
    stderr: err.text,
    stdoutOverflow: out.overflow,
    stderrOverflow: err.overflow,
  };
}
