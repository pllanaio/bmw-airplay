"""Export bounded audio-only Now Playing metadata without a video surface."""


def once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Unexpected UxPlay audio metadata source: ' + old[:80])
    return text.replace(old, new)


def patch(source, ux, video):
    del source
    ux = once(ux, 'static int register_dnssd() {', '#include "mgu_audio_metadata.h"\n\nstatic int register_dnssd() {')
    for anchor, statement in [
        ('extern "C" void audio_set_metadata(void *cls, const void *buffer, int buflen) {',
         '    if (mgu_audio_only) { mgu_audio_metadata_receive(buffer, buflen); return; }'),
        ('extern "C" void audio_set_coverart(void *cls, const void *buffer, int buflen) {',
         '    if (mgu_audio_only) { mgu_audio_metadata_artwork(buffer, buflen); return; }'),
        ('extern "C" void audio_get_format (void *cls, unsigned char *ct, unsigned short *spf, bool *usingScreen, bool *isMedia, uint64_t *audioFormat) {',
         '    mgu_audio_metadata_clear();'),
        ('extern "C" void audio_stop_coverart_rendering(void *cls) {', '    mgu_audio_metadata_clear();'),
        ('    if (open_connections == 0) {', '        mgu_audio_metadata_clear();'),
        ('    mgu_audio_configure();', '    mgu_audio_metadata_clear();'),
    ]:
        ux = once(ux, anchor, anchor + '\n' + statement)
    return ux, video
