/* The <video>-shaped surface the player chrome talks to, so the chrome doesn't have to know
   whether a real HTMLVideoElement or a native player is behind it.

   On the web leg the facade IS the <video> element - it already satisfies this whole
   surface natively, so setMediaFacade(controller, videoEl) in playWeb is the entire
   registration and nothing about the web path changes. A native backend registers a
   NativeMediaFacade instead (see below).

   Deliberately NOT everything the code does with a <video>. Two kinds of use exist and only
   one of them belongs here:

     - Playback state - currentTime/duration/buffered/paused/volume/muted/playbackRate/
       videoWidth/videoHeight, play()/pause(), and the media events. Every backend can
       answer these, so the chrome reads them through media(controller).

     - The real DOM element - .style (shader-pipeline's opacity:0, ambient-pipeline's
       background, the zoom transform), setPointerCapture, clientWidth/clientHeight,
       readyState/HAVE_CURRENT_DATA, and being handed to texImage2D/drawImage. None of that
       can be faked, and on a native backend each has a native equivalent instead (a
       RenderTransform for zoom, a video effect in the decode pipeline for shaders/ambient).
       Those keep using controller._videoEl directly and simply don't run off the web leg,
       which is already how the Android path behaves. */

export function setMediaFacade(controller, facade) {
    controller._media = facade || null;
}

export function media(controller) {
    return controller._media || null;
}

/* Everything a native backend has to supply. Positions/durations cross the bridge in
   milliseconds (matching the existing native "progress" event payload); this class is what
   converts to the seconds-based <video> property contract, so no chrome code has to care
   which unit its backend speaks. */
export class NativeMediaFacade extends EventTarget {
    constructor({ seek, play, pause, setVolume, setMuted, setPlaybackRate, now } = {}) {
        super();
        this._seek = seek;
        this._play = play;
        this._pause = pause;
        this._setVolume = setVolume;
        this._setMuted = setMuted;
        this._setPlaybackRate = setPlaybackRate;
        this._now = now || (() => performance.now());

        this._positionMs = 0;
        this._positionAt = this._now();
        this._durationMs = 0;
        this._bufferedAheadMs = 0;
        this._paused = false;
        this._buffering = false;
        this._volume = 1;
        this._muted = false;
        this._playbackRate = 1;
        this.videoWidth = 0;
        this.videoHeight = 0;
    }

    /* A native player reports position on its own cadence (~2-4 ticks/second, matching
       Android's "progress" event), which is far too coarse for anything reading position
       every frame - the subtitle renderer's rAF loop and the scrub bar would both visibly
       step rather than move. So position is interpolated from the last report using
       wall-clock elapsed time scaled by the playback rate, and snapped back to the truth on
       every fresh report. Clamped to duration so a late tick can't read past the end. */
    get currentTime() {
        if (this._paused) return this._positionMs / 1000;
        const elapsed = (this._now() - this._positionAt) * this._playbackRate;
        const projected = this._positionMs + Math.max(0, elapsed);
        const ceiling = this._durationMs || Infinity;
        return Math.min(projected, ceiling) / 1000;
    }

    set currentTime(seconds) {
        const positionMs = Math.max(0, seconds * 1000);
        /* Applied locally before the bridge call resolves, so a scrub reads back the
           position the user just asked for rather than snapping to the pre-seek value until
           the next native report lands. */
        this._setPosition(positionMs);
        this._seek?.(positionMs);
        this.dispatchEvent(new Event("timeupdate"));
        /* chrome-controls.js's spinner shows on "seeking" and hides on "seeked"/"canplay",
           so a backend MUST call applySeeked() once the seek completes or the spinner stays
           up for the rest of the session. */
        this.dispatchEvent(new Event("seeking"));
    }

    get duration() {
        return this._durationMs ? this._durationMs / 1000 : NaN;
    }

    get paused() {
        return this._paused;
    }

