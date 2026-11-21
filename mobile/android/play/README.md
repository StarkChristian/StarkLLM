# Google Play store listing

The texts and images of the Google Play page of StarkLLM for Android, one folder per language
(`en` is the default language of the listing).

| File | Play Console field | Limit |
| --- | --- | --- |
| `title.txt` | App name | 30 characters |
| `short-description.txt` | Short description | 80 characters |
| `full-description.txt` | Full description | 4000 characters |
| `feature-graphic.jpg` | Feature graphic | 1024 × 500 |
| `phone-*.jpg` | Phone screenshots, in this order | 9:16, 1080 × 1920 |
| `../icon-512.png` | App icon (same for all languages) | 512 × 512 |

The texts say the same as the website's Android page (`src/i18n/android.ts` and `src/i18n/langs/*/android.ts`
in the website repository), so the store page and the website do not contradict each other. When the app changes,
change both.

The screenshots are the phone pictures of the six-language tour (`www.starkllm.com/tour`, invented letters of an
invented person), with a caption on top; `make-images.js` renders them with Playwright and the website's font.
The icon is the app's own launcher icon (`app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png` on
`#07060B`).
