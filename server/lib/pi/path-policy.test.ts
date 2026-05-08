import { describe, expect, test } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  checkReadAccess,
  checkWriteAccess,
  expandHome,
  matchesGlob,
  pathIsUnder,
  resolveToolPath,
} from "./path-policy.ts";
import { buildPiSandboxPolicy } from "./sandbox-policy.ts";

const PROJ = "/var/zero/projects/p1";
const SOCK = "/tmp/zero-pi-sockets/run-1";
const policy = buildPiSandboxPolicy({ projectDir: PROJ, socketDir: SOCK });

describe("expandHome", () => {
  test("rewrites ~ and ~/...", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/foo")).toBe(join(homedir(), "foo"));
    expect(expandHome("/abs")).toBe("/abs");
    expect(expandHome("rel")).toBe("rel");
  });
});

describe("resolveToolPath", () => {
  test("project-relative paths resolve under cwd", () => {
    expect(resolveToolPath("hello.txt", PROJ)).toBe(`${PROJ}/hello.txt`);
    expect(resolveToolPath(undefined, PROJ)).toBe(PROJ);
    expect(resolveToolPath("", PROJ)).toBe(PROJ);
  });
  test("absolute paths and ~ are honored", () => {
    expect(resolveToolPath("/etc/hosts", PROJ)).toBe("/etc/hosts");
    expect(resolveToolPath("~/.ssh/id_rsa", PROJ)).toBe(
      join(homedir(), ".ssh", "id_rsa"),
    );
  });
  test("..-traversal collapses to a normalized path", () => {
    expect(resolveToolPath("../../etc/hosts", PROJ)).toBe(
      "/var/zero/etc/hosts",
    );
  });
});

describe("pathIsUnder", () => {
  test("strict and equal prefixes match; siblings don't", () => {
    expect(pathIsUnder(`${PROJ}/a`, PROJ)).toBe(true);
    expect(pathIsUnder(PROJ, PROJ)).toBe(true);
    expect(pathIsUnder("/var/zero/projects/p11", PROJ)).toBe(false);
    expect(pathIsUnder("/var/zero", PROJ)).toBe(false);
  });
});

describe("matchesGlob", () => {
  test("bare name patterns match by basename", () => {
    expect(matchesGlob("/proj/secret.pem", "*.pem")).toBe(true);
    expect(matchesGlob("/proj/.env", ".env")).toBe(true);
    expect(matchesGlob("/proj/.env.local", ".env")).toBe(false);
    expect(matchesGlob("/proj/.env.local", ".env.*")).toBe(true);
    expect(matchesGlob("/proj/key.pub", "*.key")).toBe(false);
  });
});

describe("checkReadAccess", () => {
  test("project files are readable", () => {
    expect(checkReadAccess(`${PROJ}/hello.txt`, policy).allowed).toBe(true);
  });
  test("~/.ssh and friends are denied", () => {
    expect(
      checkReadAccess(join(homedir(), ".ssh", "id_rsa"), policy).allowed,
    ).toBe(false);
    expect(
      checkReadAccess(join(homedir(), ".aws", "credentials"), policy).allowed,
    ).toBe(false);
  });
  test("system libs are not denied (read is permissive)", () => {
    expect(checkReadAccess("/etc/hosts", policy).allowed).toBe(true);
  });
});

describe("checkWriteAccess", () => {
  test("project + /tmp + socket dir are writable", () => {
    expect(checkWriteAccess(`${PROJ}/out.txt`, policy).allowed).toBe(true);
    expect(checkWriteAccess(`${SOCK}/x`, policy).allowed).toBe(true);
    expect(checkWriteAccess("/tmp/scratch", policy).allowed).toBe(true);
  });
  test("paths outside allowWrite are blocked", () => {
    expect(checkWriteAccess("/etc/hosts", policy).allowed).toBe(false);
    expect(
      checkWriteAccess(join(homedir(), "evil.txt"), policy).allowed,
    ).toBe(false);
  });
  test("denyWrite globs win even inside allowWrite", () => {
    expect(checkWriteAccess(`${PROJ}/.env`, policy).allowed).toBe(false);
    expect(checkWriteAccess(`${PROJ}/x/y/secret.pem`, policy).allowed).toBe(
      false,
    );
  });
});
