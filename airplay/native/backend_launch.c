#define _GNU_SOURCE
#include <errno.h>
#include <grp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <unistd.h>
#include <sched.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <fcntl.h>

/* BMW OAP UIDs are allocated dynamically and have no passwd/NSS record.
   Drop every root identity before executing Node; no arbitrary program path. */
int main(int argc, char **argv) {
    if (argc < 2 || argc > 3 || getuid() != 0 || geteuid() != 0) return 64;
    char *end = NULL;
    errno = 0;
    unsigned long number = strtoul(argv[1], &end, 10);
    if (errno || !end || *end || number < 12203 || number > 12450) return 64;
    uid_t uid = (uid_t)number;
    /* Only our descendants see uplink DNS. Preserve the unit's global resolver
       and make mounts private before binding anything. No root daemon remains. */
    if (argc != 3) {
        if (unshare(CLONE_NEWNS)) { perror("AirPlay namespace unshare"); return 73; }
        if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL)) { perror("AirPlay namespace propagation"); return 73; }
        /* Open after unshare: an fd on the parent's mount cannot be used as a
           bind source through /proc/self/fd in the new mount namespace. */
        int fd = open("/run/mgu-airplay/resolv.conf", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
        struct stat st;
        if (fd < 0 || fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_uid != uid || st.st_nlink != 1 || st.st_size > 4096) {
            perror("AirPlay private resolver"); return 72;
        }
        char source[64]; snprintf(source, sizeof(source), "/proc/self/fd/%d", fd);
        if (mount(source, "/etc/resolv.conf", NULL, MS_BIND, NULL)) { perror("AirPlay resolver bind"); close(fd); return 73; }
        if (mount(NULL, "/etc/resolv.conf", NULL, MS_BIND | MS_REMOUNT | MS_RDONLY, NULL)) {
            perror("AirPlay resolver read-only bind"); close(fd); return 73;
        }
        close(fd);
    }
    gid_t groups[] = {903, 904, 905, 917, 12202, 13003, (gid_t)uid};
    struct rlimit core = {1, 1};
    if (setrlimit(RLIMIT_CORE, &core) || setgroups(sizeof(groups) / sizeof(groups[0]), groups) ||
        setresgid(uid, uid, uid) || setresuid(uid, uid, uid) ||
        prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || getuid() != uid || geteuid() != uid) {
        perror("AirPlay privilege drop"); return 70;
    }
    char script[256];
    snprintf(script, sizeof(script), "/var/opt/public/oap/oap_%u/source/javascript/backend.js", (unsigned)uid);
    if (argc == 3) {
        if (strcmp(argv[2], "--check") || access(script, R_OK)) return 65;
        printf("AirPlay backend identity verified: uid=%u gid=%u\n", (unsigned)getuid(), (unsigned)getgid());
        return 0;
    }
    char *args[] = {"/usr/bin/node", script, NULL};
    execv(args[0], args);
    perror("AirPlay backend exec"); return 71;
}
