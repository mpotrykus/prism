package com.mpotrykus.streaming;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Handler;
import android.os.Looper;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/* Minimal HTTP helper shared by BifIndex's Range requests and the Chapters menu's
   per-row thumbnail fetch. There's no OkHttp/Glide/Volley anywhere in this app (checked
   before adding this) and both use cases are small (a handful of Range requests per
   playback session, one image per chapter row) - matches this codebase's existing
   preference for hand-rolled Views (ChapterSkipIconView, SeekIconView, etc.) over
   pulling in a library for a small job. */
final class PlexHttp {
    private static final ExecutorService EXECUTOR = Executors.newCachedThreadPool();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    interface Callback<T> {
        void onResult(T result);
    }

    private PlexHttp() {}

    static byte[] rangeFetchSync(String url, long start, long end) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setRequestProperty("Range", "bytes=" + start + "-" + end);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            int code = conn.getResponseCode();
            if (code != HttpURLConnection.HTTP_PARTIAL && code != HttpURLConnection.HTTP_OK) {
                throw new IOException("HTTP " + code);
            }
            return readAll(conn.getInputStream());
        } finally {
            conn.disconnect();
        }
    }

    static Bitmap fetchBitmapSync(String url) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            return BitmapFactory.decodeStream(conn.getInputStream());
        } finally {
            conn.disconnect();
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        return out.toByteArray();
    }

    /* Runs fetcher off the main thread and delivers its result - or null on any failure,
       every caller here treats "no preview/thumbnail data" as a normal, silent outcome,
       never a crash - back on the main thread. */
    static <T> void runAsync(Callable<T> fetcher, Callback<T> callback) {
        EXECUTOR.submit(() -> {
            T result;
            try {
                result = fetcher.call();
            } catch (Exception e) {
                result = null;
            }
            T finalResult = result;
            MAIN.post(() -> callback.onResult(finalResult));
        });
    }
}
