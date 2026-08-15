import { describe, it, expect, vi } from "vitest";
import { NativeMediaFacade, setMediaFacade, media } from "./media-facade.js";

/* Wall clock is injected so interpolation can be tested deterministically instead of with
   real timers. */
function makeFacade(overrides = {}) {
    const clock = { ms: 0 };
    const calls = { seek: [], play: 0, pause: 0, volume: [], muted: [], rate: [] };
    const facade = new NativeMediaFacade({
        now: () => clock.ms,
        seek: (ms) => calls.seek.push(ms),
        play: () => calls.play++,
        pause: () => calls.pause++,
        setVolume: (v) => calls.volume.push(v),
        setMuted: (v) => calls.muted.push(v),
        setPlaybackRate: (v) => calls.rate.push(v),
        ...overrides,
    });
    return { facade, clock, calls };
}

describe("NativeMediaFacade position interpolation", () => {
    it("advances position between native reports using elapsed wall clock", () => {
        const { facade, clock } = makeFacade();
        facade.applyProgress({ positionMs: 10000, durationMs: 60000 });
        expect(facade.currentTime).toBe(10);
        clock.ms += 500;
        expect(facade.currentTime).toBe(10.5);
    });

    it("snaps back to the truth on a fresh report", () => {
        const { facade, clock } = makeFacade();
        facade.applyProgress({ positionMs: 10000, durationMs: 60000 });
        clock.ms += 900;
        facade.applyProgress({ positionMs: 10500 });
        expect(facade.currentTime).toBe(10.5);
    });

    it("freezes while paused instead of drifting forward", () => {
        const { facade, clock } = makeFacade();
        facade.applyProgress({ positionMs: 10000, durationMs: 60000 });
        facade.applyPaused(true);
        clock.ms += 5000;
        expect(facade.currentTime).toBe(10);
    });

    it("resumes from where it was paused, not from the last native report", () => {
        const { facade, clock } = makeFacade();
        facade.applyProgress({ positionMs: 10000, durationMs: 60000 });
        clock.ms += 400;
        facade.applyPaused(true);
        clock.ms += 5000;
        facade.applyPaused(false);
        expect(facade.currentTime).toBe(10.4);
    });

    it("scales interpolation by playback rate", () => {
        const { facade, clock } = makeFacade();
        facade.applyProgress({ positionMs: 10000, durationMs: 60000 });
        facade.playbackRate = 2;
        clock.ms += 500;
        expect(facade.currentTime).toBe(11);
    });

    it("does not retroactively rescale time already elapsed at the old rate", () => {
        const { facade, clock } = makeFacade();
        facade.applyProgress({ positionMs: 10000, durationMs: 60000 });
        clock.ms += 1000;
        facade.playbackRate = 2;
        clock.ms += 1000;
        expect(facade.currentTime).toBe(13);
    });

    it("never interpolates past the reported duration", () => {
        const { facade, clock } = makeFacade();
        facade.applyProgress({ positionMs: 59000, durationMs: 60000 });
        clock.ms += 10000;
        expect(facade.currentTime).toBe(60);
    });

    it("applies a seek locally before the bridge responds", () => {
        const { facade, calls } = makeFacade();
        facade.applyProgress({ positionMs: 10000, durationMs: 60000 });
        facade.currentTime = 42;
        expect(facade.currentTime).toBe(42);
        expect(calls.seek).toEqual([42000]);
    });

    it("clamps a negative seek to zero", () => {
        const { facade, calls } = makeFacade();
        facade.currentTime = -5;
        expect(facade.currentTime).toBe(0);
        expect(calls.seek).toEqual([0]);
    });
});

describe("NativeMediaFacade <video> property contract", () => {
    it("reports duration in seconds, NaN before it is known", () => {
        const { facade } = makeFacade();
        expect(facade.duration).toBeNaN();
        facade.applyProgress({ positionMs: 0, durationMs: 90000 });
        expect(facade.duration).toBe(90);
    });

    it("exposes one buffered range ahead of the playhead", () => {
        const { facade } = makeFacade();
        facade.applyProgress({ positionMs: 10000, durationMs: 60000, bufferedMs: 8000 });
        expect(facade.buffered.length).toBe(1);
        expect(facade.buffered.start(0)).toBe(10);
        expect(facade.buffered.end(0)).toBe(18);
    });

    it("reports an empty buffered list when nothing is buffered ahead", () => {
        const { facade } = makeFacade();
        facade.applyProgress({ positionMs: 10000, bufferedMs: 0 });
        expect(facade.buffered.length).toBe(0);
    });

    it("clamps volume to 0..1 and pushes it to the bridge", () => {
        const { facade, calls } = makeFacade();
        facade.volume = 1.7;
        expect(facade.volume).toBe(1);
        facade.volume = -1;
        expect(facade.volume).toBe(0);
        expect(calls.volume).toEqual([1, 0]);
    });

    it("forwards play/pause to the bridge", () => {
        const { facade, calls } = makeFacade();
        facade.play();
        facade.pause();
        expect(calls.play).toBe(1);
        expect(calls.pause).toBe(1);
    });

    it("takes videoWidth/videoHeight from metadata", () => {
        const { facade } = makeFacade();
        facade.applyMetadata({ videoWidth: 3840, videoHeight: 2160 });
        expect(facade.videoWidth).toBe(3840);
        expect(facade.videoHeight).toBe(2160);
    });
});

