/* Diagnostic addresses only: no core, arguments, environment or media data. */
#include <execinfo.h>
#include <signal.h>
#include <unistd.h>
static void mgu_crash_trace(int signal_number) {
    const char marker[] = "MGU_CRASH\n";
    (void)write(STDERR_FILENO, marker, sizeof(marker) - 1);
    void *frames[24];
    int count = backtrace(frames, 24);
    backtrace_symbols_fd(frames, count, STDERR_FILENO);
    _exit(128 + signal_number);
}
__attribute__((constructor)) static void mgu_prepare_crash_trace(void) {
    void *warmup[1]; (void)backtrace(warmup, 1);
    struct sigaction action = {};
    action.sa_handler = mgu_crash_trace;
    sigemptyset(&action.sa_mask);
    action.sa_flags = SA_RESETHAND;
    sigaction(SIGSEGV, &action, NULL); sigaction(SIGABRT, &action, NULL);
}
