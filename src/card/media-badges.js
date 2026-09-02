import { escapeHtml } from "../core/html.js";
/* Icon library for the media-format tags Plex/media items carry (resolution, HDR, audio
   format, channel layout, subtitle type, edition, playback method, ...). Icons are Material
   Design Icons (MDI, pictogrammers.com/library/mdi) - Apache-2.0, safe to embed as-is,
   sourced verbatim from the @mdi/svg npm package (v7.4.47) rather than a scrape. MDI covers
   generic pictograms (a boxed "4K"/"HD"/"SD"/"HDR" glyph, surround-sound speaker layouts,
   closed-caption, etc) plus a small set of recognizable brand marks it ships deliberately
   (Netflix, Spotify, YouTube, Dolby, ...) - `dolby` below is one of those, not a scraped
   logo. There is no MDI icon for DTS, IMAX, or any of the plain codec acronyms
   (AV1/HEVC/H.264/.../AAC/FLAC/...) - those tags fall through to a text-only chip via
   MEDIA_BADGES' `icon: null`, same as any tag not in this map at all. */

const ICON_4K =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19,3H5A2,2 0 0,0 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5A2,2 0 0,0 19,3M12,13.5H11V15H9.5V13.5H6.5V9H8V12H9.5V9H11V12H12V13.5M18,15H16.2L14.4,12.8V15H13V9H14.5V11.2L16.2,9H18L15.8,12L18,15Z"/></svg>';
const ICON_HD =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19,3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5A2,2 0 0,0 19,3M11,15H9.5V13H7.5V15H6V9H7.5V11.5H9.5V9H11V15M13,9H17A1,1 0 0,1 18,10V14A1,1 0 0,1 17,15H13V9M14.5,13.5H16.5V10.5H14.5V13.5Z"/></svg>';
const ICON_UHD =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9,7H11V11H13V7H15V17H13V13H11V17H9V7M17,7H20A3,3 0 0,1 23,10V14A3,3 0 0,1 20,17H17V7M20,15A1,1 0 0,0 21,14V10A1,1 0 0,0 20,9H19V15H20M7,14A3,3 0 0,1 4,17A3,3 0 0,1 1,14V7H3V14A1,1 0 0,0 4,15A1,1 0 0,0 5,14V7H7V14Z"/></svg>';
const ICON_SD =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13,7H16A3,3 0 0,1 19,10V14A3,3 0 0,1 16,17H13V7M16,15A1,1 0 0,0 17,14V10A1,1 0 0,0 16,9H15V15H16M7,7H11V9H7V11H9A2,2 0 0,1 11,13V15A2,2 0 0,1 9,17H5V15H9V13H7A2,2 0 0,1 5,11V9A2,2 0 0,1 7,7Z"/></svg>';
const ICON_HDR =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21,11.5V10.5C21,9.7 20.3,9 19.5,9H16V15H17.5V13H18.6L19.5,15H21L20.1,12.9C20.6,12.6 21,12.1 21,11.5M19.5,11.5H17.5V10.5H19.5V11.5M6.5,11H4.5V9H3V15H4.5V12.5H6.5V15H8V9H6.5V11M13,9H9.5V15H13C13.8,15 14.5,14.3 14.5,13.5V10.5C14.5,9.7 13.8,9 13,9M13,13.5H11V10.5H13V13.5Z"/></svg>';
const ICON_DOLBY =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2,5V19H22V5H2M6,17H4V7H6C8.86,7.09 11.1,9.33 11,12C11.1,14.67 8.86,16.91 6,17M20,17H18C15.14,16.91 12.9,14.67 13,12C12.9,9.33 15.14,7.09 18,7H20V17Z"/></svg>';
const ICON_SURROUND =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20,4H4A2,2 0 0,0 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V6A2,2 0 0,0 20,4M7.76,16.24L6.35,17.65C4.78,16.1 4,14.05 4,12C4,9.95 4.78,7.9 6.34,6.34L7.75,7.75C6.59,8.93 6,10.46 6,12C6,13.54 6.59,15.07 7.76,16.24M12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16M17.66,17.66L16.25,16.25C17.41,15.07 18,13.54 18,12C18,10.46 17.41,8.93 16.24,7.76L17.65,6.35C19.22,7.9 20,9.95 20,12C20,14.05 19.22,16.1 17.66,17.66M12,10A2,2 0 0,0 10,12A2,2 0 0,0 12,14A2,2 0 0,0 14,12A2,2 0 0,0 12,10Z"/></svg>';
const ICON_SURROUND_2_0 =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 7V9H7V11H5C3.9 11 3 11.9 3 13V17H9V15H5V13H7C8.1 13 9 12.1 9 11V9C9 7.9 8.1 7 7 7H3M13 17H11V15H13V17M17 7C15.9 7 15 7.9 15 9V15C15 16.1 15.9 17 17 17H19C20.1 17 21 16.1 21 15V9C21 7.9 20.1 7 19 7H17M17 9H19V15H17V9Z"/></svg>';
const ICON_SURROUND_2_1 =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 7V9H8V11H6C4.9 11 4 11.9 4 13V17H10V15H6V13H8C9.1 13 10 12.1 10 11V9C10 7.9 9.1 7 8 7H4M14 17H12V15H14V17M16 7V9H18V17H20V7H16Z"/></svg>';
const ICON_SURROUND_5_1 =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 17H12V15H14V17M20 7V17H18V9H16V7H20M10 7V9H6V11H8C9.1 11 10 11.9 10 13V15C10 16.1 9.1 17 8 17H4V15H8V13H4V7H10Z"/></svg>';
const ICON_SURROUND_7_1 =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 17H12V15H14V17M20 7V17H18V9H16V7H20M4 17L8 9H4V7H10V9L6 17"/></svg>';
const ICON_SPEAKER =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12,12A3,3 0 0,0 9,15A3,3 0 0,0 12,18A3,3 0 0,0 15,15A3,3 0 0,0 12,12M12,20A5,5 0 0,1 7,15A5,5 0 0,1 12,10A5,5 0 0,1 17,15A5,5 0 0,1 12,20M12,4A2,2 0 0,1 14,6A2,2 0 0,1 12,8C10.89,8 10,7.1 10,6C10,4.89 10.89,4 12,4M17,2H7C5.89,2 5,2.89 5,4V20A2,2 0 0,0 7,22H17A2,2 0 0,0 19,20V4C19,2.89 18.1,2 17,2Z"/></svg>';
const ICON_CC =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18,11H16.5V10.5H14.5V13.5H16.5V13H18V14A1,1 0 0,1 17,15H14A1,1 0 0,1 13,14V10A1,1 0 0,1 14,9H17A1,1 0 0,1 18,10M11,11H9.5V10.5H7.5V13.5H9.5V13H11V14A1,1 0 0,1 10,15H7A1,1 0 0,1 6,14V10A1,1 0 0,1 7,9H10A1,1 0 0,1 11,10M19,4H5C3.89,4 3,4.89 3,6V18A2,2 0 0,0 5,20H19A2,2 0 0,0 21,18V6C21,4.89 20.1,4 19,4Z"/></svg>';
const ICON_SUBTITLES =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20,4H4A2,2 0 0,0 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V6A2,2 0 0,0 20,4M4,12H8V14H4V12M14,18H4V16H14V18M20,18H16V16H20V18M20,14H10V12H20V14Z"/></svg>';
const ICON_EAR_HEARING =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17,20C16.71,20 16.44,19.94 16.24,19.85C15.53,19.5 15.03,18.97 14.53,17.47C14,15.91 13.06,15.18 12.14,14.47C11.35,13.86 10.53,13.23 9.82,11.94C9.29,11 9,9.93 9,9C9,6.2 11.2,4 14,4C16.8,4 19,6.2 19,9H21C21,5.07 17.93,2 14,2C10.07,2 7,5.07 7,9C7,10.26 7.38,11.65 8.07,12.9C9,14.55 10.05,15.38 10.92,16.05C11.73,16.67 12.31,17.12 12.63,18.1C13.23,19.92 14,20.94 15.36,21.65C15.87,21.88 16.43,22 17,22A4,4 0 0,0 21,18H19A2,2 0 0,1 17,20M7.64,2.64L6.22,1.22C4.23,3.21 3,5.96 3,9C3,12.04 4.23,14.79 6.22,16.78L7.63,15.37C6,13.74 5,11.5 5,9C5,6.5 6,4.26 7.64,2.64M11.5,9A2.5,2.5 0 0,0 14,11.5A2.5,2.5 0 0,0 16.5,9A2.5,2.5 0 0,0 14,6.5A2.5,2.5 0 0,0 11.5,9Z"/></svg>';
const ICON_HUMAN_CANE =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 12.24V22H17.06V12.24C17.06 12.09 17 12 16.93 11.89C16.84 11.8 16.74 11.76 16.62 11.76C16.47 11.76 16.36 11.8 16.27 11.89C16.18 12 16.14 12.1 16.14 12.24V13.16H15.23V12.5C14.53 12.33 13.9 12.04 13.35 11.63C12.8 11.22 12.34 10.74 11.96 10.19L11.61 11.39C11.5 11.81 11.5 12.24 11.5 12.68L11.5 13L11.5 13.33L13.35 15.94V22H11.5V17.34L9.82 15L9.65 18.25L6.86 22L5.38 20.87L7.77 17.64V12.68C7.77 12.15 7.82 11.63 7.91 11.11L8.25 9.54L6.86 10.32V13.63H5V9.23L10 6.4C10.29 6.26 10.59 6.18 10.91 6.18C11.23 6.18 11.54 6.27 11.83 6.44C12.15 6.62 12.39 6.88 12.57 7.23L13.31 8.8C13.6 9.38 14.04 9.87 14.64 10.26C15.23 10.65 15.89 10.85 16.62 10.85C17 10.85 17.32 11 17.6 11.24C17.88 11.5 18 11.83 18 12.24M12 2C13.11 2 14 2.9 14 4C14 5.11 13.11 6 12 6C10.9 6 10 5.11 10 4C10 2.9 10.9 2 12 2Z"/></svg>';
const ICON_3D =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5,7H9A2,2 0 0,1 11,9V15A2,2 0 0,1 9,17H5V15H9V13H6V11H9V9H5V7M13,7H16A3,3 0 0,1 19,10V14A3,3 0 0,1 16,17H13V7M16,15A1,1 0 0,0 17,14V10A1,1 0 0,0 16,9H15V15H16Z"/></svg>';
const ICON_THEATER =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4,15H6A2,2 0 0,1 8,17V19H9V17A2,2 0 0,1 11,15H13A2,2 0 0,1 15,17V19H16V17A2,2 0 0,1 18,15H20A2,2 0 0,1 22,17V19H23V22H1V19H2V17A2,2 0 0,1 4,15M11,7L15,10L11,13V7M4,2H20A2,2 0 0,1 22,4V13.54C21.41,13.19 20.73,13 20,13V4H4V13C3.27,13 2.59,13.19 2,13.54V4A2,2 0 0,1 4,2Z"/></svg>';
const ICON_ASPECT =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19,12H17V15H14V17H19V12M7,9H10V7H5V12H7V9M21,3H3A2,2 0 0,0 1,5V19A2,2 0 0,0 3,21H21A2,2 0 0,0 23,19V5A2,2 0 0,0 21,3M21,19H3V5H21V19Z"/></svg>';
const ICON_PANORAMA =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 4C8 4 5.2 4.6 3 5C2.5 7 2 8.9 2 12C2 15 2.5 17 3 19C5.2 19.4 8 20 12 20C16 20 18.9 19.4 21 19C21.6 17 22 15 22 12C22 9 21.5 6.9 21 5C18.9 4.6 16 4 12 4Z"/></svg>';
const ICON_MOVIE =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18,4L20,8H17L15,4H13L15,8H12L10,4H8L10,8H7L5,4H4A2,2 0 0,0 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V4H18Z"/></svg>';
const ICON_TV =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.16,3L6.75,4.41L9.34,7H4C2.89,7 2,7.89 2,9V19C2,20.11 2.89,21 4,21H20C21.11,21 22,20.11 22,19V9C22,7.89 21.11,7 20,7H14.66L17.25,4.41L15.84,3L12,6.84L8.16,3M4,9H17V19H4V9M19.5,9A1,1 0 0,1 20.5,10A1,1 0 0,1 19.5,11A1,1 0 0,1 18.5,10A1,1 0 0,1 19.5,9M19.5,12A1,1 0 0,1 20.5,13A1,1 0 0,1 19.5,14A1,1 0 0,1 18.5,13A1,1 0 0,1 19.5,12Z"/></svg>';
const ICON_FILMSTRIP =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18,9H16V7H18M18,13H16V11H18M18,17H16V15H18M8,9H6V7H8M8,13H6V11H8M8,17H6V15H8M18,3V5H16V3H8V5H6V3H4V21H6V19H8V21H16V19H18V21H20V3H18Z"/></svg>';
const ICON_MOVIE_PLAY =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22 4V13.81C21.12 13.3 20.1 13 19 13C15.69 13 13 15.69 13 19C13 19.34 13.04 19.67 13.09 20H4C2.9 20 2 19.11 2 18V6C2 4.89 2.9 4 4 4H5L7 8H10L8 4H10L12 8H15L13 4H15L17 8H20L18 4H22M17 22L22 19L17 16V22Z"/></svg>';
const ICON_SEASON =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15,5A2,2 0 0,1 17,7V23L10,20L3,23V7C3,5.89 3.9,5 5,5H15M9,1H19A2,2 0 0,1 21,3V19L19,18.13V3H7A2,2 0 0,1 9,1Z"/></svg>';
const ICON_MUSIC =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3V13.55C11.41 13.21 10.73 13 10 13C7.79 13 6 14.79 6 17S7.79 21 10 21 14 19.21 14 17V7H18V3H12Z"/></svg>';
const ICON_MIC =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z"/></svg>';
const ICON_BROADCAST =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 10C10.9 10 10 10.9 10 12S10.9 14 12 14 14 13.1 14 12 13.1 10 12 10M18 12C18 8.7 15.3 6 12 6S6 8.7 6 12C6 14.2 7.2 16.1 9 17.2L10 15.5C8.8 14.8 8 13.5 8 12.1C8 9.9 9.8 8.1 12 8.1S16 9.9 16 12.1C16 13.6 15.2 14.9 14 15.5L15 17.2C16.8 16.2 18 14.2 18 12M12 2C6.5 2 2 6.5 2 12C2 15.7 4 18.9 7 20.6L8 18.9C5.6 17.5 4 14.9 4 12C4 7.6 7.6 4 12 4S20 7.6 20 12C20 15 18.4 17.5 16 18.9L17 20.6C20 18.9 22 15.7 22 12C22 6.5 17.5 2 12 2Z"/></svg>';
const ICON_DOCUMENTARY =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.84 2.18L16.91 2.96L19.65 6.5L21.62 6.1L20.84 2.18M13.97 3.54L12 3.93L14.75 7.46L16.71 7.07L13.97 3.54M9.07 4.5L7.1 4.91L9.85 8.44L11.81 8.05L9.07 4.5M4.16 5.5L3.18 5.69A2 2 0 0 0 1.61 8.04L2 10L6.9 9.03L4.16 5.5M2 10V20C2 21.11 2.9 22 4 22H20C21.11 22 22 21.11 22 20V10H2Z"/></svg>';
const ICON_PLAY_CIRCLE =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10,16.5V7.5L16,12M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z"/></svg>';
const ICON_CAST =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M1,10V12A9,9 0 0,1 10,21H12C12,14.92 7.07,10 1,10M1,14V16A5,5 0 0,1 6,21H8A7,7 0 0,0 1,14M1,18V21H4A3,3 0 0,0 1,18M21,3H3C1.89,3 1,3.89 1,5V8H3V5H21V19H14V21H21A2,2 0 0,0 23,19V5C23,3.89 22.1,3 21,3Z"/></svg>';
const ICON_TRANSCODE =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.5 18.5C11.5 17.4 11.8 16.4 12.2 15.5H12C10.1 15.5 8.5 13.9 8.5 12S10.1 8.5 12 8.5 15.5 10.1 15.5 12C15.5 12.2 15.5 12.4 15.4 12.5C16.2 12.2 17 12 18 12C18.5 12 19 12.1 19.5 12.2V12C19.5 11.7 19.5 11.3 19.4 11L21.5 9.4C21.7 9.2 21.7 9 21.6 8.8L19.6 5.3C19.5 5 19.3 5 19 5L16.5 6C16 5.6 15.4 5.3 14.8 5L14.4 2.3C14.5 2.2 14.2 2 14 2H10C9.8 2 9.5 2.2 9.5 2.4L9.1 5.1C8.5 5.3 8 5.7 7.4 6L5 5C4.7 5 4.5 5 4.3 5.3L2.3 8.8C2.2 9 2.3 9.2 2.5 9.4L4.6 11C4.6 11.3 4.5 11.7 4.5 12S4.5 12.7 4.6 13L2.5 14.7C2.3 14.9 2.3 15.1 2.4 15.3L4.4 18.8C4.5 19 4.7 19 5 19L7.5 18C8 18.4 8.6 18.7 9.2 19L9.6 21.7C9.6 21.9 9.8 22.1 10.1 22.1H12.6C11.9 21 11.5 19.8 11.5 18.5M18 14.5V13L15.8 15.2L18 17.4V16C19.4 16 20.5 17.1 20.5 18.5C20.5 18.9 20.4 19.3 20.2 19.6L21.3 20.7C22.5 18.9 22 16.4 20.2 15.2C19.6 14.7 18.8 14.5 18 14.5M18 21C16.6 21 15.5 19.9 15.5 18.5C15.5 18.1 15.6 17.7 15.8 17.4L14.7 16.3C13.5 18.1 14 20.6 15.8 21.8C16.5 22.2 17.2 22.5 18 22.5V24L20.2 21.8L18 19.5V21Z"/></svg>';
const ICON_CHIP =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6,4H18V5H21V7H18V9H21V11H18V13H21V15H18V17H21V19H18V20H6V19H3V17H6V15H3V13H6V11H3V9H6V7H3V5H6V4M11,15V18H12V15H11M13,15V18H14V15H13M15,15V18H16V15H15Z"/></svg>';
const ICON_COG =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.21,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.21,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.03 4.95,18.95L7.44,17.94C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.67 16.04,18.34 16.56,17.94L19.05,18.95C19.27,19.03 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z"/></svg>';
const ICON_VERIFIED =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23,12L20.56,9.22L20.9,5.54L17.29,4.72L15.4,1.54L12,3L8.6,1.54L6.71,4.72L3.1,5.53L3.44,9.21L1,12L3.44,14.78L3.1,18.47L6.71,19.29L8.6,22.47L12,21L15.4,22.46L17.29,19.28L20.9,18.46L20.56,14.78L23,12M10,17L6,13L7.41,11.59L10,14.17L16.59,7.58L18,9L10,17Z"/></svg>';
const ICON_RESTORE =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.5,5.6L5,7L6.4,4.5L5,2L7.5,3.4L10,2L8.6,4.5L10,7L7.5,5.6M19.5,15.4L22,14L20.6,16.5L22,19L19.5,17.6L17,19L18.4,16.5L17,14L19.5,15.4M22,2L20.6,4.5L22,7L19.5,5.6L17,7L18.4,4.5L17,2L19.5,3.4L22,2M13.34,12.78L15.78,10.34L13.66,8.22L11.22,10.66L13.34,12.78M14.37,7.29L16.71,9.63C17.1,10 17.1,10.65 16.71,11.04L5.04,22.71C4.65,23.1 4,23.1 3.63,22.71L1.29,20.37C0.9,20 0.9,19.35 1.29,18.96L12.96,7.29C13.35,6.9 14,6.9 14.37,7.29Z"/></svg>';

