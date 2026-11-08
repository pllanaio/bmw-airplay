"""Private SDK copy only: borderless native app body and reversible fullscreen."""
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
    return patch_borderless(text)


def patch_borderless(text):
    def replace(old, new):
        nonlocal text
        if text.count(old) != 1:
            raise RuntimeError('Unexpected SDK borderless anchor: ' + old[:70])
        text = text.replace(old, new)

    replace('    layout() {', '''    borderless() {
        return !!(this.screen && this.screen.borderless === true && this.gpu && this.gpu.native);
    }
    contentSize() {
        if (!this.gpu || !this.gpu.ready || !this.gpu.native || !this.place) return null;
        if (this.presentation && this.gpu && this.gpu.screen) return { w: this.gpu.screen.w, h: this.gpu.screen.h };
        if (this.borderless() && this.place && this.place.full) {
            return { w: PAGE.w, h: Math.max(16, Math.floor((this.place.h - this.barH()) / this.place.scale / 2) * 2) };
        }
        return null;
    }
    layout() {
        if (this.borderless()) return 'full';''')
    replace("        } else if (v === 'standard' || scr.w !== HMI.screen.w || scr.h !== HMI.screen.h) {", '''        } else if (this.borderless()) {
            pl = { x: 0, y: 0, w: scr.w, h: scr.h, scale: scr.w / PAGE.w, ox: 0, oy: 0, full: true };
        } else if (v === 'standard' || scr.w !== HMI.screen.w || scr.h !== HMI.screen.h) {''')
    replace("if (!this.presentation && !(r.chrome && this.active() && this.place.full) && !r._cnStamped) {",
            "if (!(this.screen && this.screen.borderless) && !this.presentation && !(r.chrome && this.active() && this.place.full) && !r._cnStamped) {")
    replace("return !!(g && g.ready && g.native && g.touch && this.layout() === 'full' && g.screen.w === HMI.screen.w && g.screen.h === HMI.screen.h);",
            "return !!(g && g.ready && g.native && g.touch && this.layout() === 'full' && (this.borderless() || (g.screen.w === HMI.screen.w && g.screen.h === HMI.screen.h)));")
    replace("headH() { return this.screen && this.screen.chrome === false ? 0 : FULL.headH; }",
            "headH() { return this.borderless() || (this.screen && this.screen.chrome === false) ? 0 : FULL.headH; }")
    replace('        this.tabs = (rects || []).map(logical);', '''        this.tabs = (rects || []).map(logical);
        if (this.borderless() && this.own()) {
            this.tabs = [];
            this.gpu.claim([{ x: 0, y: 0, w: pl.w, h: pl.h }].map(logical));
            return;
        }''')
    replace('        let x = HMI.btn.x;', '        let x = this.borderless() && own ? 0 : HMI.btn.x;')
    replace('''        const own = this.ownable();
        if (this._btns && this._btnsOwn === own) return this._btns;
        this._btnsOwn = own;''', '''        const own = this.ownable();
        const width = own && this.borderless() && this.place ? this.place.w : 0;
        if (this._btns && this._btnsOwn === own && this._btnsWidth === width) return this._btns;
        this._btnsOwn = own; this._btnsWidth = width;''')
    replace('''        return this._btns;
    }

    onTick(fn)''', '''        if (width && this._btns.length) this._btns.forEach((button, i) => {
            button.x = i * width / this._btns.length;
            button.w = width / this._btns.length;
        });
        return this._btns;
    }

    onTick(fn)''')
    replace('        const right = HMI.screen.w;', '        const right = this.borderless() && this.place ? this.place.w : HMI.screen.w;')
    replace('        if (f.x - this.barOff < HMI.btn.x) this.barOff = f.x - HMI.btn.x;',
            '        const left = this.borderless() && this.ownable() ? 0 : HMI.btn.x;\n        if (f.x - this.barOff < left) this.barOff = f.x - left;')
    replace('    _drawChrome(r) {', '''    _drawBorderlessChrome(r) {
        const pl = this.place, t = this.theme(), W = pl.w, H = pl.h;
        const c = this.chromeRec && this.chromeRec.w === W && this.chromeRec.h === H ? this.chromeRec :
            (this.chromeRec = new Recorder(W, H));
        c.reset(); c.tabRects = []; this.headEnd = 0;
        // Keep page focus feedback and the native bottom menu. The app paints
        // every pixel above it, with no header, status hole or credit overlay.
        const k = pl.scale, onPage = (key) => !this.sheet && key &&
            (this.pageTargets || []).find((q) => 'tgt:' + q.key === key);
        const pt = onPage(this.focusKey), pp = Date.now() - this.pressedT < 300 && onPage(this.pressed);
        if (pp) c.roundRect(pp.x * k + pl.ox, pp.y * k + pl.oy, pp.w * k, pp.h * k,
            (pp.r != null ? pp.r : pp.h / 2) * k, G.withAlpha(t.sel || t.accent, 0.35));
        if (pt) c.strokeRoundRect(pt.x * k + pl.ox - 5, pt.y * k + pl.oy - 5, pt.w * k + 10,
            pt.h * k + 10, (pt.r != null ? pt.r : pt.h / 2) * k + 5, 3, t.sel || t.accent);
        const sb = this.focusKey === 'scroll' && !this.sheet && this.pageScroll;
        if (sb === true) c.strokeRoundRect(6, 6, W - 12, H - this.barH() - 12, 14, 3, G.withAlpha(t.sel || t.accent, 0.8));
        else if (sb && sb.bar) c.roundRect((sb.bar.x - 2) * k + pl.ox, sb.bar.y * k + pl.oy,
            (sb.bar.w + 4) * k, sb.bar.h * k, (sb.bar.w / 2 + 2) * k, t.sel || t.accent);
        const btns = this.buttons().map((b) => ({ id: b.id, label: b.label, x: b.x - this.barOff - pl.x, w: b.w }));
        const flash = this.pressed && Date.now() - this.pressedT < 300 ? btns.findIndex((b) => b.id === this.pressed) : -1;
        const focus = btns.findIndex((b) => b.id === this.focused);
        if (btns.length && this.barH()) G.menuBar(c, t, 0, H - this.barH(), W, FULL.barH, btns, focus, 'slim', flash);
        r.xf(1, 0, 0).append(c).xf();
    }
    _drawChrome(r) {
        if (this.borderless()) { this._drawBorderlessChrome(r); return; }''')
    return text
