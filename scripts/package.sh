#!/usr/bin/env bash
# Packages the extension for both browsers from the shared source.
#   firefox/ → .xpi | chrome/ → .zip
# Symlinks (shared/content.js, shared/icon.svg) become real files inside the archives.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -f firefox/binus-logbook-uploader.xpi chrome/binus-logbook-uploader.zip
(cd firefox/extension && zip -q -r ../../dist/firefox/binus-logbook-uploader.xpi .)
(cd chrome && zip -q -r ../dist/chrome/binus-logbook-uploader.zip . -x '*.DS_Store')
echo "firefox/binus-logbook-uploader.xpi:"
unzip -l firefox/binus-logbook-uploader.xpi
echo "chrome/binus-logbook-uploader.zip:"
unzip -l chrome/binus-logbook-uploader.zip