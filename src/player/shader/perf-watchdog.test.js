import { describe, it, expect } from "vitest";
import { createPerfWatchdog } from "./perf-watchdog.js";

/* Feeds `frames` frames where the wall clock advances `wallStep` per frame and the video's own
   clock advances `mediaStep`. Equal values mean the chain is exactly keeping up with real
   time; a larger wallStep means it is falling behind. */
function run(watchdog, { frames, wallStep, mediaStep, playbackRate = 1, startMedia = 0, dropEvery = 0 }) {
  let wall = 0;
  let media = startMedia;
  let dropped = 0;
  let total = 0;
  for (let i = 0; i < frames; i++) {
    wall += wallStep;
    media += mediaStep;
    total++;
    if (dropEvery && i % dropEvery === 0) dropped++;
    watchdog.frame({ wallMs: wall, mediaMs: media, playbackRate, droppedFrames: dropped, totalFrames: total });
  }
}

/* One decision window plus warmup, with headroom. */
const ENOUGH = 200;

describe("createPerfWatchdog", () => {
  /* The regression this file exists for. Confirmed on a Galaxy S23+: a 24fps animated source
     at a 480p quality cap was downgraded while the video dropped 2 frames out of 281. The
     original watchdog compared the frame interval against a fixed 24ms "are we at 60fps"
     budget, so content that only ever needed 41.7ms/frame was penalised for not hitting a
     refresh rate it never required. */
  it("does not downgrade a 24fps source rendering at its own frame rate", () => {
    const watchdog = createPerfWatchdog({ onDowngrade: () => {} });
    run(watchdog, { frames: ENOUGH, wallStep: 41.7, mediaStep: 41.7 });
    expect(watchdog.downgraded).toBe(false);
    expect(watchdog.keepUpRatio).toBeCloseTo(1, 2);
    expect(watchdog.meanFrameMs).toBeCloseTo(41.7, 1);
  });

  it("does not downgrade a 60fps source rendering at its own frame rate", () => {
    const watchdog = createPerfWatchdog({ onDowngrade: () => {} });
    run(watchdog, { frames: ENOUGH, wallStep: 16.7, mediaStep: 16.7 });
    expect(watchdog.downgraded).toBe(false);
  });

  it("downgrades a chain running at half real time, and reports both numbers", () => {
    let reported = null;
    const watchdog = createPerfWatchdog({ onDowngrade: (info) => { reported = info; } });
    run(watchdog, { frames: ENOUGH, wallStep: 84, mediaStep: 41.7 });
    expect(watchdog.downgraded).toBe(true);
    expect(reported.ratio).toBeCloseTo(2, 1);
    expect(reported.meanMs).toBeCloseTo(84, 0);
  });

  it("tolerates jitter below the trip ratio", () => {
    const watchdog = createPerfWatchdog({ onDowngrade: () => {} });
    /* 1.2x real time - slower than the content, but inside the jitter allowance. */
    run(watchdog, { frames: ENOUGH, wallStep: 50, mediaStep: 41.7 });
    expect(watchdog.downgraded).toBe(false);
  });

  it("latches, so a fast stretch after a downgrade does not undo it", () => {
    const watchdog = createPerfWatchdog({ onDowngrade: () => {} });
    run(watchdog, { frames: ENOUGH, wallStep: 84, mediaStep: 41.7 });
    expect(watchdog.downgraded).toBe(true);
    run(watchdog, { frames: ENOUGH, wallStep: 41.7, mediaStep: 41.7 });
    expect(watchdog.downgraded).toBe(true);
  });

  /* A paused player still gets repaints (see renderShaderOnce), and its media clock stands
     still while the wall clock runs - which would read as infinitely behind real time. */
  it("ignores frames where the media clock did not advance", () => {
    const watchdog = createPerfWatchdog({ onDowngrade: () => {} });
    run(watchdog, { frames: ENOUGH, wallStep: 500, mediaStep: 0 });
    expect(watchdog.downgraded).toBe(false);
    expect(watchdog.meanFrameMs).toBe(0);
  });

  it("ignores a seek, forward or backward", () => {
    const watchdog = createPerfWatchdog({ onDowngrade: () => {} });
    /* A backward seek makes the media delta negative; a forward one makes it enormous. */
    run(watchdog, { frames: ENOUGH, wallStep: 41.7, mediaStep: -1000 });
    run(watchdog, { frames: ENOUGH, wallStep: 41.7, mediaStep: 60000 });
    expect(watchdog.downgraded).toBe(false);
  });

  it("normalises playback rate so 2x playback is not read as falling behind", () => {
    const watchdog = createPerfWatchdog({ onDowngrade: () => {} });
    /* At 2x, one wall frame period covers two frame periods of media. */
    run(watchdog, { frames: ENOUGH, wallStep: 41.7, mediaStep: 83.4, playbackRate: 2 });
    expect(watchdog.downgraded).toBe(false);
    expect(watchdog.keepUpRatio).toBeCloseTo(1, 2);
  });

  it("does not trip during warmup, when compile and allocation land", () => {
    const watchdog = createPerfWatchdog({ onDowngrade: () => {} });
    /* Far over budget, but too few frames to complete a window. */
    run(watchdog, { frames: 15, wallStep: 400, mediaStep: 41.7 });
    expect(watchdog.downgraded).toBe(false);
  });

  /* The blind spot the drop rate exists to expose: a dropped frame means rVFC never fires for
     it, so both clocks skip forward together and the ratio stays a contented 1.00 even though
     one frame in five never reached the screen. */
  it("reports a drop rate while the keep-up ratio still reads as perfect", () => {
    const watchdog = createPerfWatchdog({ onDowngrade: () => {} });
    run(watchdog, { frames: ENOUGH, wallStep: 33.4, mediaStep: 33.4, dropEvery: 5 });
    expect(watchdog.keepUpRatio).toBeCloseTo(1, 2);
    expect(watchdog.dropRate).toBeGreaterThan(0.15);
    /* Report only - a drop rate on its own must never trip the downgrade. */
    expect(watchdog.downgraded).toBe(false);
  });

  it("reports no drops when none occur", () => {
    const watchdog = createPerfWatchdog({ onDowngrade: () => {} });
    run(watchdog, { frames: ENOUGH, wallStep: 33.4, mediaStep: 33.4 });
    expect(watchdog.dropRate).toBe(0);
  });

  it("discards the in-flight window on reset, since the work changed shape", () => {
    const watchdog = createPerfWatchdog({ onDowngrade: () => {} });
    run(watchdog, { frames: 100, wallStep: 84, mediaStep: 41.7 });
    watchdog.resetWindow();
    run(watchdog, { frames: 100, wallStep: 41.7, mediaStep: 41.7 });
    expect(watchdog.downgraded).toBe(false);
  });
});
