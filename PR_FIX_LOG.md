# PR Fix Log

## app/static/app.js
- L2017: Added `strippedRaw` derived from `raw.replace(prefixRe, '')` to preserve original text minus echoed prefix.
- L2021: Switched `el.dataset.raw` assignment from `raw` to `strippedRaw` so history stores the prefix-stripped content.
