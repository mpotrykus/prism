package com.mpotrykus.streaming;

/* One Plex subtitle search hit - JS resolves the actual search (plex-subtitles.js's
   search(), shared with the web overlay) and hands this pre-formatted shape over the
   same "JS interprets the external protocol once, Java just renders it" split
   EpisodeEntry/AudioStreamEntry already use. fileId is opaque to Java - it's a
   JSON-encoded blob of everything plex-subtitles.js's download() needs (key/codec/
   language/etc), only ever echoed back to JS (PlayerActivity.requestSubtitleSelect) to
   resolve the actual subtitle text from Plex, never parsed or displayed itself. */
class SubtitleResultEntry {
    final String fileId;
    final String label;
    final String languageCode;

    SubtitleResultEntry(String fileId, String label, String languageCode) {
        this.fileId = fileId;
        this.label = label;
        this.languageCode = languageCode;
    }
}
