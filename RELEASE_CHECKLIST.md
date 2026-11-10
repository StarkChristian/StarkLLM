# Release checklist

For each StarkLLM desktop release (`X.Y.Z`). The rules behind it are in [docs/RULES.md](docs/RULES.md).

## Before

- [ ] Every pull request in the release is merged with **Checks** green.
- [ ] Answer changes (class A) since the last release: the scenario numbers in their pull requests show no regression.
- [ ] Risky changes (class R): Windows workflows green; fresh install and update from the last release tested on a
      real Windows PC.
- [ ] `RELEASE_NOTES.md`: what changed for users, in plain words.
- [ ] Version in `desktop/package.json`, `desktop/package-lock.json` and `backend/app/core/config.py`.

## Release

- [ ] The release pull request is approved and merged (R1); the tag points at its merge commit.
- [ ] Assets come from the Windows workflow of that commit: installer, `latest.yml`, blockmap; checksums in the
      README.
- [ ] Engine images for the version are on GHCR (`engine-images` workflow) and can be pulled.
- [ ] Website shows the new version (built from the latest release).

## After

- [ ] In-app update from the previous release on a real Windows PC: update found, downloaded, installed, engine
      updated, documents and chats still there.
- [ ] Fresh install on a PC without StarkLLM: start, add a letter, ask a question, get an answer with a source.
- [ ] *Windows trust* report: which files Smart App Control would block (R6). After the certificate: none.
- [ ] Rules review: go through docs/RULES.md. Did a rule slow work down without preventing anything? Change or
      remove it, and record that.
