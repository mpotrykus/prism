package com.mpotrykus.streaming;

import android.content.Intent;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativePlayer")
public class NativePlayerPlugin extends Plugin implements PlayerActivity.PlaybackListener {

    @Override
    public void load() {
        super.load();
        PlayerActivity.setListener(this);
    }

    @PluginMethod
    public void play(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("Missing required parameter: url");
            return;
        }
        long startPositionMs = call.getLong("startPositionMs", 0L);
        JSArray chapters = call.getArray("chapters");

        Intent intent = new Intent(getContext(), PlayerActivity.class);
        intent.putExtra(PlayerActivity.EXTRA_URL, url);
        intent.putExtra(PlayerActivity.EXTRA_START_POSITION_MS, startPositionMs);
        if (chapters != null) {
            intent.putExtra(PlayerActivity.EXTRA_CHAPTERS_JSON, chapters.toString());
        }

        startActivityForResult(call, intent, "onPlaybackActivityResult");
    }

    @ActivityCallback
    private void onPlaybackActivityResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        PlayerActivity.pause();
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        PlayerActivity.resume();
        call.resolve();
    }

    @PluginMethod
    public void seek(PluginCall call) {
        Long positionMs = call.getLong("positionMs");
        if (positionMs == null) {
            call.reject("Missing required parameter: positionMs");
            return;
        }
        PlayerActivity.seek(positionMs);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        PlayerActivity.stopPlayback();
        call.resolve();
    }

    @PluginMethod
    public void setPlaybackSpeed(PluginCall call) {
        Float speed = call.getFloat("speed");
        if (speed == null) {
            call.reject("Missing required parameter: speed");
            return;
        }
        PlayerActivity.setPlaybackSpeed(speed);
        call.resolve();
    }

    @PluginMethod
    public void showSkipButton(PluginCall call) {
        String label = call.getString("label");
        Long seekToMs = call.getLong("seekToMs");
        if (label == null || seekToMs == null) {
            call.reject("Missing required parameter: label and/or seekToMs");
            return;
        }
        PlayerActivity.showSkipButton(label, seekToMs);
        call.resolve();
    }

    @PluginMethod
    public void hideSkipButton(PluginCall call) {
        PlayerActivity.hideSkipButton();
        call.resolve();
    }

    @PluginMethod
    public void setSubtitle(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("Missing required parameter: url");
            return;
        }
        String languageCode = call.getString("languageCode", "en");
        String mimeType = call.getString("mimeType", "application/x-subrip");
        PlayerActivity.setSubtitleUrl(url, languageCode, mimeType);
        call.resolve();
    }

    @Override
    public void onProgress(long positionMs, long durationMs) {
        JSObject data = new JSObject();
        data.put("positionMs", positionMs);
        data.put("durationMs", durationMs);
        notifyListeners("progress", data);
    }

    @Override
    public void onEnded() {
        notifyListeners("ended", new JSObject());
    }

    @Override
    public void onError(String message) {
        JSObject data = new JSObject();
        data.put("message", message != null ? message : "Unknown playback error");
        notifyListeners("error", data);
    }

    @Override
    public void onStopped(long positionMs) {
        JSObject data = new JSObject();
        data.put("positionMs", positionMs);
        notifyListeners("stopped", data);
    }
}
