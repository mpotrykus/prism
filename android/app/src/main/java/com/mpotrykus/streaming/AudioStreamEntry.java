package com.mpotrykus.streaming;

/* Native code only ever sees {id, label} - plex-player.js's play() already reduced the
   raw Plex Stream objects down to this shape (see NativePlayerPlugin.play's
   audioStreams extra), so switching tracks below only needs the id to rewrite the
   transcode URL's audioStreamID param. */
class AudioStreamEntry {
    final String id;
    final String label;

    AudioStreamEntry(String id, String label) {
        this.id = id;
        this.label = label;
    }
}
