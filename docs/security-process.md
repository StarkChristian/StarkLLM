# Security process (internal)

What happens when a vulnerability in StarkLLM is reported or found, and how the reporting duties of the EU Cyber
Resilience Act (CRA, Regulation (EU) 2024/2847, Article 14) are met. The public side is [SECURITY.md](../SECURITY.md).

> **TODO (owner, legal check):** whether and in which role the CRA applies to StarkLLM (free open-source software;
> manufacturer or open-source software steward; commercial activity), which CSIRT is the coordinator (normally the
> one of the EU member state of the main establishment; for Germany the BSI), and the wording of the reports.
> The deadlines below follow Article 14 CRA as written; until the check is done, treat them as binding.

## Roles

| Role | Who | Does |
|---|---|---|
| Security owner | the owner (Christian Stark) | decides on severity and on reporting, sends every report to the authorities, approves and signs the fix release |
| Engineering | the owner, with Claude Code sessions on the build server | reproduces, writes the fix and its test, prepares the release pull request |
| Deputy | *TODO (owner): name a deputy who can at least send the 24-hour early warning when the owner is away* | |

Only the security owner sends reports to ENISA's platform and publishes advisories. Nobody merges or publishes a fix
without the owner's OK (docs/RULES.md, R1).

## Where reports arrive

- GitHub private vulnerability reporting (repository **Security > Advisories**); GitHub notifies the owner by e-mail.
- E-mail to info@starkllm.com with `SECURITY` in the subject.
- Our own findings (tests, reviews, dependency alerts, the SBOM checked against new advisories).

Check both channels at least every working day. A report is confirmed to the reporter within 3 working days.

## The clock

The clock starts when we **become aware** that a vulnerability is **actively exploited** (there is reliable evidence
that someone used it without permission), or of a **severe incident** that affects the security of StarkLLM. Write
that time down (UTC) in the private advisory as the first line. A vulnerability that is not exploited has no
reporting deadline; it follows the response times of SECURITY.md.

| When (from awareness) | Step | Content |
|---|---|---|
| **within 24 hours** | **Early warning** (vulnerability or incident) | that there is an actively exploited vulnerability / severe incident in StarkLLM; for an incident: whether it is suspected to be caused by unlawful or malicious acts; where known, the EU member states where StarkLLM is used (it is downloaded worldwide: say "all") |
| **within 72 hours** | **Notification** | general information about the product (name, versions affected), the general nature of the exploit and of the vulnerability, the corrective or mitigating measures taken and those users can take, how sensitive the information is |
| **within 14 days after a fix is available** (vulnerability) | **Final report** | description of the vulnerability, its severity and impact; information about the malicious actor if known; details of the security update or other measures |
| **within one month after the 72-hour notification** (incident) | **Final report** | description of the incident, severity and impact, the type of threat or root cause, mitigation applied and ongoing |
| on request | **Intermediate report** | the status, when the CSIRT asks for it |

All of them go through **ENISA's Single Reporting Platform** (SRP), addressed to the CSIRT designated as coordinator.
Keep a copy of every report (PDF or text) in the private advisory.

Also **inform the users** without undue delay: what is affected and what they can do (update, or a workaround until
then). Normally that is the in-app update plus release notes and a GitHub security advisory; when users are at risk
before a fix exists, a notice on the website and in the release notes of the current version.

<!-- The SRP account, its login and the CSIRT contact are kept by the owner, never in this repository. -->

## Step by step

1. **Receive.** Open a private GitHub security advisory for it (also for e-mail reports). Confirm receipt to the
   reporter. Note the time.
2. **Assess** (same day for anything that may be exploited): reproduce it on the latest release; which versions;
   severity (CVSS as a guide); is it **actively exploited**? If yes, the 24-hour clock is running: send the early
   warning first, then continue.
3. **Fix** in a temporary private fork of the advisory (GitHub offers one) or on a branch that is not pushed publicly
   until the release: the fix and the test that would have caught it (docs/CHANGES.md, class **R**).
4. **Release fast.** A patch release `X.Y.Z+1` from the latest release:
   - version in `desktop/package.json`, `desktop/package-lock.json` and `backend/app/core/config.py`;
   - the Windows workflow builds the installer; **sign it on the owner's PC** with
     [`desktop/build/release-sign.js`](../desktop/build/release-sign.js) as in
     [signing-on-owner-pc.md](signing-on-owner-pc.md) (Certum; SimplySign must be logged in, so plan for the owner
     being at the PC);
   - the short form of the [release checklist](../RELEASE_CHECKLIST.md): Checks green, one update from the previous
     release on a real Windows PC, `latest.yml` published, so that the in-app updater offers the fix;
   - engine image on GHCR when the engine changed.
5. **Publish.** Release notes name the fix; publish the GitHub security advisory (request a CVE there); credit the
   reporter. Send the CRA **final report** within 14 days after the fix is available.
6. **Learn.** What would have caught it earlier? Add the test, the check or the rule.

## Where the SBOM is

Every published release has a software bill of materials in CycloneDX JSON, made by the
[SBOM workflow](../.github/workflows/sbom.yml) and attached to the **GitHub release as assets**:
`sbom-desktop.cdx.json` (desktop app), `sbom-frontend.cdx.json` (web UI) and `sbom-engine.cdx.json` (engine, Python).
Use them to answer "are we affected by CVE-…?" for a dependency, and attach the relevant one to a report when asked.
The release checklist checks that they are there.

## Templates

**Early warning (24 h)**, short:

> Product: StarkLLM (desktop app for Windows, open source, https://github.com/StarkChristian/StarkLLM).
> Versions affected: … . We became aware on … (UTC) that a vulnerability in StarkLLM is actively exploited: … (one
> sentence, no exploit details). Member states: StarkLLM is available worldwide. A fix is being prepared / available
> as version … . Contact: info@starkllm.com.

**Notification (72 h)**: the early warning plus the nature of the exploit and of the vulnerability, the measures taken
and what users should do, and how sensitive the information is (e.g. "do not share until the fix is released").