/* label -> {icon, hideLabel?}. `icon: null` (or missing from the map entirely) falls
   through to a text-only chip - the honest answer for tags with no real MDI pictogram
   (DTS/IMAX/every plain codec acronym) rather than forcing a stretched metaphor onto them.
   `hideLabel: true` is only for the handful of icons that already draw their own text
   (the boxed "4K"/"HD"/"SD"/"UHD"/"HDR" glyphs) - everything else needs the label alongside
   the icon since the icon alone can't carry it (e.g. `dolby` is reused across four
   different Dolby formats, `surround-sound` across three different channel counts). */
export const MEDIA_BADGES = {
  // Resolution / dynamic range
  "4K": { icon: ICON_4K, hideLabel: true },
  "1080p": { icon: ICON_HD, hideLabel: true },
  "720p": { icon: ICON_HD, hideLabel: true },
  "480p": { icon: ICON_SD, hideLabel: true },
  SD: { icon: ICON_SD, hideLabel: true },
  HD: { icon: ICON_HD, hideLabel: true },
  UHD: { icon: ICON_UHD, hideLabel: true },
  HDR: { icon: ICON_HDR, hideLabel: true },
  HDR10: { icon: ICON_HDR },
  "HDR10+": { icon: ICON_HDR },
  HLG: { icon: ICON_HDR },
  "Dolby Vision": { icon: ICON_DOLBY },

  // Video codecs - no MDI pictogram for any of these, text-only chip
  AV1: { icon: null },
  HEVC: { icon: null },
  "H.265": { icon: null },
  "H.264": { icon: null },
  "MPEG-2": { icon: null },
  VP9: { icon: null },
  "VC-1": { icon: null },

  // Audio format
  "Dolby Atmos": { icon: ICON_DOLBY },
  "Dolby Digital": { icon: ICON_DOLBY },
  "Dolby Digital Plus": { icon: ICON_DOLBY },
  "Dolby TrueHD": { icon: ICON_DOLBY },
  DTS: { icon: null },
  "DTS-HD": { icon: null },
  "DTS:X": { icon: null },
  AAC: { icon: null },
  FLAC: { icon: null },
  MP3: { icon: null },
  Opus: { icon: null },
  PCM: { icon: null },

  // Channel layout - the 2.1/5.1/7.1 icons draw their own "2.1"/"5.1"/"7.1" digits (same
  // self-labeling pattern as the resolution glyphs above), so hideLabel avoids literally
  // duplicating the text next to itself. Stereo keeps its label - its icon draws "2.0", not
  // the word "Stereo" - and the generic surround-sound icon (3.0/4.0/6.1/7.1.4) draws no
  // digits at all, so those still need the label to say which layout it is.
  Mono: { icon: ICON_SPEAKER },
  Stereo: { icon: ICON_SURROUND_2_0 },
  "2.1": { icon: ICON_SURROUND_2_1, hideLabel: true },
  "3.0": { icon: ICON_SURROUND },
  "4.0": { icon: ICON_SURROUND },
  "5.1": { icon: ICON_SURROUND_5_1, hideLabel: true },
  "6.1": { icon: ICON_SURROUND },
  "7.1": { icon: ICON_SURROUND_7_1, hideLabel: true },
  "7.1.4": { icon: ICON_SURROUND },

  // Subtitles / accessibility
  CC: { icon: ICON_CC },
  SDH: { icon: ICON_EAR_HEARING },
  SUB: { icon: ICON_SUBTITLES },
  Forced: { icon: ICON_SUBTITLES },
  AD: { icon: ICON_HUMAN_CANE },

  // Aspect ratio / format
  "16:9": { icon: ICON_ASPECT },
  "21:9": { icon: ICON_PANORAMA },
  IMAX: { icon: ICON_THEATER },
  "IMAX Enhanced": { icon: ICON_THEATER },
  "3D": { icon: ICON_3D, hideLabel: true },

  // Content type
  Movie: { icon: ICON_MOVIE },
  "TV Show": { icon: ICON_TV },
  Episode: { icon: ICON_FILMSTRIP },
  Season: { icon: ICON_SEASON },
  Trailer: { icon: ICON_MOVIE_PLAY },
  Short: { icon: ICON_FILMSTRIP },
  "Music Video": { icon: ICON_MUSIC },
  Concert: { icon: ICON_MIC },
  Live: { icon: ICON_BROADCAST },
  Documentary: { icon: ICON_DOCUMENTARY },
  Theatrical: { icon: ICON_THEATER },

  // Edition
  "Director's Cut": { icon: null },
  Extended: { icon: null },
  Unrated: { icon: null },
  Uncut: { icon: null },
  Remastered: { icon: ICON_RESTORE },
  "4K Remaster": { icon: ICON_RESTORE },
  "Anniversary Edition": { icon: null },

  // Playback method
  "Direct Play": { icon: ICON_PLAY_CIRCLE },
  "Direct Stream": { icon: ICON_CAST },
  Transcode: { icon: ICON_TRANSCODE },
  "Hardware Transcoding": { icon: ICON_CHIP },
  "Software Transcoding": { icon: ICON_COG },
  "Original Quality": { icon: ICON_VERIFIED },
};

/* Renders one badge chip for a label from (or not from) MEDIA_BADGES above - an unknown
   label just renders as a plain text chip, same as a mapped entry with `icon: null`. */
export function renderMediaBadge(label) {
  const entry = MEDIA_BADGES[label] || {};
  const icon = entry.icon ? `<span class="title-info-badge-icon">${entry.icon}</span>` : "";
  const text = entry.hideLabel ? "" : `<span class="title-info-badge-label">${escapeHtml(label)}</span>`;
  return `<span class="title-info-badge" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${icon}${text}</span>`;
}
