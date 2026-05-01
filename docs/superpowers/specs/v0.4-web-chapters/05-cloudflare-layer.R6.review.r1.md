# Review of chapter 05: Cloudflare layer

Reviewer: R6 (Naming / consistency / clarity)
Round: 1

## Findings

### P1-1 (must-fix): Six untagged code fences in one chapter

**Where**:
- §1 line 28 (open) / 36 (close): `cloudflared` spawn args (shell command)
- §3 line 71 (open) / 78 (close): Cloudflare Access policy YAML
- §4 line 99 (open) / 121 (close): JWT interceptor TS code

**Issue**: All three blocks are untagged (`` ``` `` with no language tag). Compare with chapter 02 §4 lines 80, 95 (tagged `yaml`), chapter 04 §3 line 72 (tagged `ts`), chapter 06 lines 36, 69, 96 (tagged `proto`), chapter 08 line 38 (tagged `yaml`). Chapter 05 is the outlier — three of its three multi-line code blocks are untagged.

The §4 JWT interceptor block (line 99-121) is especially load-bearing — it's the canonical example of how the JWT middleware is structured. Without `ts` tag, no syntax highlighting; reviewer must mentally parse imports, type signatures, and the local-bypass branch unaided.

**Why P1**: reduced reviewability of the most-cited code block in the chapter (JWT interceptor); inconsistent with rest of doc; trivial to fix.

**Suggested fix**:
- Line 28: ```` ```sh ```` (or `bash` — pick one and use everywhere; `sh` is shorter).
- Line 71: ```` ```yaml ```` (matches 02 §4 style).
- Line 99: ```` ```ts ```` (matches 04 §3 style — note SKILL.md prefers `ts` not `typescript`).

### P1-2 (must-fix): "team-name" placeholder repeated as `<team-name>` AND `<author's GitHub email>` — inconsistent

**Where**: §3 line 72: `emails: ["<author's GitHub email>"]`. §4 line 103-104: `JWKS_URL = 'https://<team-name>.cloudflareaccess.com/...'; ISSUER = 'https://<team-name>.cloudflareaccess.com';`. §4 line 105: `AUDIENCE = '<application-aud-tag>';`.
**Issue**: three placeholder styles (`<author's GitHub email>` with apostrophe-s English, `<team-name>` hyphenated, `<application-aud-tag>` hyphenated descriptive). The first one with possessive English in a code block is awkward; can't be copy-pasted as-is even as a template.
**Why P1**: §4's TS code block is shown as the implementation template. If a fixer or implementer copies it, "<team-name>" gets templated to `${cfTeamName}`; "<author's GitHub email>" doesn't templatize as cleanly. Also: §4 line 134 says "the user provides these in the setup wizard" — so these are runtime values, not literals. Showing them as literals in TS code is misleading.
**Suggested fix**: rewrite §4 line 103-105 as constants loaded at startup:

```ts
const cfTeamName = settings.cloudflare_team_name;       // from SQLite (chapter 05 §6)
const cfAud = settings.cloudflare_app_aud;
const JWKS_URL = `https://${cfTeamName}.cloudflareaccess.com/cdn-cgi/access/certs`;
const ISSUER  = `https://${cfTeamName}.cloudflareaccess.com`;
const AUDIENCE = cfAud;
```

This matches the prose at §4 line 134 ("Bootstrap... the user provides these in the setup wizard and they're stored in `settings.cloudflare_team_name` + `settings.cloudflare_app_aud` in SQLite").

### P1-3 (must-fix): "cloudflared" / "Cloudflare Tunnel" / "tunnel" / "Tunnel" capitalization drift

**Where** (small sample):
- §1 title: "Cloudflare Tunnel (`cloudflared`)" — Tunnel capitalized as product name. Good.
- §1 line 24: "the tunnel lifecycle" / "tunnel crash" — lowercase, generic.
- §1 line 38: "the public Tunnel hostname" — capital T (now treated as proper noun).
- §1 line 40: "the user creates a Tunnel via the Cloudflare dashboard" — capital.
- §1 line 44: "the spawned `cloudflared` exits with auth error" — lowercase product name in code voice (correct, since `cloudflared` is the binary name).
- §2 line 56: "route `daemon.<their-domain>` to the tunnel via a CNAME" — lowercase tunnel.
- §5 line 145: "`cloudflared` proxies external traffic here" — code voice, correct.
- §6 line 161: "create a Tunnel, paste the token here" — capital T.
- §6 line 174: "Cloudflare's tunnel-create API" — lowercase, generic.

**Issue**: rule appears to be "Tunnel = the Cloudflare product surface; tunnel = the generic instance/connection; `cloudflared` = the binary". This rule is consistent in most uses but the chapter doesn't state it; reader has to infer from context.
**Why P1**: documentation worker writing user-facing docs (`docs/web-remote-setup.md` per 09 M4 deliverable 10) will copy this style. Stating the convention up-front lets the docs worker apply it; not stating it produces drift.
**Suggested fix**: at the top of chapter 05 add a short term key:

> "Terms in this chapter: **Cloudflare Tunnel** (capitalized) refers to the Cloudflare product/service. `cloudflared` (code voice) refers to the binary that runs locally. *tunnel* (lowercase) refers to a single tunnel instance/connection."

Apply consistently — most uses already conform.

### P2-1 (nice-to-have): `cloudflared` spawn args block uses backslash-newline that makes copy-paste OS-specific

**Where**: §1 line 28-36:
```
cloudflared tunnel \
  --no-autoupdate \
  --url http://127.0.0.1:7878 \
  ...
```
**Issue**: backslash-newline is bash/zsh continuation syntax. On Windows cmd or PowerShell, this fails. Since the daemon spawns `cloudflared` programmatically (not via shell), the args list is the actual data — better shown as a JS/TS array literal that matches how the daemon will spawn it.
**Why P2**: not load-bearing; minor portability/clarity nit.
**Suggested fix**: present as a TS array (matches §4's TS style):

```ts
const args = [
  'tunnel',
  '--no-autoupdate',
  '--url', 'http://127.0.0.1:7878',
  '--metrics', '127.0.0.1:0',
  '--loglevel', 'info',
  '--logfile', '~/.ccsm/cloudflared.log',
  '--token', storedTunnelToken,
];
child_process.spawn(cloudflaredPath, args, { detached: false });
```

### P2-2 (nice-to-have): JWKS / IdP / AUD acronyms not defined on first use

**Where**: §3 line 70 mentions "JWKS" (in §4); "IdP" (line 70); "AUD" (line 73 → "application-aud-tag", §4 line 105 → AUDIENCE constant). None defined.
**Issue**: covered in 02 P2-2 cross-chapter acronym audit. Restating here for fixer scope.

## Cross-file findings (if any)

- P1-1 (untagged code fences) bundles with 02 P2-1, 04 P2-1.
- P1-3 (Tunnel capitalization key) is single-chapter but the convention table should be referenced in chapter 04 (which also uses "Tunnel" mixed-case).
- P2-2 acronym audit bundles with 02 P2-2.
