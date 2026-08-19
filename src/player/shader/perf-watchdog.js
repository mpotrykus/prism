/* Watches whether the shader chain is keeping up with real time, and steps down to a
   cheaper preset if it isn't.

   This exists because the CNN presets are the first thing in this pipeline whose cost varies
   by an order of magnitude across the devices it runs on. The two hand-written sharpen
   shaders are one pass and were safe to enable anywhere; Anime4K's Restore+Upscale chain is
   ten passes, four of them at half-float precision, and that is fine on a desktop GPU and
   potentially far too slow on a phone. A stuttering picture is a worse picture than a
   slightly softer one, so "silently render fewer passes" beats "let the viewer watch it
   judder".

   What it measures: **wall-clock time per frame against media time per frame.** Between two
   rendered frames, the video's own clock advances by one frame period; if the wall clock
   advanced by meaningfully more than that, this pipeline is not keeping up with real time.
   That ratio is the whole signal, and it is self-calibrating - it needs to know nothing about
   the display's refresh rate, the source's frame rate, or the playback speed.

   The first version of this compared the frame interval against a fixed 24ms budget, i.e.
   "are we sustaining 60fps". That was wrong, and confirmed wrong on real hardware: a 24fps
   animated source at a 480p quality cap was downgraded on a Galaxy S23+ while the video was
   dropping 2 frames out of 281 - the chain was comfortably keeping up with 24fps content and
   got penalised for not hitting a refresh rate the content never needed. Frame rate relative
   to the *content* is the thing that matters; anything faster than the source frame rate is
   wasted work, not headroom.

   Deliberately not EXT_disjoint_timer_query_webgl2: it is absent or neutered in most browsers
   for fingerprinting reasons, so basing the decision on it would mean the watchdog silently
   doing nothing exactly where it matters most.

   getVideoPlaybackQuality()'s dropped-frame count is measured but does NOT drive the decision -
   see the dropRate getter for why it is report-only, and for the blind spot in the ratio above
   that it exists to expose. */

/* How far behind real time is tolerable before stepping down. 1.35 leaves room for ordinary
   jitter (a GC pause, a compositor hiccup, a decode hitch) while still catching a chain that
   genuinely cannot sustain the content's frame rate: at this ratio a 24fps source has to be
   taking over ~56ms/frame to trip. */
const KEEP_UP_RATIO = 1.35;
/* Number of measured frames per decision window. At 24fps this is ~5 seconds - long enough
   that a couple of stalled frames can't trip it, short enough that nobody watches a minute of
   stutter first. Frames where the media clock didn't advance sanely are not counted, so a
   paused or seeking player simply doesn't accumulate a window. */
const SAMPLE_FRAMES = 120;
/* Chain construction (shader compile/link) and the first target allocation both land on the
   first few frames, and a resize reallocates every intermediate. Measuring those would
   downgrade every session on frame one. */
const WARMUP_FRAMES = 20;
/* A single frame's media advance outside this range means something other than steady
   playback happened - a seek, a stall, a pause, a title switch. Bounding it is what keeps
   those from being read as "we fell behind". 4ms..250ms spans 240fps down to 4fps. */
const MIN_MEDIA_DELTA_MS = 4;
const MAX_MEDIA_DELTA_MS = 250;

