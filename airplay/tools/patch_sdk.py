"""Private SDK copy only: native video capabilities and reversible fullscreen."""
def patch_display(text):
    def replace(old, new):
        nonlocal text
        if text.count(old) != 1:
            raise RuntimeError('Unexpected SDK fullscreen anchor: ' + old[:70])
        text = text.replace(old, new)
    replace('    layout() {', '''    setPresentation(on) {
        on = !!on;
        if (on === !!this.presentation) return;
        this.presentation = on;
        this.tabs = []; this.ownDown = null; this.tabDown = -1;
        this.lastWords = null;
        this._place();
    }
    layout() {''')
    replace("        if (v === 'standard' || scr.w !== HMI.screen.w || scr.h !== HMI.screen.h) {", '''        if (this.presentation && this.gpu.native) {
            pl = { x: 0, y: 0, w: scr.w, h: scr.h, scale: 1, ox: 0, oy: 0, full: true };
        } else if (v === 'standard' || scr.w !== HMI.screen.w || scr.h !== HMI.screen.h) {''')
    replace("r.chrome = this.active() && this.place.full && this.screen.chrome !== false ?", "r.chrome = !this.presentation && this.active() && this.place.full && this.screen.chrome !== false ?")
    replace("if (!(r.chrome && this.active() && this.place.full) && !r._cnStamped) {", "if (!this.presentation && !(r.chrome && this.active() && this.place.full) && !r._cnStamped) {")
    replace('    _touch(phase, x, y) {', '''    _touch(phase, x, y) {
        if (this.presentation) {
            if (phase === 3 && this.onPresentationInput) this.onPresentationInput();
            return;
        }''')
    replace('const sx = this.headEnd = Math.min(HMI.status.x - pl.x, Math.ceil(Math.max(end, this.headMax || 0)));',
            'const sx = this.headEnd = HMI.status.x - pl.x;')
    replace('c.clip(0, 0, hx, HMI.colEnd - pl.y).clear(0).noclip();',
            'c.clip(0, 0, hx, FULL.headH).clear(0).noclip();')
    replace("this.gpu.claim([{ x: hx, y: 0, w: this.headEnd - hx, h: this.headH() }, { x: hx, y: this.headH(), w: W - hx, h: pl.h - this.headH() }].map(logical));",
            "this.gpu.claim([{ x: hx, y: 0, w: this.headEnd - hx, h: this.headH() }, { x: 0, y: this.headH(), w: W, h: pl.h - this.headH() }].map(logical));")
    replace('        const tl = this._tabList(), here = Math.max(0, tl.sel >= 0 ? tl.sel : tl.settings);', '''        if (this.presentation) {
            if ((d || press || tilt) && this.onPresentationInput) this.onPresentationInput();
            return;
        }
        const tl = this._tabList(), here = Math.max(0, tl.sel >= 0 ? tl.sel : tl.settings);''')
    return text
