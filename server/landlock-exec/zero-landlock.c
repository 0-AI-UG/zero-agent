// zero-landlock — apply a Landlock filesystem ruleset, then exec a command.
//
// Why this exists: zero-server runs as capless root (CapEff=0) on a shared,
// hardened OCD host where unprivileged user namespaces are blocked, so
// bubblewrap (the sandbox-runtime Linux backend) cannot engage and bash
// falls back to unsandboxed — letting a prompt-injected command read/write
// sibling projects under the projects root. Landlock is the one FS-sandbox
// primitive that works here: it needs no capabilities and no user namespace,
// only PR_SET_NO_NEW_PRIVS (already set on the container). Verified usable at
// ABI v4 on the prod kernel (6.8).
//
// Model: Landlock is deny-by-default allowlist. We grant rw on the project
// dir + /tmp, ro on system dirs + the zero package/agent roots, rw on a few
// /dev nodes. The projects ROOT is never granted, so sibling projects are
// denied automatically — no explicit deny needed.
//
// Usage:
//   zero-landlock --check                       # exit 0 if Landlock usable
//   zero-landlock [--rw DIR]... [--ro DIR]... [--rwfile FILE]... -- CMD [ARG]...
//
// Fail-closed: if a ruleset cannot be created/applied, we exit non-zero
// rather than exec unsandboxed. Missing allow paths are skipped (a dir that
// doesn't exist yet is simply not granted), which is not a failure.

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif

#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#define LANDLOCK_RULE_PATH_BENEATH 1

// Filesystem access-right bits (stable UAPI).
#define A_EXECUTE     (1ULL << 0)
#define A_WRITE_FILE  (1ULL << 1)
#define A_READ_FILE   (1ULL << 2)
#define A_READ_DIR    (1ULL << 3)
#define A_REMOVE_DIR  (1ULL << 4)
#define A_REMOVE_FILE (1ULL << 5)
#define A_MAKE_CHAR   (1ULL << 6)
#define A_MAKE_DIR    (1ULL << 7)
#define A_MAKE_REG    (1ULL << 8)
#define A_MAKE_SOCK   (1ULL << 9)
#define A_MAKE_FIFO   (1ULL << 10)
#define A_MAKE_BLOCK  (1ULL << 11)
#define A_MAKE_SYM    (1ULL << 12)
#define A_REFER       (1ULL << 13) // ABI >= 2
#define A_TRUNCATE    (1ULL << 14) // ABI >= 3
#define A_IOCTL_DEV   (1ULL << 15) // ABI >= 5

struct landlock_ruleset_attr {
  uint64_t handled_access_fs;
  uint64_t handled_access_net;
};

struct landlock_path_beneath_attr {
  uint64_t allowed_access;
  int32_t parent_fd;
} __attribute__((packed));

static int abi_version(void) {
  return (int)syscall(__NR_landlock_create_ruleset, NULL, (size_t)0,
                      LANDLOCK_CREATE_RULESET_VERSION);
}

// Full FS mask the kernel handles at the given ABI. handled_access_fs must
// not include bits the running kernel doesn't know, or create_ruleset fails.
static uint64_t handled_fs_for_abi(int abi) {
  uint64_t m = A_EXECUTE | A_WRITE_FILE | A_READ_FILE | A_READ_DIR |
               A_REMOVE_DIR | A_REMOVE_FILE | A_MAKE_CHAR | A_MAKE_DIR |
               A_MAKE_REG | A_MAKE_SOCK | A_MAKE_FIFO | A_MAKE_BLOCK |
               A_MAKE_SYM;            // ABI 1
  if (abi >= 2) m |= A_REFER;
  if (abi >= 3) m |= A_TRUNCATE;
  if (abi >= 5) m |= A_IOCTL_DEV;
  return m;
}

