package com.mpotrykus.streaming;

/* Native code only ever sees pre-formatted display fields - src/player/ui/episode-list.js's
   formatEpisodeListItem already interprets Plex's own metadata shape ("S1 E1 - Title",
   "TV-14 • 44m • Nov 15, 2004", watched/progress) once, shared with the web overlay, so
   this class never needs to know Plex's field names or reimplement that formatting.
   thumbUrl is already a full, tokened URL (see native-bridge.js's plexAssetUrl) - this
   class never needs to know Plex's base URL/token either. */
class EpisodeEntry {
    final int index;
    final String ratingKey;
    final String title;
    final String subtitle;
    final String summary;
    final String thumbUrl;
    final float progress;
    final boolean watched;
    final boolean current;

    EpisodeEntry(int index, String ratingKey, String title, String subtitle, String summary,
            String thumbUrl, float progress, boolean watched, boolean current) {
        this.index = index;
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
