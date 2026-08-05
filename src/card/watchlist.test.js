import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { paintWatchlistButton, addToWatchlist, removeFromWatchlist } from "./watchlist.js";

function makeButton() {
  return {
    dataset: {},
    classList: {
      _set: new Set(),
      add(...cls) {
        cls.forEach((c) => this._set.add(c));
      },
      remove(...cls) {
        cls.forEach((c) => this._set.delete(c));
      },
      toggle(cls, on) {
        if (on) this._set.add(cls);
        else this._set.delete(cls);
      },
      contains(cls) {
        return this._set.has(cls);
      },
    },
    textContent: "",
    setAttribute(name, value) {
      this[name] = value;
    },
  };
}

describe("paintWatchlistButton", () => {
  it("paints the 'added' state", () => {
    const btn = makeButton();
    paintWatchlistButton(btn, true);
    expect(btn.classList.contains("added")).toBe(true);
    expect(btn.textContent).toBe("✓");
    expect(btn["aria-label"]).toBe("Remove from My List");
  });

  it("paints the 'not added' state", () => {
    const btn = makeButton();
    paintWatchlistButton(btn, false);
    expect(btn.classList.contains("added")).toBe(false);
    expect(btn.textContent).toBe("+");
    expect(btn["aria-label"]).toBe("Add to My List");
  });
});

describe("addToWatchlist / removeFromWatchlist", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("resolves the discover ratingKey, PUTs addToWatchlist, and paints success", async () => {
    const calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        calls.push(url.toString());
        if (url.toString().includes("/library/search")) {
          return { ok: true, json: async () => ({ MediaContainer: { SearchResults: [{ SearchResult: [{ Metadata: { title: "Dune", ratingKey: "999" } }] }] } }) };
        }
        return { ok: true, json: async () => ({}) };
      })
    );
    const btn = makeButton();
    const onSuccess = vi.fn();
    await addToWatchlist({ title: "Dune", type: "movie" }, btn, { plexAccountToken: "TOKEN", onSuccess });
    expect(calls[0]).toContain("/library/search");
    expect(calls[1]).toContain("/actions/addToWatchlist");
    expect(calls[1]).toContain("ratingKey=999");
    expect(btn.classList.contains("added")).toBe(true);
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(btn.dataset.busy).toBeUndefined();
  });

  it("marks the button as errored when no discover match is found", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ MediaContainer: {} }) })));
    const btn = makeButton();
    await removeFromWatchlist({ title: "Unknown" }, btn, { plexAccountToken: "TOKEN" });
    expect(btn.classList.contains("error")).toBe(true);
    expect(btn.classList.contains("busy")).toBe(false);
  });

  it("ignores a call while already busy", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    const btn = makeButton();
    btn.dataset.busy = "1";
    await addToWatchlist({ title: "Dune" }, btn, { plexAccountToken: "TOKEN" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
