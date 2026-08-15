import { describe, it, expect } from "vitest";
import {
    decideAbrAction,
    decideStallDrivenAction,
    notifyStall,
    STABILITY_WINDOW_TICKS,
    DOWNGRADE_CONFIRM_TICKS,
} from "./abr.js";

// Ladder indices: 0 Original(20000 proxy), 1 1080p(20000), 2 720p(10000), 3 480p(4000), 4 360p(2000)

describe("decideAbrAction", () => {
    it("does nothing when bandwidth comfortably covers the current rung with no headroom for the next one up", () => {
        const result = decideAbrAction({ currentIndex: 2, bandwidthKbps: 11000, downgradeStreak: 0, stableStreak: 0 });
        expect(result.action).toBe("none");
        expect(result.stableStreak).toBe(0);
    });

    it("accumulates a downgrade streak without switching before DOWNGRADE_CONFIRM_TICKS", () => {
        const first = decideAbrAction({ currentIndex: 2, bandwidthKbps: 8000, downgradeStreak: 0, stableStreak: 0 });
        expect(first.action).toBe("none");
        expect(first.downgradeStreak).toBe(1);
    });

    it("steps down one rung once the shortfall streak reaches DOWNGRADE_CONFIRM_TICKS", () => {
        const result = decideAbrAction({
            currentIndex: 2,
            bandwidthKbps: 8000,
            downgradeStreak: DOWNGRADE_CONFIRM_TICKS - 1,
            stableStreak: 0,
        });
        expect(result.action).toBe("down");
        expect(result.nextIndex).toBe(3);
        expect(result.downgradeStreak).toBe(0);
    });

    it("jumps straight to the best-fitting rung instead of stepping down one at a time", () => {
        const result = decideAbrAction({
            currentIndex: 0,
            bandwidthKbps: 5000,
            downgradeStreak: DOWNGRADE_CONFIRM_TICKS - 1,
            stableStreak: 0,
        });
        expect(result.action).toBe("down");
        expect(result.nextIndex).toBe(3);
    });

    it("jumps straight to the floor when bandwidth doesn't clear any rung", () => {
        const result = decideAbrAction({
            currentIndex: 0,
            bandwidthKbps: 100,
            downgradeStreak: DOWNGRADE_CONFIRM_TICKS - 1,
            stableStreak: 0,
        });
        expect(result.action).toBe("down");
        expect(result.nextIndex).toBe(4);
    });

    it("never steps down past the floor rung", () => {
        const result = decideAbrAction({
            currentIndex: 4,
            bandwidthKbps: 100,
            downgradeStreak: DOWNGRADE_CONFIRM_TICKS - 1,
            stableStreak: 0,
        });
        expect(result.action).toBe("none");
    });

    it("accumulates a stability streak without switching before STABILITY_WINDOW_TICKS", () => {
        const result = decideAbrAction({ currentIndex: 3, bandwidthKbps: 16000, downgradeStreak: 0, stableStreak: 0 });
        expect(result.action).toBe("none");
        expect(result.stableStreak).toBe(1);
    });

    it("steps up one rung once sustained headroom reaches STABILITY_WINDOW_TICKS", () => {
        const result = decideAbrAction({
            currentIndex: 3,
            bandwidthKbps: 16000,
            downgradeStreak: 0,
            stableStreak: STABILITY_WINDOW_TICKS - 1,
        });
        expect(result.action).toBe("up");
        expect(result.nextIndex).toBe(2);
        expect(result.stableStreak).toBe(0);
    });

    it("never steps up past the ceiling rung", () => {
        const result = decideAbrAction({
            currentIndex: 0,
            bandwidthKbps: 999999,
            downgradeStreak: 0,
            stableStreak: STABILITY_WINDOW_TICKS - 1,
        });
        expect(result.action).toBe("none");
        expect(result.stableStreak).toBe(0);
    });

    it("resets the stability streak when headroom disappears without qualifying as a shortfall", () => {
        // at rung 2 (10000kbps): current-rung floor is 9000, next-up headroom needs 30000 - 12000 is between them
        const result = decideAbrAction({ currentIndex: 2, bandwidthKbps: 12000, downgradeStreak: 0, stableStreak: 4 });
        expect(result.action).toBe("none");
        expect(result.stableStreak).toBe(0);
    });

    it("resets the downgrade streak the moment bandwidth recovers above the shortfall threshold", () => {
        const result = decideAbrAction({ currentIndex: 2, bandwidthKbps: 12000, downgradeStreak: 1, stableStreak: 0 });
        expect(result.downgradeStreak).toBe(0);
    });
});

describe("decideStallDrivenAction (no bandwidth signal)", () => {
    it("accumulates a stable streak without switching before STABILITY_WINDOW_TICKS", () => {
        const result = decideStallDrivenAction({ currentIndex: 2, stableStreak: 0 });
        expect(result.action).toBe("none");
        expect(result.stableStreak).toBe(1);
    });

    it("steps up one rung once the stable streak reaches STABILITY_WINDOW_TICKS", () => {
        const result = decideStallDrivenAction({ currentIndex: 2, stableStreak: STABILITY_WINDOW_TICKS - 1 });
        expect(result.action).toBe("up");
        expect(result.nextIndex).toBe(1);
        expect(result.stableStreak).toBe(0);
    });

    it("never steps up past the ceiling, and does not accumulate there", () => {
        const result = decideStallDrivenAction({ currentIndex: 0, stableStreak: STABILITY_WINDOW_TICKS });
        expect(result.action).toBe("none");
        expect(result.stableStreak).toBe(0);
    });
});

describe("notifyStall in stall-driven mode", () => {
    function makeController(qualityCapKbps, lastSwitchAt) {
        const reloads = [];
        return {
            _session: { qualityCapKbps },
            _autoQualityEnabled: true,
            _abrStallDriven: true,
            _abrStableStreak: STABILITY_WINDOW_TICKS - 1,
            _abrDowngradeStreak: 0,
            _abrLastSwitchAt: lastSwitchAt,
            _reloadSource: (overrides) => reloads.push(overrides),
            reloads,
        };
    }

    it("steps down a rung on a real stall", () => {
        const c = makeController(10000, 0);
        notifyStall(c);
        expect(c.reloads).toEqual([{ qualityCapKbps: 4000 }]);
    });

    /* The reason the streak reset sits before the cooldown check: in stall-driven mode the streak IS
       the step-up trigger, so a connection stalling once per cooldown window would otherwise keep
       climbing the ladder. */
    it("cancels progress toward stepping up even when the cooldown blocks the switch", () => {
        const c = makeController(10000, Date.now());
        notifyStall(c);
        expect(c.reloads).toHaveLength(0);
        expect(c._abrStableStreak).toBe(0);
    });
});
