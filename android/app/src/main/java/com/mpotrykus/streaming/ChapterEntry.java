package com.mpotrykus.streaming;

/* Native code only ever sees {title, startTimeOffsetMs, thumbUrl} - Plex's own Chapter
   field names are interpreted once, in plex-player.js/native-bridge.js, and never
   duplicated here. thumbUrl is already a full, tokened URL (see native-bridge.js's
   plexAssetUrl) - this class never needs to know Plex's base URL/token. */
class ChapterEntry {
    final String title;
    final long startTimeOffsetMs;
    final String thumbUrl;

    ChapterEntry(String title, long startTimeOffsetMs, String thumbUrl) {
        this.title = title;
        this.startTimeOffsetMs = startTimeOffsetMs;
        this.thumbUrl = thumbUrl;
    }
}
