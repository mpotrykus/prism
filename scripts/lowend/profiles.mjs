// cpu is the fraction of the allowed host cores the emulator may use. A Cortex-A53 at
// ~1.7 GHz is several times slower per-core than a desktop core; tune with --cpu against
// a real stick rather than trusting these defaults.
export const PROFILES = {
  "firestick-lite": {
    label: "Fire TV Stick Lite / HD (Fire OS 7, 1 GB)",
    image: "system-images;android-28;google_apis;x86_64",
    device: "tv_1080p",
    ramMb: 1024,
    heapMb: 192,
    cores: 4,
    cpu: 0.25,
    density: 213,
    gpu: "swiftshader_indirect",
    net: "hsdpa",
  },
  "firestick-4k": {
    label: "Fire TV Stick 4K Max (Fire OS 7, 2 GB)",
    image: "system-images;android-28;google_apis;x86_64",
    device: "tv_1080p",
    ramMb: 2048,
    heapMb: 256,
    cores: 4,
    cpu: 0.35,
    density: 213,
    gpu: "swiftshader_indirect",
    net: "full",
  },
  "firestick-4k-max2": {
    label: "Fire TV Stick 4K Max 2nd gen (Fire OS 8, 2 GB)",
    image: "system-images;android-30;google_apis;x86_64",
    device: "tv_1080p",
    ramMb: 2048,
    heapMb: 256,
    cores: 4,
    cpu: 0.4,
    density: 213,
    gpu: "swiftshader_indirect",
    net: "full",
  },
};
