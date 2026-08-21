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

describe("clientCapabilities via X-Plex-Client-Capabilities", () => {
  it("defaults to the conservative h264-1080p-only string", () => {
    const caps = new URL(buildStreamUrl(base)).searchParams.get("X-Plex-Client-Capabilities");
    expect(caps).toContain("h264{profile:high&resolution:1080&level:51}");
    expect(caps).not.toContain("hevc");
  });

  it("widens to SDR HEVC 2160p when hevcMain10_2160 is true but hdr is false", () => {
    const caps = new URL(buildStreamUrl({ ...base, hevcMain10_2160: true }))
      .searchParams.get("X-Plex-Client-Capabilities");
    expect(caps).toContain("hevc{profile:main10&resolution:2160&level:153}");
    expect(caps).not.toContain("colorSpace");
    expect(caps).not.toContain("colorTrc");
    /* h264 stays as the fallback entry, listed after hevc for preference ordering. */
    expect(caps).toContain("h264{profile:high&resolution:1080&level:51}");
  });

  it("keeps the HDR branch (colorSpace/colorTrc) unaffected by hevcMain10_2160", () => {
    const caps = new URL(buildStreamUrl({ ...base, hdr: true, hevcMain10_2160: true }))
      .searchParams.get("X-Plex-Client-Capabilities");
    expect(caps).toContain("colorSpace:bt2020nc&colorTrc:smpte2084");
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

describe("progressive output", () => {
  const base = {
    plexUrl: "http://plex.local:32400",
    plexToken: "tok",
    key: "/library/metadata/1",
    sessionId: "sess",
    startOffsetMs: 0,
    clientIdentifier: "cid",
    platform: "Chrome",
  };

  it("uses start.m3u8 and protocol=hls by default", () => {
    const url = new URL(buildStreamUrl(base));
    expect(url.pathname).toBe("/video/:/transcode/universal/start.m3u8");
    expect(url.searchParams.get("protocol")).toBe("hls");
  });

  it("uses start.mp4 and protocol=http when progressive", () => {
    const url = new URL(buildStreamUrl({ ...base, progressive: true }));
    expect(url.pathname).toBe("/video/:/transcode/universal/start.mp4");
    expect(url.searchParams.get("protocol")).toBe("http");
  });

  /* The decision endpoint must agree with the start call on every param, protocol included - see
     buildDecisionUrl's comment on why a mismatched /decision doesn't predict what /start does. */
  it("carries the same protocol through to the decision URL", () => {
    expect(new URL(buildDecisionUrl({ ...base, progressive: true })).searchParams.get("protocol")).toBe("http");
    expect(new URL(buildDecisionUrl(base)).searchParams.get("protocol")).toBe("hls");
  });

  it("leaves the decision endpoint path alone regardless of progressive", () => {
    expect(new URL(buildDecisionUrl({ ...base, progressive: true })).pathname)
      .toBe("/video/:/transcode/universal/decision");
  });
});
