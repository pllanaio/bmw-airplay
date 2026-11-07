/* Exercise the actual local HTTP playlist handler while current_video changes. */
#include "../../.build/airplay/uxplay-source/lib/raop.c"
static void request_playlist(raop_t *raop, airplay_video_t *video, const char *expected) {
    char input[256];
    const char *base = get_uri_local_prefix(video), *route = strstr(base, "/mgu-hls-");
    assert(route);
    int size = snprintf(input, sizeof input, "GET %s/master.m3u8&subtitleURL=test HTTP/1.1\r\nHost: localhost\r\n\r\n", route);
    http_request_t *request = http_request_init();
    http_request_add_data(request, input, size); assert(http_request_is_complete(request));
    http_response_t *response = http_response_create();
    http_response_init(response, "HTTP/1.1", 200, "OK");
    raop_conn_t conn = {0}; conn.raop = raop;
    char *body = NULL; int length = 0;
    http_handler_hls(&conn, request, response, &body, &length);
    assert(body && !strcmp(body, expected)); free(body);
    http_request_destroy(request); http_response_destroy(response);
}
static char played[8193]; static float position; static int stopped, loading;
static void play(void *cls,const char *url,float start) {(void)cls;snprintf(played,sizeof played,"%s",url);position=start;}
static void load(void *cls) {(void)cls;loading++;}
static void stop(void *cls) {(void)cls;stopped++;}
static void direct(raop_t *raop,const char *data,int length,bool handled,int status) {
    char header[512];
    int size = snprintf(header,sizeof header,"POST /play HTTP/1.1\r\nHost: receiver\r\nContent-Length: %d\r\n\r\n",length);
    http_request_t *request = http_request_init();
    http_request_add_data(request,header,size);http_request_add_data(request,data,length);
    assert(http_request_is_complete(request));
    http_response_t *response=http_response_create();http_response_init(response,"HTTP/1.1",200,"OK");
    raop_conn_t conn={0};conn.raop=raop;
    assert(mgu_direct_play(&conn,request,response)==handled);
    http_response_finish(response,NULL,0);
    int bytes=0; const char *reply=http_response_get_data(response,&bytes);
    char expected[32];snprintf(expected,sizeof expected,"HTTP/1.1 %d",status);
    assert(bytes>0 && !strncmp(reply,expected,strlen(expected)));
    http_request_destroy(request);http_response_destroy(response);
}
static bool detached;
static bool is_detached(void *cls) { (void)cls; return detached; }
static float removed(void *cls) { (void)cls; return 12.0f; }
static void remove_playlist(raop_t *raop) {
    plist_t root = plist_new_dict(), params = plist_new_dict(), item = plist_new_dict();
    plist_dict_set_item(root, "type", plist_new_string("playlistRemove"));
    plist_dict_set_item(item, "uuid", plist_new_string("dddddddd-1111-4222-8333-444444444444"));
    plist_dict_set_item(params, "item", item); plist_dict_set_item(root, "params", params);
    char *body = NULL; uint32_t bytes = 0; plist_to_bin(root, &body, &bytes);
    char header[512];
    int size = snprintf(header, sizeof header, "POST /action HTTP/1.1\r\nHost: receiver\r\nX-Apple-Session-ID: 11111111-2222-4333-8444-555555555555\r\nContent-Type: application/x-apple-binary-plist\r\nContent-Length: %u\r\n\r\n", bytes);
    http_request_t *request = http_request_init();
    http_request_add_data(request, header, size); http_request_add_data(request, body, bytes);
    assert(http_request_is_complete(request));
    http_response_t *response = http_response_create(); http_response_init(response, "HTTP/1.1", 200, "OK");
    raop_conn_t conn = {0}; conn.raop = raop; char *reply = NULL; int length = 0;
    http_handler_action(&conn, request, response, &reply, &length);
    free(reply); plist_mem_free(body); plist_free(root);
    http_request_destroy(request); http_response_destroy(response);
}
int main(void) {
    raop_t raop = {0}; raop.logger = logger_init();
    raop.airplay_video[0] = airplay_video_init(&raop, 7101, NULL);
    raop.airplay_video[1] = airplay_video_init(&raop, 7101, NULL);
    assert(strcmp(get_uri_local_prefix(raop.airplay_video[0]), get_uri_local_prefix(raop.airplay_video[1])));
    store_master_playlist(raop.airplay_video[0], strdup("#EXTM3U\nOLD\n"));
    store_master_playlist(raop.airplay_video[1], strdup("#EXTM3U\nNEW\n"));
    raop.current_video = 1;
    request_playlist(&raop, raop.airplay_video[0], "#EXTM3U\nOLD\n");
    raop.callbacks.on_video_play=play;raop.callbacks.on_video_stop=stop;raop.callbacks.on_video_loading=load;
    const char text[]="Content-Location: https://media.example/test.mp4\r\nStart-Position: 0.25\r\n";
    direct(&raop,text,strlen(text),true,200);
    assert(!strcmp(played,"https://media.example/test.mp4") && position==-0.25f);
    plist_t root=plist_new_dict();
    plist_dict_set_item(root,"Content-Location",plist_new_string("https://media.example/video.m3u8"));
    plist_dict_set_item(root,"Start-Position-Seconds",plist_new_real(12.0));
    char *bin=NULL;uint32_t bytes=0;plist_to_bin(root,&bin,&bytes);
    direct(&raop,bin,bytes,true,200);plist_mem_free(bin);bin=NULL;
    assert(position==12.0f && !strcmp(played,"https://media.example/video.m3u8"));
    assert(loading == 2); /* Each accepted direct item reserves a fresh origin/generation. */
    plist_dict_set_item(root,"Content-Location",plist_new_string("https://proxy.example/master.m3u8&subtitleURL=x"));
    plist_dict_set_item(root,"uuid",plist_new_string("11111111-2222-4333-8444-555555555555"));
    plist_to_bin(root,&bin,&bytes);direct(&raop,bin,bytes,false,200);plist_mem_free(bin);
    plist_free(root);
    const char bad[]="Content-Location: file:///etc/passwd\r\n";
    direct(&raop,bad,strlen(bad),true,415);assert(stopped==1);
    assert(loading == 2); /* Invalid/proxy requests do not reserve direct media. */
    request_playlist(&raop, raop.airplay_video[1], "#EXTM3U\nNEW\n");
    /* playlistRemove from a backgrounded sender must preserve current_video:
       the local player can still request its playlist and finish normally. */
    set_playback_uuid(raop.airplay_video[0], "aaaaaaaa-1111-4222-8333-444444444444", 36);
    set_playback_uuid(raop.airplay_video[1], "dddddddd-1111-4222-8333-444444444444", 36);
    raop.current_video = 1;
    set_apple_session_id(raop.airplay_video[1], "11111111-2222-4333-8444-555555555555", 36);
    raop.callbacks.on_video_playlist_remove = removed;
    raop.callbacks.is_hls_detached = is_detached;
    detached = true; remove_playlist(&raop);
    assert(raop.current_video == 1);
    request_playlist(&raop, raop.airplay_video[1], "#EXTM3U\nNEW\n");
    detached = false; remove_playlist(&raop);
    assert(raop.current_video == -1);
    raop.current_video = -1;
    request_playlist(&raop, raop.airplay_video[0], "#EXTM3U\nOLD\n");
    raop_destroy_airplay_video(&raop, -1); logger_destroy(raop.logger);
    puts("Distinct HLS routes preserve the old/new playlists during video changes"); return 0;
}