describe("NativeMediaFacade events", () => {
    it("fires timeupdate on every progress report", () => {
        const { facade } = makeFacade();
        const onTimeUpdate = vi.fn();
        facade.addEventListener("timeupdate", onTimeUpdate);
        facade.applyProgress({ positionMs: 1000 });
        facade.applyProgress({ positionMs: 2000 });
        expect(onTimeUpdate).toHaveBeenCalledTimes(2);
    });

    it("fires durationchange only when the duration actually changes", () => {
        const { facade } = makeFacade();
        const onDurationChange = vi.fn();
        facade.addEventListener("durationchange", onDurationChange);
        facade.applyProgress({ positionMs: 0, durationMs: 60000 });
        facade.applyProgress({ positionMs: 1000, durationMs: 60000 });
        facade.applyProgress({ positionMs: 2000, durationMs: 61000 });
        expect(onDurationChange).toHaveBeenCalledTimes(2);
    });

    it("fires play/pause only on a real transition", () => {
        const { facade } = makeFacade();
        const onPlay = vi.fn();
        const onPause = vi.fn();
        facade.addEventListener("play", onPlay);
        facade.addEventListener("pause", onPause);
        facade.applyPaused(true);
        facade.applyPaused(true);
        facade.applyPaused(false);
        expect(onPause).toHaveBeenCalledTimes(1);
        expect(onPlay).toHaveBeenCalledTimes(1);
    });

    it("fires progress only when the buffered figure changes", () => {
        const { facade } = makeFacade();
        const onProgress = vi.fn();
        facade.addEventListener("progress", onProgress);
        facade.applyProgress({ positionMs: 0, bufferedMs: 5000 });
        facade.applyProgress({ positionMs: 1000, bufferedMs: 5000 });
        facade.applyProgress({ positionMs: 2000, bufferedMs: 7000 });
        expect(onProgress).toHaveBeenCalledTimes(2);
    });

    it("fires waiting/playing only on a real buffering transition", () => {
        const { facade } = makeFacade();
        const onWaiting = vi.fn();
        const onPlaying = vi.fn();
        facade.addEventListener("waiting", onWaiting);
        facade.addEventListener("playing", onPlaying);
        facade.applyBuffering(true);
        facade.applyBuffering(true);
        facade.applyBuffering(false);
        expect(onWaiting).toHaveBeenCalledTimes(1);
        expect(onPlaying).toHaveBeenCalledTimes(1);
    });

    it("fires seeking on a seek and seeked/canplay when it completes", () => {
        const { facade } = makeFacade();
        const seen = [];
        ["seeking", "seeked", "canplay"].forEach((name) =>
            facade.addEventListener(name, () => seen.push(name)));
        facade.currentTime = 30;
        expect(seen).toEqual(["seeking"]);
        facade.applySeeked(30000);
        expect(seen).toEqual(["seeking", "seeked", "canplay"]);
    });

    it("fires ended and error", () => {
        const { facade } = makeFacade();
        const onEnded = vi.fn();
        const onError = vi.fn();
        facade.addEventListener("ended", onEnded);
        facade.addEventListener("error", onError);
        facade.applyEnded();
        facade.applyError();
        expect(onEnded).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledTimes(1);
    });
});

describe("setMediaFacade / media", () => {
    it("registers and reads back the facade", () => {
        const controller = {};
        const el = {};
        setMediaFacade(controller, el);
        expect(media(controller)).toBe(el);
    });

    it("reads back null once cleared", () => {
        const controller = {};
        setMediaFacade(controller, {});
        setMediaFacade(controller, null);
        expect(media(controller)).toBeNull();
    });

    it("reads back null before anything is registered", () => {
        expect(media({})).toBeNull();
    });
});
