#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
/* Query a named PCM with the host's existing ALSA plugin; never writes samples. */
typedef struct _snd_pcm snd_pcm_t;
typedef struct _snd_pcm_hw_params snd_pcm_hw_params_t;
int main(int argc, char **argv) {
    if (argc != 2) return 64;
    void *lib = dlopen("/usr/lib/libasound.so.2", RTLD_NOW | RTLD_LOCAL);
    if (!lib) { fprintf(stderr, "%s\n", dlerror()); return 70; }
    int (*open_pcm)(snd_pcm_t **, const char *, int, int) = dlsym(lib, "snd_pcm_open");
    int (*close_pcm)(snd_pcm_t *) = dlsym(lib, "snd_pcm_close");
    int (*alloc)(snd_pcm_hw_params_t **) = dlsym(lib, "snd_pcm_hw_params_malloc");
    void (*free_params)(snd_pcm_hw_params_t *) = dlsym(lib, "snd_pcm_hw_params_free");
    int (*any)(snd_pcm_t *, snd_pcm_hw_params_t *) = dlsym(lib, "snd_pcm_hw_params_any");
    int (*min_ch)(const snd_pcm_hw_params_t *, unsigned *) = dlsym(lib, "snd_pcm_hw_params_get_channels_min");
    int (*max_ch)(const snd_pcm_hw_params_t *, unsigned *) = dlsym(lib, "snd_pcm_hw_params_get_channels_max");
    const char *(*error)(int) = dlsym(lib, "snd_strerror");
    int (*format_value)(const char *) = dlsym(lib, "snd_pcm_format_value");
    int (*test_format)(snd_pcm_t *, snd_pcm_hw_params_t *, int) = dlsym(lib, "snd_pcm_hw_params_test_format");
    int (*test_rate)(snd_pcm_t *, snd_pcm_hw_params_t *, unsigned, int) = dlsym(lib, "snd_pcm_hw_params_test_rate");
    if (!open_pcm || !close_pcm || !alloc || !free_params || !any || !min_ch || !max_ch || !error) return 70;
    snd_pcm_t *pcm = NULL;
    int code = open_pcm(&pcm, argv[1], 0, 1); /* PLAYBACK, NONBLOCK */
    printf("open_result=%d\n", code);
    if (code < 0) { printf("error=%s\n", error(code)); return 1; }
    snd_pcm_hw_params_t *params = NULL;
    if (alloc(&params) < 0) { close_pcm(pcm); return 1; }
    code = any(pcm, params);
    unsigned lo = 0, hi = 0;
    if (code >= 0) { min_ch(params, &lo); max_ch(params, &hi); }
    printf("capabilities_result=%d\nchannels_min=%u\nchannels_max=%u\n", code, lo, hi);
    if (code >= 0 && format_value && test_format && test_rate) {
        const char *formats[] = {"S16_LE", "S24_LE", "S24_3LE", "S32_LE", "FLOAT_LE"};
        for (unsigned i = 0; i < 5; i++)
            printf("format_%s=%d\n", formats[i], test_format(pcm, params, format_value(formats[i])));
        printf("rate_48000=%d\nrate_44100=%d\n", test_rate(pcm, params, 48000, 0), test_rate(pcm, params, 44100, 0));
    }
    free_params(params); close_pcm(pcm); dlclose(lib);
    return code < 0;
}
