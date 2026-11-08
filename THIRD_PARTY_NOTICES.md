# Third-party notices

Nabda's application code is available under the [MIT license](LICENSE). Dependencies and vendored files retain their own licenses; Nabda's license does not replace them.

| Material | License and notice |
| --- | --- |
| JourneyApps ZXing Android Embedded 4.3.0 and ZXing core 3.4.1, included in the Android test APK | Apache-2.0 and upstream attribution. The complete tagged texts are included in the APK at `assets/third-party-notices.txt`, in [the source asset](android/app/src/main/assets/third-party-notices.txt), and in [the downloadable notice](public/downloads/THIRD-PARTY-NOTICES.txt). |
| Cairo font files | [SIL Open Font License and attribution](public/fonts/Cairo-OFL.txt). |
| Caveat font file | [SIL Open Font License and attribution](public/fonts/Caveat-OFL.txt). |
| Vendored shadcn UI material | [Upstream license notice](vendor/shadcn-tailwind-4.13.0.LICENSE.md). |
| Retained legacy Sites Vite plugin | [Original MIT notice](scripts/vite/sites-vite-plugin.LICENSE), including OpenAI's copyright. This plugin is not part of the independent Worker build. |

The npm dependency versions are recorded in `package-lock.json`. Their licenses are distributed with the installed packages. The included Android artifact remains a debug-signed test build; see [its build information](android/artifacts/build-info.json).

The illustrated artwork was created for Nabda. Its prompts, source images and generation/edit provenance are recorded in [design-assets](design-assets/README.md).

The [httpSMS source study](docs/research/httpsms-study.md) is a comparison of architecture, not incorporated implementation. Upstream httpSMS is AGPL-3.0; no implementation from that study was copied into Nabda. Adding covered upstream code later requires reviewing its license separately.
