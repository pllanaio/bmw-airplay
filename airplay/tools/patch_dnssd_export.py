"""Export UxPlay's DNS-SD registrations on stdout.

The BMW mdnsd announces the receiver on the car's own interfaces only. On
the Wi-Fi uplink (the iPhone hotspot, wlan1/wlan0 managed by mgu-uplink)
nobody does. The backend therefore announces the very same records there:
after each registration UxPlay prints

    MGU_DNSSD <raop|airplay> <port> <hex service name> <hex TXT record>

and on removal ``MGU_DNSSD_STOP <raop|airplay>``. Hex keeps names with
spaces and binary TXT data on one line. GPL-3.0-or-later like UxPlay.
"""


def once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Unexpected UxPlay dnssd.c for export patch: ' + old[:60])
    return text.replace(old, new)


HELPER = '''/* MGU: the backend announces these records on the Wi-Fi uplink. */
static void
mgu_dnssd_hex(const unsigned char *data, int length)
{
    for (int i = 0; i < length; i++) printf("%02x", data[i]);
}

static void
mgu_dnssd_export(const char *kind, const char *name, unsigned short port, const void *txt, int txt_length, int status)
{
    if (status != 0 || !name || !txt || txt_length < 0) return;
    printf("MGU_DNSSD %s %u ", kind, (unsigned) port);
    mgu_dnssd_hex((const unsigned char *) name, (int) strlen(name));
    printf(" ");
    mgu_dnssd_hex((const unsigned char *) txt, txt_length);
    printf("\\n");
    fflush(stdout);
}

int
dnssd_register_raop(dnssd_t *dnssd, unsigned short port)'''


def patch(text):
    text = once(text, 'int\ndnssd_register_raop(dnssd_t *dnssd, unsigned short port)', HELPER)
    for kind, record, name in [('raop', 'raop_record', 'servname'), ('airplay', 'airplay_record', 'dnssd->name')]:
        anchor = '''                                                          dnssd->TXTRecordGetBytesPtr(&dnssd->%s),
                                                          NULL, NULL);
''' % record
        if kind == 'airplay':
            anchor = anchor.replace('                                                          ', '                                                           ')
        text = once(text, anchor, anchor + '''    mgu_dnssd_export("%s", %s, port, dnssd->TXTRecordGetBytesPtr(&dnssd->%s),
                     dnssd->TXTRecordGetLength(&dnssd->%s), (int) retval);
''' % (kind, name, record, record))
    for kind in ['raop', 'airplay']:
        anchor = '''dnssd_unregister_%s(dnssd_t *dnssd)
{
    assert(dnssd);
''' % kind
        text = once(text, anchor, anchor + '''    printf("MGU_DNSSD_STOP %s\\n"); fflush(stdout);
''' % kind)
    return text
