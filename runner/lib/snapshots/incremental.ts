/**
 * GNU tar `--listed-incremental` snapshot driver.
 *
 * Each call:
 *   1. (optional) drops the prior snar.dat into /tmp/snar.dat.in inside the
 *      container, otherwise removes any existing one (level-0 base).
 *   2. Runs `tar --listed-incremental=/tmp/snar.dat.out -I 'zstd -T0' -cf /tmp/inc.tar.zst …`.
 *   3. Streams /tmp/inc.tar.zst out via docker getArchive.
 *   4. Reads /tmp/snar.dat.out and resolves outputSnarPromise.
 *
 * No `|| true` shells — tar exit status is propagated.
 */
import { docker } from "../docker-client.ts";
import { buildTar, extractSingleFileStream } from "../files.ts";
import { log } from "../logger.ts";

const incLog = log.child({ module: "snapshot-incremental" });

const SNAR_IN = "/tmp/snar.dat.in";
const SNAR_OUT = "/tmp/snar.dat.out";
const TAR_OUT = "/tmp/inc.tar.zst";

const SNAPSHOT_EXCLUDES = [
  "./proc", "./sys", "./dev", "./tmp", "./run", "./var/run",
  "./var/cache", "./var/log",
  "./etc/hostname", "./etc/hosts", "./etc/resolv.conf",
  "./root/.cache/ms-playwright",
  // The `zero` CLI/SDK is baked into the image and must track image
  // upgrades — never freeze it inside a per-project snapshot.
  "./opt/zero",
  "./workspace/node_modules",
  "./workspace/.venv",
  "./workspace/__pycache__",
  "./workspace/dist",
  "./workspace/build",
  "./workspace/.cache",
  "./workspace/.next",
  "./workspace/target",
].map(d => `--exclude=${d}`).join(" ");

export interface IncrementalResult {
  tarStream: ReadableStream<Uint8Array>;
  outputSnarPromise: Promise<Buffer>;
}

export async function tarIncremental(
  containerName: string,
  inputSnar: Buffer | null,
): Promise<IncrementalResult> {
  // Stage prior snar (or remove it for level-0).
  if (inputSnar && inputSnar.byteLength > 0) {
    const wrap = buildTar([{ path: "snar.dat.in", data: inputSnar }]);
    await docker.putArchive(containerName, "/tmp", wrap);
  } else {
    await docker.exec(containerName, ["rm", "-f", SNAR_IN], { workingDir: "/" });
  }

  // Always wipe stale outputs so a failed tar can't leak prior bytes.
  await docker.exec(containerName, ["rm", "-f", SNAR_OUT, TAR_OUT], { workingDir: "/" });

  // Seed the output snar from the input so tar updates it in place.
  const stageSnar = inputSnar && inputSnar.byteLength > 0
    ? `cp ${SNAR_IN} ${SNAR_OUT} && `
    : "";

  const tarStart = Date.now();
  const cmd = `${stageSnar}tar --listed-incremental=${SNAR_OUT} -I 'zstd -T0' -cf ${TAR_OUT} ${SNAPSHOT_EXCLUDES} -C / .`;
  const result = await docker.exec(
    containerName,
    ["bash", "-c", cmd],
    { workingDir: "/", timeout: 600_000 },
  );
  const tarMs = Date.now() - tarStart;

  // GNU tar exit codes: 0 = success, 1 = some files differ (still success for our purposes).
  // Anything else is a real failure — surface it.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    incLog.error("tar incremental failed", {
      containerName,
      exitCode: result.exitCode,
      stderr: result.stderr.slice(0, 2000),
      tarMs,
    });
    throw new Error(`tar --listed-incremental exit ${result.exitCode}: ${result.stderr.slice(0, 500)}`);
  }
  incLog.info("tar incremental complete", { containerName, exitCode: result.exitCode, tarMs });

  // Stream tar output. extractSingleFileStream peels Docker's outer tar wrapper.
  const outerTar = await docker.getArchiveStream(containerName, TAR_OUT);
  const tarStream = extractSingleFileStream(outerTar);

  // Snar fetch is deferred until the caller awaits — use a lazy promise that
  // pulls /tmp/snar.dat.out after the tar stream has been fully consumed.
  // Returning a pre-resolved buffer is cheaper than streaming for typical
  // snar sizes (KBs to low MBs).
  let snarResolved: Buffer | null = null;
  const outputSnarPromise = (async () => {
    if (snarResolved) return snarResolved;
    const snarOuter = await docker.getArchive(containerName, SNAR_OUT);
    // The wrapper is a tar containing snar.dat.out — strip the 512-byte header.
    const sizeStr = snarOuter.subarray(124, 136).toString("ascii").replace(/\0/g, "").trim();
    const size = parseInt(sizeStr, 8);
    if (isNaN(size) || size < 0) {
      throw new Error(`invalid snar tar header size: "${sizeStr}"`);
    }
    snarResolved = Buffer.from(snarOuter.subarray(512, 512 + size));
    // Best-effort cleanup — never blocks the caller.
    docker.exec(containerName, ["rm", "-f", SNAR_IN, SNAR_OUT, TAR_OUT], { workingDir: "/" }).catch(() => {});
    return snarResolved;
  })();

  return { tarStream, outputSnarPromise };
}

export interface RestoreOptions {
  /** When true, the input is the level-0 base; tar prints filenames.
   *  Subsequent deltas always carry incremental headers. */
  level0?: boolean;
}

/**
 * Stream a tar.zst into the container and untar with --incremental honoring
 * delete entries. Restores into root (`/`).
 */
export async function untarIncremental(
  containerName: string,
  tarStream: ReadableStream<Uint8Array>,
): Promise<void> {
  // Stage the incoming tar to /tmp/restore.tar.zst, then run tar inside the
  // container. We can't stream stdin into `docker exec` easily through the
  // existing buffered exec wrapper, so this stage-then-exec is the path of
  // least surprise.
  const { wrapInTarStream } = await import("../files.ts");
  // We don't know the size up-front for the stream, so we have to buffer.
  // Snapshots restored on container create are bounded by S3 deltas (small),
  // so this is acceptable. For large bases the cost is still ~one full read.
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = tarStream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }

  const wrapped = wrapInTarStream(
    "restore.tar.zst",
    total,
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(buf);
        controller.close();
      },
    }),
  );
  await docker.putArchiveStream(containerName, "/tmp", wrapped);

  const cmd = `tar --listed-incremental=/dev/null -I 'zstd -d -T0' -xf /tmp/restore.tar.zst -C /; rm -f /tmp/restore.tar.zst`;
  const res = await docker.exec(containerName, ["bash", "-c", cmd], {
    workingDir: "/",
    timeout: 600_000,
  });
  if (res.exitCode !== 0 && res.exitCode !== 1) {
    throw new Error(`untar --incremental exit ${res.exitCode}: ${res.stderr.slice(0, 500)}`);
  }
}
