package com.mpotrykus.prism;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/* Java port of src/player/core/bif.js - see that file's header comment for the BIF
   trickplay format itself (magic bytes, 64-byte header, {timestamp,offset} index table
   with a numImages+1 sentinel entry, then raw JPEG frames). Kept in sync deliberately
   with the JS version rather than each platform re-deriving its own understanding of
   Plex's format independently. */
final class BifIndex {
    private static final byte[] MAGIC = {(byte) 0x89, 0x42, 0x49, 0x46, 0x0D, 0x0A, 0x1A, 0x0A};
    private static final int HEADER_SIZE = 64;

    static final class Frame {
        final long timeMs;
        final long offset;
        final long length;

        Frame(long timeMs, long offset, long length) {
            this.timeMs = timeMs;
            this.offset = offset;
            this.length = length;
        }
    }

    private final String url;
    private final List<Frame> frames;
    private final Map<Long, Bitmap> frameCache = new ConcurrentHashMap<>();

    private BifIndex(String url, List<Frame> frames) {
        this.url = url;
        this.frames = frames;
    }

    /* Fire-and-forget from PlayerActivity.onCreate - callback delivers null on any
       parse/network failure (malformed file, no BIF generated, unreachable server),
       same "no preview, not a crash" fallback the frame fetch below uses. */
    static void load(String url, PlexHttp.Callback<BifIndex> callback) {
        PlexHttp.runAsync(() -> loadSync(url), callback);
    }

    private static BifIndex loadSync(String url) throws Exception {
        byte[] header = PlexHttp.rangeFetchSync(url, 0, HEADER_SIZE - 1);
        if (header.length < HEADER_SIZE) return null;
        for (int i = 0; i < MAGIC.length; i++) {
            if (header[i] != MAGIC[i]) return null;
        }
        ByteBuffer headerBuf = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN);
        int numImages = headerBuf.getInt(12);
        int multiplier = headerBuf.getInt(16);
        if (multiplier == 0) multiplier = 1000;
        if (numImages <= 0) return null;

        /* numImages+1 entries - the trailing one exists only so every real frame's byte
           length can be computed as (next entry's offset - this entry's offset)
           without a special case for the last frame. */
        int tableBytes = (numImages + 1) * 8;
        byte[] table = PlexHttp.rangeFetchSync(url, HEADER_SIZE, HEADER_SIZE + tableBytes - 1);
        ByteBuffer tableBuf = ByteBuffer.wrap(table).order(ByteOrder.LITTLE_ENDIAN);
        List<Frame> frames = new ArrayList<>(numImages);
        for (int i = 0; i < numImages; i++) {
            long timestamp = tableBuf.getInt(i * 8) & 0xFFFFFFFFL;
            long offset = tableBuf.getInt(i * 8 + 4) & 0xFFFFFFFFL;
            long nextOffset = tableBuf.getInt((i + 1) * 8 + 4) & 0xFFFFFFFFL;
            frames.add(new Frame(timestamp * multiplier, offset, nextOffset - offset));
        }
        return new BifIndex(url, frames);
    }

    /* Binary search for the frame whose timestamp is closest to timeMs - frames are
       already in ascending time order per the BIF spec. */
    Frame findNearestFrame(long timeMs) {
        if (frames.isEmpty()) return null;
        int lo = 0;
        int hi = frames.size() - 1;
        while (lo < hi) {
            int mid = (lo + hi) >>> 1;
            if (frames.get(mid).timeMs < timeMs) lo = mid + 1;
            else hi = mid;
        }
        if (lo > 0 && Math.abs(frames.get(lo - 1).timeMs - timeMs) <= Math.abs(frames.get(lo).timeMs - timeMs)) {
            return frames.get(lo - 1);
        }
        return frames.get(lo);
    }

    void fetchFrameBitmap(Frame frame, PlexHttp.Callback<Bitmap> callback) {
        Bitmap cached = frameCache.get(frame.offset);
        if (cached != null) {
            callback.onResult(cached);
            return;
        }
        PlexHttp.runAsync(() -> {
            byte[] bytes = PlexHttp.rangeFetchSync(url, frame.offset, frame.offset + frame.length - 1);
            Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (bmp != null) frameCache.put(frame.offset, bmp);
            return bmp;
        }, callback);
    }
}
