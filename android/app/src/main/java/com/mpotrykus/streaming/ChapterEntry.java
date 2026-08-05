package com.mpotrykus.streaming;

/* Native code only ever sees {title, startTimeOffsetMs} - Plex's own Chapter field
   names are interpreted once, in plex-player.js, and never duplicated here. */
class ChapterEntry {
    final String title;
    final long startTimeOffsetMs;

    ChapterEntry(String title, long startTimeOffsetMs) {
        this.title = title;
        this.startTimeOffsetMs = startTimeOffsetMs;
    }
}
