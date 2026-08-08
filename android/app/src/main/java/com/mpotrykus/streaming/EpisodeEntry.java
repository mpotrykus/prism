package com.mpotrykus.streaming;

/* Native code only ever sees pre-formatted display fields - src/player/ui/episode-list.js's
   formatEpisodeListItem already interprets Plex's own metadata shape ("S1 E1 - Title",
   "TV-14 • 44m • Nov 15, 2004", watched/progress) once, shared with the web overlay, so
   this class never needs to know Plex's field names or reimplement that formatting.
   thumbUrl is already a full, tokened URL (see native-bridge.js's plexAssetUrl) - this
   class never needs to know Plex's base URL/token either. */
class EpisodeEntry {
    /* index is Plex's season-relative episode number (already baked into title's "S1 E5"
       text) - NOT a queue position. queueIndex is the position in queueRatingKeys and is
       what requestTitleNav needs; conflating the two sends nav to the wrong item. */
    final int index;
    final int queueIndex;
    final String ratingKey;
    final String title;
    final String subtitle;
    final String summary;
    final String thumbUrl;
    final float progress;
    final boolean watched;
    final boolean current;

    EpisodeEntry(int index, int queueIndex, String ratingKey, String title, String subtitle, String summary,
            String thumbUrl, float progress, boolean watched, boolean current) {
        this.index = index;
        this.queueIndex = queueIndex;
        this.ratingKey = ratingKey;
        this.title = title;
        this.subtitle = subtitle;
        this.summary = summary;
        this.thumbUrl = thumbUrl;
        this.progress = progress;
        this.watched = watched;
        this.current = current;
    }
}
