package com.mpotrykus.prism;

/* Native code only ever sees {mediaIndex, label} - plex-player.js's play() already
   reduced Plex's raw Media[] entries down to this shape (see title-info.js's
   extractMediaVersions), so switching versions below only needs the index to rewrite
   the transcode URL's mediaIndex param; label only feeds the Video Quality menu's
   row/checkmark text. */
class MediaVersionEntry {
    final int mediaIndex;
    final String label;

    MediaVersionEntry(int mediaIndex, String label) {
        this.mediaIndex = mediaIndex;
        this.label = label;
    }
}