static int add_path(int ruleset_fd, const char *path, uint64_t access) {
  int pfd = open(path, O_PATH | O_CLOEXEC);
  if (pfd < 0) {
    // Missing path: skip silently (allowlist entry that doesn't exist yet).
    if (errno == ENOENT) return 0;
    fprintf(stderr, "zero-landlock: open %s: %s\n", path, strerror(errno));
    return -1;
  }
  struct landlock_path_beneath_attr pb = {.allowed_access = access,
                                          .parent_fd = pfd};
  int rc = (int)syscall(__NR_landlock_add_rule, ruleset_fd,
                        LANDLOCK_RULE_PATH_BENEATH, &pb, 0U);
  int saved = errno;
  close(pfd);
  if (rc != 0) {
    fprintf(stderr, "zero-landlock: add_rule %s: %s\n", path, strerror(saved));
    return -1;
  }
  return 0;
}

int main(int argc, char **argv) {
  int abi = abi_version();
  if (argc == 2 && strcmp(argv[1], "--check") == 0) {
    if (abi >= 1) {
      printf("landlock-abi=%d\n", abi);
      return 0;
    }
    fprintf(stderr, "zero-landlock: unavailable (abi=%d errno=%d)\n", abi, errno);
    return 1;
  }

  // Collect allow-lists and find the "--" separator.
  const char **rw = calloc(argc, sizeof(char *));
  const char **ro = calloc(argc, sizeof(char *));
  const char **rwf = calloc(argc, sizeof(char *));
  int nrw = 0, nro = 0, nrwf = 0;
  int cmd_start = -1;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) {
      cmd_start = i + 1;
      break;
    } else if (strcmp(argv[i], "--rw") == 0 && i + 1 < argc) {
      rw[nrw++] = argv[++i];
    } else if (strcmp(argv[i], "--ro") == 0 && i + 1 < argc) {
      ro[nro++] = argv[++i];
    } else if (strcmp(argv[i], "--rwfile") == 0 && i + 1 < argc) {
      rwf[nrwf++] = argv[++i];
    } else {
      fprintf(stderr, "zero-landlock: unknown arg: %s\n", argv[i]);
      return 2;
    }
  }
  if (cmd_start < 0 || cmd_start >= argc) {
    fprintf(stderr, "zero-landlock: no command after --\n");
    return 2;
  }

  if (abi < 1) {
    // Fail closed: caller only routes through us when it believes Landlock
    // works, so a surprise here means the security control is absent.
    fprintf(stderr, "zero-landlock: Landlock unavailable (abi=%d) — refusing "
                    "to run unsandboxed\n", abi);
    return 126;
  }

  uint64_t handled = handled_fs_for_abi(abi);
  struct landlock_ruleset_attr rsattr = {.handled_access_fs = handled,
                                         .handled_access_net = 0};
  int ruleset_fd = (int)syscall(__NR_landlock_create_ruleset, &rsattr,
                                sizeof(rsattr), 0U);
  if (ruleset_fd < 0) {
    fprintf(stderr, "zero-landlock: create_ruleset: %s\n", strerror(errno));
    return 126;
  }

  // RW dirs get the full handled mask; RO dirs get read+traverse+execute;
  // RW files get read/write (+truncate/ioctl where the ABI handles them).
  uint64_t ro_access = A_READ_FILE | A_READ_DIR | A_EXECUTE;
  uint64_t rwfile_access = A_READ_FILE | A_WRITE_FILE;
  if (abi >= 3) rwfile_access |= A_TRUNCATE;
  if (abi >= 5) rwfile_access |= A_IOCTL_DEV;

  for (int i = 0; i < nrw; i++)
    if (add_path(ruleset_fd, rw[i], handled) != 0) return 126;
  for (int i = 0; i < nro; i++)
    if (add_path(ruleset_fd, ro[i], ro_access) != 0) return 126;
  for (int i = 0; i < nrwf; i++)
    if (add_path(ruleset_fd, rwf[i], rwfile_access) != 0) return 126;

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fprintf(stderr, "zero-landlock: prctl(NO_NEW_PRIVS): %s\n", strerror(errno));
    return 126;
  }
  if (syscall(__NR_landlock_restrict_self, ruleset_fd, 0U) != 0) {
    fprintf(stderr, "zero-landlock: restrict_self: %s\n", strerror(errno));
    return 126;
  }
  close(ruleset_fd);

  execvp(argv[cmd_start], &argv[cmd_start]);
  fprintf(stderr, "zero-landlock: exec %s: %s\n", argv[cmd_start],
          strerror(errno));
  return 127;
}