    /* One range covering what's buffered ahead of the playhead. A native player reports a
       single "seconds buffered ahead" figure, not the full range list a <video> exposes,
       so this can't reconstruct earlier ranges left behind by a seek - which is fine for
       the only two consumers (the scrub bar's buffered fill and the stats overlay's buffer
       health), both of which only ever look at the range containing currentTime. */
    get buffered() {
        const start = this.currentTime;
        const end = start + this._bufferedAheadMs / 1000;
        const length = this._bufferedAheadMs > 0 ? 1 : 0;
        return {
            length,
            start: (i) => (i === 0 && length ? start : 0),
            end: (i) => (i === 0 && length ? end : 0),
        };
    }

    get volume() {
        return this._volume;
    }

    set volume(value) {
        this._volume = Math.min(1, Math.max(0, value));
        this._setVolume?.(this._volume);
        this.dispatchEvent(new Event("volumechange"));
    }

    get muted() {
        return this._muted;
    }

    set muted(value) {
        this._muted = !!value;
        this._setMuted?.(this._muted);
        this.dispatchEvent(new Event("volumechange"));
    }

    get playbackRate() {
        return this._playbackRate;
    }

    set playbackRate(value) {
        /* Resync first: the elapsed time since the last report was accumulating at the OLD
           rate, so folding it in before the rate changes keeps the interpolation honest
           instead of retroactively rescaling it. */
        this._setPosition(this.currentTime * 1000);
        this._playbackRate = value;
        this._setPlaybackRate?.(value);
    }

    play() {
        this._play?.();
    }

    pause() {
        this._pause?.();
    }

    _setPosition(positionMs) {
        this._positionMs = positionMs;
        this._positionAt = this._now();
    }

    /* --- Ingest, called by the bridge as native events arrive --- */

    applyProgress({ positionMs, durationMs, bufferedMs } = {}) {
        if (positionMs != null) this._setPosition(positionMs);
        const bufferedChanged = bufferedMs != null && bufferedMs !== this._bufferedAheadMs;
        if (bufferedMs != null) this._bufferedAheadMs = bufferedMs;
        if (durationMs != null && durationMs !== this._durationMs) {
            this._durationMs = durationMs;
            this.dispatchEvent(new Event("durationchange"));
        }
        this.dispatchEvent(new Event("timeupdate"));
        /* What repaints the scrub bar's buffered fill (chrome-transport.js's syncSeekFill) -
           only fired on an actual change, since the buffered figure is otherwise steady
           across ticks during healthy playback. */
        if (bufferedChanged) this.dispatchEvent(new Event("progress"));
    }

    /* Drives the buffering spinner (chrome-controls.js's buildLoadingSpinner). Edge-
       triggered for the same reason applyPaused is: a backend reporting playback state on
       every tick would otherwise show/hide the spinner continuously. */
    applyBuffering(buffering) {
        const next = !!buffering;
        if (next === this._buffering) return;
        this._buffering = next;
        this.dispatchEvent(new Event(next ? "waiting" : "playing"));
    }

    /* Completes the seek the currentTime setter started - hides the spinner. */
    applySeeked(positionMs) {
        if (positionMs != null) this._setPosition(positionMs);
        this.dispatchEvent(new Event("seeked"));
        this.dispatchEvent(new Event("canplay"));
    }

    applyMetadata({ videoWidth, videoHeight, durationMs } = {}) {
        if (videoWidth != null) this.videoWidth = videoWidth;
        if (videoHeight != null) this.videoHeight = videoHeight;
        if (durationMs != null) this._durationMs = durationMs;
        this.dispatchEvent(new Event("loadedmetadata"));
    }

    /* Fires "play"/"pause" only on an actual transition - the chrome's handlers flip
       session.state and re-render the play/pause glyph, and a native player that reports
       state on every tick would otherwise churn both continuously. */
    applyPaused(paused) {
        const next = !!paused;
        if (next === this._paused) return;
        /* Fold the interpolated position in before freezing, so pausing doesn't rewind to
           whatever the last native report said. */
        this._setPosition(this.currentTime * 1000);
        this._paused = next;
        this.dispatchEvent(new Event(next ? "pause" : "play"));
    }

    applyEnded() {
        this.dispatchEvent(new Event("ended"));
    }

    applyError() {
        this.dispatchEvent(new Event("error"));
    }
}
