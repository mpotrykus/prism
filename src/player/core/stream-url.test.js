import { describe, it, expect } from "vitest";
import { buildStreamUrl, buildDecisionUrl } from "./stream-url.js";

const base = {
  plexUrl: "http://192.168.1.5:32400",
  plexToken: "TOKEN",
  key: "/library/metadata/123",
  sessionId: "session-1",
  startOffsetMs: 45000,
  clientIdentifier: "client-abc",
  platform: "Chrome",
};

describe("buildStreamUrl", () => {
  it("builds the base transcode URL with directPlay off and directStream on", () => {
    const url = new URL(buildStreamUrl(base));
    expect(url.pathname).toBe("/video/:/transcode/universal/start.m3u8");
    expect(url.searchParams.get("directPlay")).toBe("0");
    expect(url.searchParams.get("directStream")).toBe("1");
    expect(url.searchParams.get("directStreamAudio")).toBe("1");
    expect(url.searchParams.get("path")).toBe("/library/metadata/123");
    expect(url.searchParams.get("offset")).toBe("45");
    expect(url.searchParams.get("X-Plex-Token")).toBe("TOKEN");
    expect(url.searchParams.get("X-Plex-Platform")).toBe("Chrome");
  });

  it("always disables Plex's own subtitle handling so it never burns one in", () => {
    const url = new URL(buildStreamUrl(base));
    expect(url.searchParams.get("subtitleStreamID")).toBe("0");
  });

  it("omits maxVideoBitrate/audioStreamID when not given", () => {
    const url = new URL(buildStreamUrl(base));
    expect(url.searchParams.has("maxVideoBitrate")).toBe(false);
    expect(url.searchParams.has("audioStreamID")).toBe(false);
  });

  it("includes maxVideoBitrate and audioStreamID when provided", () => {
    const url = new URL(buildStreamUrl({ ...base, qualityCapKbps: 4000, audioStreamID: 7 }));
    expect(url.searchParams.get("maxVideoBitrate")).toBe("4000");
    expect(url.searchParams.get("audioStreamID")).toBe("7");
  });

  it("defaults mediaIndex/partIndex to 0", () => {
    const url = new URL(buildStreamUrl(base));
    expect(url.searchParams.get("mediaIndex")).toBe("0");
    expect(url.searchParams.get("partIndex")).toBe("0");
  });
});

describe("buildDecisionUrl", () => {
  it("targets the decision endpoint with the same params as buildStreamUrl", () => {
    const opts = { ...base, qualityCapKbps: 4000, audioStreamID: 7 };
    const decisionUrl = new URL(buildDecisionUrl(opts));
    const streamUrl = new URL(buildStreamUrl(opts));
    expect(decisionUrl.pathname).toBe("/video/:/transcode/universal/decision");
    for (const key of streamUrl.searchParams.keys()) {
      expect(decisionUrl.searchParams.get(key)).toBe(streamUrl.searchParams.get(key));
    }
  });
});
