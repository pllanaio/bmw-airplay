#define _GNU_SOURCE
#include <sys/prctl.h>
#include <sys/resource.h>
#include <signal.h>
#include <unistd.h>
#include <stdio.h>
int main(int argc, char **argv) {
    if (argc < 2) return 64;
    pid_t parent = getppid();
    if (parent == 1 || prctl(PR_SET_PDEATHSIG, SIGTERM) || getppid() != parent) return 70;
    /* Like MGU Deploy: piped core handlers ignore a zero limit; one byte
       prevents a native receiver failure from reaching the HU crash handler. */
    struct rlimit core = {1, 1};
    if (setrlimit(RLIMIT_CORE, &core)) return 70;
    execv(argv[1], &argv[1]);
    perror("airplay launch");
    return 71;
}
