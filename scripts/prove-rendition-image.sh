#!/bin/sh
# Prove the document viewer's conversion sandbox inside the built API image, on
# the LibreOffice production runs, as root, the way the API runs. It builds the
# image, mounts the tests read-only, gives the data directory a real volume, and
# runs the crafted-document proof and the OS wall tests. Passing means every test
# passed: any skip, xfail, or xpass fails the run, so it cannot pass by proving
# nothing. Needs Docker, and network for pip to fetch pytest into the throwaway
# container. Nothing is pushed, and the volume goes with the container.
#
#   scripts/prove-rendition-image.sh [image-tag]
set -eu
cd "$(dirname "$0")/.."
image="${1:-aperture-api:rendition-proof}"
docker build -f services/api/Dockerfile -t "$image" .
exec docker run --rm --init \
    --env APERTURE_RENDITION_IMAGE_PROOF=1 \
    --env APERTURE_PROOF_SECRET=synthetic-wall-proof-environment-secret \
    --volume /srv/aperture/services/api/data \
    --volume "$PWD/services/api/tests:/srv/aperture/services/api/tests:ro" \
    "$image" \
    sh -c '
        pip install --quiet --root-user-action=ignore pytest || exit 1
        python -m pytest tests/test_rendition_os_wall.py tests/test_document_rendition_proof.py \
            -p no:cacheprovider -v -rxXs > /tmp/proof.log 2>&1
        status=$?
        cat /tmp/proof.log
        [ "$status" -eq 0 ] || exit "$status"
        if tail -n 1 /tmp/proof.log | grep -Eq "skipped|xfailed|xpassed"; then
            echo "A test did not run or did not prove its point: this is not a pass."
            exit 1
        fi
    '
