package com.mpotrykus.streaming;

/* One OpenSubtitles search hit - JS resolves the actual search (opensubtitles.js's
   search(), shared with the web overlay) and hands this pre-formatted shape over the
   same "JS interprets the external protocol once, Java just renders it" split
   EpisodeEntry/AudioStreamEntry already use. fileId is opaque to Java - it only ever
   gets echoed back to JS (PlayerActivity.requestSubtitleSelect) to resolve a real
   download link, never parsed or displayed itself. */
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
