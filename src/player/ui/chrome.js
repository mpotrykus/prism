/* Fullscreen player chrome: the idle-fade control row, transport bar, every hamburger
   submenu, the Audio & Subtitles overlay, and the skip-intro/credits button. Split across
   a handful of files by concern (each still takes the StreamingPlayerController instance
   as an explicit first argument, see native-bridge.js/shader-pipeline.js for why the
   idle-fade timer/session state stay as controller fields rather than each file owning
   independent state):

     chrome-controls.js   - the shared idle-fade control-button row + buffering spinner
     chrome-transport.js  - the bottom transport bar (scrub bar/chapter segments/BIF
                             preview, volume, fullscreen) and center play/seek/chapter/
                             title-nav controls
     chrome-menu.js       - the hamburger "More" sheet's top-level list plus the
                             accordion-row/picker-list primitives shared with:
     chrome-menu-effects.js - its Effects sub-screen (Shader Upscaling/Color Boost/
                               Ambient Lighting)
     chrome-menu-extras.js  - its Extras sub-screen (Playback Speed/Zoom/Sleep Timer),
                               plus zoom pan/transform
     chrome-subtitles.js  - the Audio & Subtitles overlay and subtitle track/offset
                             handling
     chrome-skip.js       - the skip-intro/credits button and marker helpers

   This file re-exports the combined public API so existing call sites (plex-player.js,
   web-fallback.js, native-bridge.js, episode-list.js) keep importing from "./chrome.js"
   unchanged. */

export { makeControlButton, registerControlButton, showControls, hideControls, scheduleHideControls, buildLoadingSpinner } from "./chrome-controls.js";

export { buildCenterControls, buildTransportBar, playQueuedTitle, formatTime } from "./chrome-transport.js";

export { openHamburgerMenu, closeInlineMenu } from "./chrome-menu.js";

export { applyZoomTransform, wireZoomPan } from "./chrome-menu-extras.js";

export { openAudioSubtitlesOverlay, closeAudioSubtitlesOverlay, applyRememberedSubtitle, stopSubtitleLoop } from "./chrome-subtitles.js";

export { activeMarkerAt, skipLabelFor, updateSkipButton } from "./chrome-skip.js";