export function createPerfWatchdog({ keepUpRatio = KEEP_UP_RATIO, onDowngrade } = {}) {
    let counted = 0;
    let wallTotalMs = 0;
    let mediaTotalMs = 0;
    let lastWallMs = 0;
    let lastMediaMs = 0;
    let meanMs = 0;
    let ratio = 0;
    let downgraded = false;
    let windowDropped = null;
    let windowTotal = null;
    let dropRate = 0;

    return {
        /* Latched for the rest of the session once tripped, rather than re-tested with a
           recovery path. A chain that was too slow a second ago will be too slow again, and
           an unlatched version oscillates: downgrade restores frame rate, the restored frame
           rate reads as headroom, the CNN comes back, it stutters again. The session-scoped
           reset below is the intended escape hatch - a new title or a new output size is new
           information, a few fast frames are not. */
        get downgraded() {
            return downgraded;
        },
        /* Mean wall-clock ms per rendered frame over the last completed window, or 0 before
           the first one. Reported in the Performance Overlay so the cost is answerable on the
           device itself rather than inferred from how the picture looks. */
        get meanFrameMs() {
            return meanMs;
        },
        /* Wall time per frame divided by media time per frame: 1.0 is exactly real time,
           2.0 is half speed. Shown alongside the mean because the mean alone is
           uninterpretable without knowing the source's frame rate. */
        get keepUpRatio() {
            return ratio;
        },
        /* Fraction of video frames the decoder dropped during the last window.

           REPORT ONLY - deliberately not a trip condition yet. It covers the one failure the
           ratio above structurally cannot see: when a frame is dropped, rVFC simply doesn't
           fire for it, so wall time and media time both skip forward by two frame periods and
           the ratio stays a contented 1.00. A chain heavy enough to starve the decoder would
           therefore report as keeping up perfectly.

           It isn't wired to a downgrade because the threshold isn't known yet, and guessing one
           is exactly the mistake the fixed-24ms budget already made on real hardware. Decoder
           drops also move for reasons that have nothing to do with GPU cost - on the hls.js
           path, network stalls show up here too. So: surface it in the Performance Overlay,
           A/B it with the preset on and off on real devices, and only then pick a number. */
        get dropRate() {
            return dropRate;
        },

        /* Called once per rendered frame. `mediaMs` is the video's own clock (rVFC's
           metadata.mediaTime, or video.currentTime) and is what makes this measurement
           independent of refresh rate; `playbackRate` normalises it so 2x playback isn't read
           as falling behind. */
        frame({ wallMs, mediaMs, playbackRate = 1, droppedFrames = null, totalFrames = null }) {
            const wallDelta = wallMs - lastWallMs;
            const mediaDelta = (mediaMs - lastMediaMs) / (playbackRate || 1);
            lastWallMs = wallMs;
            lastMediaMs = mediaMs;
            if (downgraded) return;
            /* Excludes the first frame, and every frame where the media clock did something
               other than advance by one steady frame period. */
            if (!wallDelta || mediaDelta < MIN_MEDIA_DELTA_MS || mediaDelta > MAX_MEDIA_DELTA_MS) return;

            counted++;
            if (counted <= WARMUP_FRAMES) return;
            if (windowTotal === null && totalFrames !== null) {
                windowDropped = droppedFrames;
                windowTotal = totalFrames;
            }

            wallTotalMs += wallDelta;
            mediaTotalMs += mediaDelta;
            if (counted - WARMUP_FRAMES < SAMPLE_FRAMES) return;

            const frames = counted - WARMUP_FRAMES;
            meanMs = wallTotalMs / frames;
            ratio = mediaTotalMs > 0 ? wallTotalMs / mediaTotalMs : 0;
            if (windowTotal !== null && totalFrames !== null) {
                const presented = totalFrames - windowTotal;
                dropRate = presented > 0 ? (droppedFrames - windowDropped) / presented : 0;
            }
            windowDropped = null;
            windowTotal = null;
            wallTotalMs = 0;
            mediaTotalMs = 0;
            counted = WARMUP_FRAMES;
            if (ratio > keepUpRatio) {
                downgraded = true;
                onDowngrade?.({ meanMs, ratio });
            }
        },

        /* Called whenever the work being measured changes shape - a new title, a resolution
           switch (Auto Quality restarts the transcode at a different rendition), a window
           resize. The previous window's measurement describes work that is no longer running.
           Does not clear `downgraded`: see the note above on why recovery is deliberate. */
        resetWindow() {
            counted = 0;
            wallTotalMs = 0;
            mediaTotalMs = 0;
            lastWallMs = 0;
            lastMediaMs = 0;
            windowDropped = null;
            windowTotal = null;
        },
    };
}
