package com.mpotrykus.streaming;

/* Native code only ever sees {id, label, selected} - plex-player.js's play() already
   reduced the raw Plex Stream objects down to this shape (see NativePlayerPlugin.play's
   audioStreams extra), so switching tracks below only needs the id to rewrite the
   transcode URL's audioStreamID param; selected only feeds the Audio Track menu's
   checkmark on whichever stream is already playing. */
class AudioStreamEntry {
    final String id;
    final String label;
    final boolean selected;

    AudioStreamEntry(String id, String label, boolean selected) {
        this.id = id;
        this.label = label;
        this.selected = selected;
    }
}
