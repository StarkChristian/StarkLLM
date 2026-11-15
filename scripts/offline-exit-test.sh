#!/bin/sh
# Exit test of roadmap phase 3: the engine's tests in a container with no network device (see docs/verify-privacy.md).
# usage: scripts/offline-exit-test.sh [engine image, default starkllm-backend:latest]
set -e
IMAGE="${1:-starkllm-backend:latest}"
LIB="$(mktemp -d)"
trap 'rm -rf "$LIB"' EXIT
# pytest is fetched while the network is still there; the test run itself has none
docker run --rm -v "$LIB:/pt" "$IMAGE" pip install -q --target /pt pytest
docker run --rm --network none -e PYTHONPATH=/pt -v "$PWD:/repo" -w /repo/backend "$IMAGE" \
  python -m pytest -q tests --ignore=tests/run_rigorous_e2e.py -p no:cacheprovider
