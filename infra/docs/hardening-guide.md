# Hetzner VPS Hardening Guide

A deep dive into securing a Linux VPS on Hetzner Cloud. Each section explains what the measure does, the attack vector it mitigates, the exact commands to apply it manually, and what can go wrong. The automation in this repo (`playbooks/harden.yml`) implements everything in Tiers 1 and 2 automatically.

**Target OS:** Ubuntu 24.04 LTS
**Threat model:** Internet-facing VPS running web services (Coolify, Docker containers, game servers). Single operator, no shared access.

---

## Table of Contents

- [How to read this guide](#how-to-read-this-guide)
- [Tier 1 — Non-negotiable](#tier-1--non-negotiable)
  - [1.1 Create a non-root user](#11-create-a-non-root-user)
  - [1.2 SSH hardening](#12-ssh-hardening)
  - [1.3 Hetzner Cloud Firewall](#13-hetzner-cloud-firewall)
  - [1.4 UFW — host-level firewall](#14-ufw--host-level-firewall)
  - [1.5 fail2ban](#15-fail2ban)
  - [1.6 Unattended security upgrades](#16-unattended-security-upgrades)
  - [1.7 Disable unused services](#17-disable-unused-services)
- [Tier 2 — Strongly recommended](#tier-2--strongly-recommended)
  - [2.1 Tailscale — zero-trust SSH access](#21-tailscale--zero-trust-ssh-access)
  - [2.2 sysctl network hardening](#22-sysctl-network-hardening)
  - [2.3 sysctl kernel hardening](#23-sysctl-kernel-hardening)
  - [2.4 Docker and UFW — the hidden backdoor](#24-docker-and-ufw--the-hidden-backdoor)
  - [2.5 Strong SSH cryptography](#25-strong-ssh-cryptography)
  - [2.6 Swap and memory tuning](#26-swap-and-memory-tuning)
  - [2.7 Filesystem mount hardening](#27-filesystem-mount-hardening)
  - [2.8 Core dumps disabled](#28-core-dumps-disabled)
  - [2.9 Default umask](#29-default-umask)
  - [2.10 Time synchronization](#210-time-synchronization)
- [Tier 3 — Advanced / optional](#tier-3--advanced--optional)
  - [3.1 Kernel boot parameters](#31-kernel-boot-parameters)
  - [3.2 AppArmor](#32-apparmor)
  - [3.3 AIDE — file integrity monitoring](#33-aide--file-integrity-monitoring)
  - [3.4 Rootkit detection](#34-rootkit-detection)
  - [3.5 Log monitoring](#35-log-monitoring)
  - [3.6 Encrypted DNS](#36-encrypted-dns)
  - [3.7 Outbound firewall restrictions](#37-outbound-firewall-restrictions)
  - [3.8 Lynis security auditing](#38-lynis-security-auditing)
  - [3.9 SUID/SGID binary audit](#39-suidsgid-binary-audit)
  - [3.10 Kernel module loading restriction](#310-kernel-module-loading-restriction)
  - [3.11 Resource limits](#311-resource-limits)
  - [3.12 auditd — system call auditing](#312-auditd--system-call-auditing)
  - [3.13 SSH two-factor authentication](#313-ssh-two-factor-authentication)
  - [3.14 Cloudflare Tunnel](#314-cloudflare-tunnel)
  - [3.15 Backups](#315-backups)
- [Coolify-specific hardening](#coolify-specific-hardening)
- [Ongoing security operations](#ongoing-security-operations)
- [Emergency recovery](#emergency-recovery)
- [Hardening checklist](#hardening-checklist)
- [Sources](#sources)
- [Learning Resources](#learning-resources)

---

## How to read this guide

Each section follows this structure:

- **What it does** — the mechanism and what changes on your system
- **Why it matters** — the specific attack vector or risk it addresses
- **How to apply** — exact commands to run manually
- **What could go wrong** — failure modes, gotchas, and how to recover
- **Automation** — which Ansible role handles this (if applicable)

Commands assume you're logged in as root on a fresh Ubuntu 24.04 server. If you're using the Ansible automation, you don't need to run these manually.

---

## Tier 1 — Non-negotiable

These are the absolute minimum. Every guide agrees on these. Skip any of them and you're leaving a door wide open.

### 1.1 Create a non-root user

**What it does:** Creates a dedicated user (e.g., `deploy`) with sudo privileges and SSH key authentication. Root login is subsequently disabled.

**Why it matters:** The `root` account is the #1 target for automated attacks. Every bot on the internet tries `ssh root@<your-ip>` with common passwords. Even with key-only auth, running as root means any process you launch has unrestricted system access. A bug in your application could `rm -rf /` or read `/etc/shadow`. A non-root user with sudo means you get root when you explicitly ask for it, and your regular processes run with limited privileges.

**The attack vector:** Credential stuffing. Botnets scan IPv4 ranges and try thousands of username/password combinations per minute. Hetzner IPs are in well-known ranges and get targeted within minutes of a server going live.

**How to apply:**

```bash
# Create user with no password (key-only auth)
adduser --disabled-password --gecos "" deploy

# Grant passwordless sudo
echo "deploy ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/deploy
chmod 440 /etc/sudoers.d/deploy

# Set up SSH key
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
```

**What could go wrong:**
- **Locking yourself out:** If you disable root login before verifying the deploy user can SSH in, you're locked out. Always test from a second terminal before closing your root session.
- **Passwordless sudo debate:** Some guides require a password for sudo. For a single-operator server with key-only SSH, passwordless sudo is fine — the SSH key IS your authentication factor. Requiring a password you'd have to store somewhere doesn't add meaningful security.
- **Hetzner rescue mode:** If you do lock yourself out, Hetzner's rescue system lets you mount your disk and fix the SSH config. It's your safety net.

**Automation:** `cloud-init/ubuntu-24.04-hardened.yaml` creates this user on first boot. The SSH key comes from Terraform (`hcloud_ssh_key`).

**Already have things running? Check what's running as root:**

If you're hardening a server that already has services running (e.g., you installed Coolify or Docker before following this guide), it's worth checking which user your processes are running as:

```bash
# See all running processes with their user
ps aux

# Just the Docker-related processes
ps aux | grep -E 'docker|containerd'

# See which user each Docker container's main process runs as
docker ps -q | xargs -I{} docker inspect --format '{{.Name}}: User={{.Config.User}}' {}
```

**How Docker users work:** The standard Docker daemon runs as root; rootless Docker is another deployment model (it needs root to manage namespaces, cgroups, and networking). But the processes *inside* containers can run as any user. When `Config.User` is empty, the container runs as whatever user is specified in the Dockerfile's `USER` directive (or root if none is set).

Running as root *inside* a container is less dangerous than root on the host because Docker uses Linux namespaces — the container's "root" is isolated from the host. But it's still better practice for containers to use a non-root user, because namespace escapes (container breakouts) do happen, and a non-root container user limits the damage.

**What to check if you already have Docker running:**
- `docker ps` — look for containers with `-p 0.0.0.0:PORT:PORT` (publicly exposed, see section 2.4)
- `docker inspect <container> | grep Privileged` — any container with `"Privileged": true` has full host access and effectively bypasses all isolation. This should never be used in production unless absolutely required.
- `docker inspect <container> | grep AppArmor` — should show `docker-default`, not empty (see section 3.2)

Coolify's own containers (dashboard, Traefik, etc.) run as root inside the container, which is expected — they need elevated privileges to manage other containers and bind to ports. Your application containers deployed through Coolify should ideally specify a non-root user in their Dockerfile.

> **Further reading:**
> - [Unix/Linux permissions model](https://wiki.archlinux.org/title/Users_and_groups) — ArchWiki's thorough explanation of users, groups, and how the Unix permission model works under the hood
> - [sudoers manual](https://www.sudo.ws/docs/man/sudoers.man/) — the canonical reference for sudo configuration; dense but authoritative

---

### 1.2 SSH hardening

**What it does:** Reconfigures the SSH daemon to reject password-based logins, disable root login, limit authentication attempts, and disable unnecessary features like X11 forwarding and TCP forwarding.

**Why it matters:** SSH is the only management interface exposed to the internet (at least initially, before Tailscale). Every weakness in its configuration is a potential entry point. The default Ubuntu SSH config is permissive — it allows password auth, root login, and various forwarding features that most servers never need.

**The attack vectors:**
- **Password brute-force:** Even with fail2ban, allowing passwords means an attacker with a large botnet can distribute attempts across thousands of IPs. Key-only auth makes brute-force mathematically infeasible (2^256 keyspace for Ed25519).
- **Root login:** Even with key-only auth, if root login is allowed and your key is compromised, the attacker has immediate god-mode access. With a non-root user, they'd need to also find a privilege escalation vector.
- **TCP forwarding abuse:** An attacker with SSH access can use your server as a proxy (`ssh -D` for SOCKS proxy, `-L` for port forwarding). Disabling this limits what a compromised account can do.
- **X11 forwarding:** Historically riddled with vulnerabilities. On a headless server there's zero reason to have it enabled.

**How to apply:**

Create `/etc/ssh/sshd_config.d/hardening.conf`:

```
# Authentication
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PubkeyAuthentication yes
MaxAuthTries 3
AuthenticationMethods publickey

# Session
ClientAliveInterval 300
ClientAliveCountMax 2
LoginGraceTime 30
MaxSessions 3
MaxStartups 3:50:10

# Features — disable everything unused
X11Forwarding no
AllowTcpForwarding no
AllowAgentForwarding no
PermitTunnel no
GatewayPorts no
PermitUserEnvironment no

# Restrict to specific users (adjust to your username)
AllowUsers deploy
```

> **Coolify users:** If you plan to run Coolify on this server, you need an additional `Match` block in this config to allow Coolify's Docker-internal SSH access. See [SSH hardening and Coolify compatibility](#ssh-hardening-and-coolify-compatibility) before finalizing your SSH config.

Validate and restart:

```bash
sshd -t                    # Validate config syntax
systemctl restart sshd
```

**Critical:** Test SSH from a new terminal before closing your current session. If the config has errors, your existing session stays alive but new ones fail.

**What could go wrong:**
- **Config syntax error:** `sshd -t` catches these. Always validate before restarting. A typo in the config file can prevent SSH from starting at all.
- **AllowUsers typo:** If you misspell the username in `AllowUsers`, nobody can log in. The Ansible role uses a variable to avoid this.
- **ClientAliveInterval too aggressive:** 300 seconds (5 min) is generous. Setting it to 30 seconds will disconnect you every time you pause to think. For tmux/screen users this is less of an issue since the session survives.
- **MaxStartups:** `3:50:10` means: after 3 unauthenticated connections, start randomly dropping 50% of new ones, hard-cap at 10. This rate-limits brute-force attempts at the connection level, before fail2ban even sees them. Too aggressive and you might block yourself if you have multiple terminal tabs connecting simultaneously.

**Automation:** `ansible/roles/ssh_hardening/`

> **Further reading:**
> - [OpenSSH hardening guides by ssh-audit](https://www.sshaudit.com/hardening_guides.html) — algorithm-specific hardening configs generated for your exact OpenSSH version; the gold standard for SSH crypto config
> - [Top 20 OpenSSH Best Practices (nixCraft)](https://www.cyberciti.biz/tips/linux-unix-bsd-openssh-server-best-practices.html) — battle-tested checklist from one of the longest-running Linux sysadmin blogs
> - [DigitalOcean: How to Harden OpenSSH on Ubuntu](https://www.digitalocean.com/community/tutorials/how-to-harden-openssh-on-ubuntu-20-04) — step-by-step tutorial with excellent explanations of each setting
> - [Vultr: Advanced OpenSSH Features](https://docs.vultr.com/how-to-harden-server-ssh-access-using-advanced-openssh-features) — covers certificate-based auth, jump hosts, and Match blocks

---

### 1.3 Hetzner Cloud Firewall

**What it does:** Hetzner's cloud firewall operates at the hypervisor level, outside your VM. Traffic that doesn't match an allow rule is dropped before it ever reaches your server's network interface.

**Why it matters:** This is defense in depth. Even if you misconfigure UFW, or Docker bypasses it (see section 2.4), or a service binds to 0.0.0.0 on an unexpected port, the Hetzner firewall blocks it. The traffic never reaches your VM's kernel, so there's zero CPU cost for filtering.

**How it works internally:** Hetzner implements this in the hypervisor's virtual switch (Open vSwitch / DPDK-based filtering). Your VM sees nothing in `iptables` — the packets are silently dropped upstream. This means:
- You cannot disable it from inside the VM
- It has zero performance overhead on your VM
- It works even if your VM is completely compromised
- It does NOT protect against traffic between VMs in the same Hetzner project

**Recommended rules:**

| Direction | Protocol | Port | Source      | Purpose              |
|-----------|----------|------|-------------|----------------------|
| Inbound   | TCP      | 22   | 0.0.0.0/0  | SSH (or restrict to your IP) |
| Inbound   | TCP      | 80   | 0.0.0.0/0  | HTTP                 |
| Inbound   | TCP      | 443  | 0.0.0.0/0  | HTTPS                |
| Outbound  | TCP      | all  | 0.0.0.0/0  | Allow all outbound   |
| Outbound  | UDP      | all  | 0.0.0.0/0  | Allow all outbound   |
| Outbound  | ICMP     | —    | 0.0.0.0/0  | Ping, traceroute     |

**What to add temporarily for Coolify bootstrap:**

| Direction | Protocol | Port | Source      | Purpose              |
|-----------|----------|------|-------------|----------------------|
| Inbound   | TCP      | 8000 | 0.0.0.0/0  | Coolify dashboard    |
| Inbound   | TCP      | 6001 | 0.0.0.0/0  | Coolify websocket    |
| Inbound   | TCP      | 6002 | 0.0.0.0/0  | Coolify websocket    |

Remove these after Coolify is configured with a domain and HTTPS.

**What could go wrong:**
- **Locking yourself out of SSH:** If you remove port 22 from the Hetzner firewall, you can't SSH in. Unlike UFW, you can't fix this from inside the VM. You'd need to use Hetzner's web console or API to fix the firewall rule.
- **Forgetting outbound rules:** If you create the firewall with only inbound rules and no outbound rules, your server can't reach the internet. No apt updates, no DNS resolution, no Tailscale connection. The default Hetzner firewall denies everything not explicitly allowed, including outbound.
- **IPv6:** If your server has an IPv6 address, you need ::/0 rules too. Forgetting this leaves IPv6 wide open (no firewall) or fully blocked.

**Automation:** `terraform/stacks/hardened-vps/main.tf` creates this firewall.

> **Further reading:**
> - [Hetzner Cloud Firewall docs](https://docs.hetzner.com/cloud/firewalls/overview/) — official documentation; short but covers the behavioral details (default deny, rule evaluation order)
> - [Defense in depth (Wikipedia)](https://en.wikipedia.org/wiki/Defense_in_depth_(computing)) — the security principle behind running both Hetzner firewall + UFW

---

### 1.4 UFW — host-level firewall

**What it does:** UFW (Uncomplicated Firewall) is a user-friendly frontend for `iptables`/`nftables`. It configures the Linux kernel's built-in packet filter to drop traffic that doesn't match explicit allow rules.

**Why it matters:** Even though Hetzner's firewall handles the perimeter, UFW provides a second layer inside the VM. This matters because:
- It protects against lateral movement (if another VM in your Hetzner project is compromised, Hetzner's firewall won't help — it's between your project and the internet, not between your VMs)
- It provides logging of blocked attempts (Hetzner's firewall drops silently)
- It's the firewall that fail2ban integrates with
- It's your safety net if you accidentally remove the Hetzner firewall

**How to apply:**

```bash
# Set defaults
ufw default deny incoming
ufw default allow outgoing

# Allow essential services
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'

# Enable (will prompt for confirmation)
echo "y" | ufw enable

# Verify
ufw status verbose
```

**How UFW works internally:** UFW writes iptables rules to `/etc/ufw/user.rules` and `/etc/ufw/user6.rules`. When enabled, it loads these into the kernel's netfilter framework. The kernel checks every incoming packet against these rules in order (first match wins). Denied packets are either dropped (silently discarded) or rejected (ICMP unreachable sent back).

**What could go wrong:**
- **Enabling UFW without allowing SSH first:** Classic lockout. UFW's default deny will block your SSH connection. Always `ufw allow 22/tcp` before `ufw enable`. The Ansible role handles this ordering correctly.
- **UFW + Docker conflict:** This is serious enough to have its own section (2.4). Docker manipulates iptables directly, bypassing UFW entirely. Container ports exposed with `-p 0.0.0.0:8080:8080` are accessible from the internet regardless of UFW rules.
- **Rule ordering:** UFW processes rules top-to-bottom, first match wins. If you have `deny from 1.2.3.4` after `allow 22/tcp`, the allow rule matches first. Use `ufw insert 1` to prepend rules.
- **IPv6:** UFW handles IPv6 by default (controlled by `IPV6=yes` in `/etc/default/ufw`). If you disable IPv6 in UFW but your server has an IPv6 address, that interface is unfiltered.

**Automation:** `ansible/roles/ufw/`

> **Further reading:**
> - [A Deep Dive into iptables and Netfilter Architecture (DigitalOcean)](https://www.digitalocean.com/community/tutorials/a-deep-dive-into-iptables-and-netfilter-architecture) — the single best explanation of how Linux packet filtering actually works; essential if you want to understand why Docker bypasses UFW
> - [UFW — ArchWiki](https://wiki.archlinux.org/title/Uncomplicated_Firewall) — thorough reference covering UFW internals, IPv6 handling, and advanced rules
> - [UFW vs nftables (Better Stack)](https://betterstack.com/community/guides/linux/ufw-vs-nftables/) — explains the relationship between UFW, iptables, and nftables and when you'd use each
> - [Ubuntu Firewall documentation](https://documentation.ubuntu.com/security/security-features/network/firewall/) — official Ubuntu docs on the firewall subsystem

---

### 1.5 fail2ban

**What it does:** Monitors log files (primarily `/var/log/auth.log`) for patterns indicating brute-force attacks. After a configurable number of failed attempts within a time window, it bans the offending IP by adding a UFW deny rule.

**Why it matters:** Even with key-only SSH, brute-force attempts consume resources (CPU for key exchange, bandwidth, log storage). More importantly, fail2ban reduces noise in your logs, making it easier to spot genuine threats. For any services that might temporarily have password auth (like a database admin panel), fail2ban is the difference between "someone tried 10,000 passwords" and "someone tried 3 and got blocked."

**How it works internally:** fail2ban runs as a daemon that `tail -f`s log files. It applies regex "filters" to each line. When a filter matches (e.g. "Failed password for"), it increments a counter for that source IP. When the counter exceeds `maxretry` within `findtime`, it executes a "ban action" — by default, adding a UFW deny rule. After `bantime` expires, it removes the rule.

The jail system:
- **Filter:** Regex pattern matching log lines (e.g., `sshd` filter matches "Failed password", "Connection closed by authenticating user", etc.)
- **Jail:** Combines a filter with parameters (maxretry, bantime, findtime) and an action (UFW ban, iptables ban, email notification, etc.)
- **Action:** What happens when a ban triggers. `ufw` action adds `ufw insert 1 deny from <ip>`. `iptables-multiport` adds a direct iptables rule.

**How to apply:**

```bash
apt install fail2ban -y
```

Create `/etc/fail2ban/jail.d/sshd.local`:

```ini
[sshd]
enabled = true
port = ssh
logpath = /var/log/auth.log
backend = systemd
maxretry = 3
findtime = 600
bantime = 86400
banaction = ufw
```

```bash
systemctl enable fail2ban
systemctl restart fail2ban

# Verify
fail2ban-client status sshd
```

**Configuration explained:**
- `maxretry = 3` — ban after 3 failed attempts
- `findtime = 600` — within a 10-minute window
- `bantime = 86400` — ban for 24 hours (86400 seconds)
- `banaction = ufw` — use UFW to enforce bans (not raw iptables)
- `backend = systemd` — read from journald instead of log files (more reliable on modern Ubuntu)

**What could go wrong:**
- **Banning yourself:** If you typo your password or key 3 times, your IP gets banned for 24 hours. Fix: SSH from a different IP, or use Hetzner's web console to run `fail2ban-client set sshd unbanip <your-ip>`.
- **fail2ban + UFW timing:** If fail2ban starts before UFW, ban actions fail silently (UFW not ready). The Ansible playbook starts UFW before fail2ban.
- **Log rotation:** If `/var/log/auth.log` gets rotated and fail2ban doesn't notice, it stops detecting attacks. The `systemd` backend avoids this by reading from journald instead of files.
- **Distributed attacks:** fail2ban bans individual IPs. A botnet with 10,000 IPs can do 3 attempts each (30,000 total) before every IP is banned. This is why key-only auth is non-negotiable — fail2ban is a layer, not a solution.
- **Resource usage:** On a heavily attacked server, fail2ban can accumulate thousands of UFW rules. Each rule costs memory and CPU during packet filtering. The 24-hour bantime means rules expire, keeping the list bounded.

**Automation:** `ansible/roles/base/` (fail2ban config is in the base role since it's so fundamental).

> **Further reading:**
> - [How fail2ban Works to Protect Services (DigitalOcean)](https://www.digitalocean.com/community/tutorials/how-fail2ban-works-to-protect-services-on-a-linux-server) — excellent architectural explanation of filters, jails, and actions with diagrams
> - [Hardening SSH: fail2ban, nftables & Cloud Firewalls (DigitalOcean)](https://www.digitalocean.com/community/tutorials/hardening-ssh-fail2ban) — shows how fail2ban fits into a layered defense alongside firewalls
> - [fail2ban — ArchWiki](https://wiki.archlinux.org/title/Fail2ban) — practical reference with advanced jail configurations for services beyond SSH
> - [Red Hat: Protect your systems with fail2ban](https://www.redhat.com/en/blog/protect-systems-fail2ban) — enterprise perspective on fail2ban deployment

---

### 1.6 Unattended security upgrades

**What it does:** Automatically downloads and installs security patches daily. Optionally reboots the server when kernel updates require it.

**Why it matters:** The majority of server compromises exploit known, patched vulnerabilities. The time between a CVE publication and active exploitation is often hours, not days. If you rely on manually running `apt upgrade`, there's always a window where your server is running known-vulnerable software.

**The timeline of a typical vulnerability:**
1. Researcher discovers vulnerability
2. CVE published, patch available in Ubuntu repos (often same day)
3. Exploit code appears in the wild (hours to days)
4. Botnets incorporate the exploit (days to weeks)
5. Your server gets scanned and exploited (continuous)

Unattended upgrades closes the gap at step 2 automatically.

**How to apply:**

```bash
apt install unattended-upgrades apt-listchanges -y
```

Create `/etc/apt/apt.conf.d/20auto-upgrades`:

```
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
```

Edit `/etc/apt/apt.conf.d/50unattended-upgrades`:

```
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}";
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};

Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-New-Unused-Dependencies "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
```

Keep automatic reboot disabled until a maintenance window and recovery procedure
are agreed. A clock time alone does not coordinate two VPSs or verify that their
applications, tailnet access and firewall recover. This matches the Ansible
default. Refresh signed APT metadata before reviewing an update: a cached package
list can miss a newly published security revision. Keep native phased deferrals.

An expired package-mirror TLS certificate is a coverage failure even when old
indexes remain usable. Check the actual failing hostname, certificate dates,
synchronized host clock and `_apt` access to the CA bundle. Successful service
exit alone does not mean every advisory check completed; inspect its skipped
checks and authenticated-refresh receipt. Keep the external incomplete-coverage
alert active until a normal watcher run succeeds.

For Ubuntu 24.04 on amd64/i386, Canonical's HTTPS archive and security endpoints
are `https://archive.ubuntu.com/ubuntu/` and
`https://security.ubuntu.com/ubuntu/`. Other supported architectures use
`https://ports.ubuntu.com/ubuntu-ports/`. The bootstrap templates select these
explicitly through cloud-init's primary/security mirror configuration. Preserve
the original suites, components and Ubuntu archive signing key. Validate fresh
signed indexes with isolated source/list/cache paths before replacing only the
reviewed endpoint strings. Never work around expiry by disabling TLS, signature
or valid-until checks. Retain the old source bytes and review the exact AIDE
file/parent changes separately.
[Cloud-init APT configuration](https://docs.cloud-init.io/en/latest/reference/yaml_examples/apt.html).

For a reviewed manual batch, pin the exact versions and refuse additions or
removals unless separately reviewed. Retain authenticated package artifacts and
original configuration on the original host. Require fresh verified backups,
package consistency and no active deployment. Check application containers,
images/data, runtime firewall and tailnet afterward. After AppArmor updates,
verify both running kernel confinement and a new disposable confined container.

Installing a library does not replace copies mapped by long-running processes.
Review `needrestart` output; reload a tested service set and preserve existing SSH
sessions. Respect vendor-deferred DBus, login, network and shutdown-helper
services. Keep required reboots visible until a coordinated restart and post-boot
checks finish. Never automatically accept an AIDE candidate after APT. Match
changed files/symlinks to signed package artifacts; separately explain generated
initramfs, preserved-content metadata and exact maintainer migrations.

After boot, compare container images, data mounts, deployment controls, network
memberships and kernel confinement with the private preflight snapshot. Docker
may serialize unset DNS fields from `null` to empty arrays on reload; canonicalize
only that representation while rejecting configured DNS or other control changes.
Check actual routed app endpoints with valid TLS and respect router path prefixes.
Some apps expose only RPC/WebSocket prefixes and keep `/health` internal; use a
read-only public RPC health/version query for their routed check. Verify both
public IPv4/IPv6 origin denial from the other host, with working connectivity
controls, and verify audit/monitors before restarting that host. A GRUB environment
timestamp change needs explicit review against the prior trusted content hashes;
it does not justify automatic baseline acceptance.

Verify:

```bash
unattended-upgrades --dry-run --debug
```

**What could go wrong:**
- **Breaking changes in security updates:** Rare but possible. A security patch to OpenSSL could break TLS in your application. The risk is real but small — Ubuntu security updates are conservative and well-tested.
- **Reboot interrupts active work:** Use a coordinated maintenance window, one host at a time. Verify recovery before starting the second host. The example keeps automatic reboot disabled.
- **Disk space:** Old kernels accumulate and fill `/boot`. The `Remove-Unused-Kernel-Packages` and `Remove-Unused-Dependencies` settings in the config above prevent this by automatically cleaning up old kernels and orphaned packages during unattended upgrades. Without these settings, a full `/boot` partition blocks all future updates — a surprisingly common failure mode.
- **apt lock contention:** If you're running `apt` manually while unattended-upgrades is running, you'll get lock errors. Not dangerous, just annoying. Wait and retry.

**Automation:** `ansible/roles/base/` (templates for both config files).

> **Further reading:**
> - [Ubuntu Server: Automatic Updates](https://documentation.ubuntu.com/server/how-to/software/automatic-updates/) — official Ubuntu docs, covers all the config options
> - [nixCraft: Set up automatic unattended updates](https://www.cyberciti.biz/faq/set-up-automatic-unattended-updates-for-ubuntu-20-04/) — practical walkthrough with troubleshooting tips
> - [CVE database (NIST)](https://nvd.nist.gov/) — the National Vulnerability Database; where vulnerability timelines come from

---

### 1.7 Disable unused services

**What it does:** Stops and disables services that ship with Ubuntu but aren't needed on a headless server.

**Why it matters:** Every running service is attack surface. A service you don't use is attack surface you get nothing from. The principle of least functionality — only run what you need.

**Services to consider disabling:**

| Service | What it does | Why disable |
|---------|-------------|-------------|
| `snapd` | Snap package manager | Adds attack surface, auto-updates independently, uses loop devices |
| `multipathd` | SAN/multipath storage | Not relevant for cloud VPS |
| `ModemManager` | Cellular modem management | No modems on a VPS |
| `bluetooth` | Bluetooth stack | No Bluetooth on a VPS |
| `cups` | Print server | No printers on a VPS |
| `avahi-daemon` | mDNS/Bonjour | Service discovery, not needed on a public server |

**How to apply:**

```bash
# Check what's running
systemctl list-units --type=service --state=running

# Disable unnecessary services (2>/dev/null suppresses errors for
# services that aren't installed — not every Ubuntu image ships all of these)
systemctl disable --now snapd snapd.socket snapd.seeded 2>/dev/null
systemctl disable --now multipathd 2>/dev/null
systemctl disable --now ModemManager 2>/dev/null
systemctl disable --now bluetooth 2>/dev/null
systemctl disable --now cups cups-browsed 2>/dev/null
systemctl disable --now avahi-daemon avahi-daemon.socket 2>/dev/null
```

**Note:** The `2>/dev/null` on each line suppresses "unit not found" errors. If a service from the table above isn't installed on your system, the command silently does nothing — this is safe and expected. Minimal cloud images (like Hetzner's Ubuntu 24.04) typically don't ship with `bluetooth`, `cups`, or `ModemManager`, but it costs nothing to ensure they're disabled.

**What could go wrong:**
- **Disabling something Coolify needs:** Coolify uses Docker, which uses containerd, which uses snapd on some Ubuntu installations. If Coolify was installed via snap (it's not — it uses Docker), disabling snapd would break it. The safe approach: only disable services you've verified are unnecessary.
- **Ubuntu Pro / ESM:** `snapd` is also used by Ubuntu Pro for some features. If you have a Pro subscription, check before disabling.

**Automation:** `ansible/roles/base/` (configurable list of services to disable).

---

## Tier 2 — Strongly recommended

These significantly improve your security posture. The Ansible automation applies all of these by default.

### 2.1 Tailscale — zero-trust SSH access

**What it does:** Tailscale creates a WireGuard-based mesh VPN (a "tailnet") between your devices. Once your VPS and your laptop are both on the tailnet, you can SSH via Tailscale's private network — and close port 22 to the public internet entirely.

**Why it matters:** This is the single most impactful change after basic SSH hardening. With port 22 closed publicly:
- Zero brute-force attempts reach your server (nothing to attack)
- Zero fail2ban bans needed (nothing triggers them)
- Zero SSH vulnerabilities exploitable from the internet (no listener)
- Your server becomes invisible to port scanners

**How it works internally:** Tailscale assigns each device a 100.x.y.z address from the CGNAT range (100.64.0.0/10). Traffic between devices is encrypted end-to-end with WireGuard (ChaCha20-Poly1305). The coordination server (Tailscale's infrastructure) handles key exchange and NAT traversal, but never sees your traffic. Direct connections use UDP hole-punching; when that fails, traffic relays through Tailscale's DERP servers (still encrypted).

**The CGNAT range (100.64.0.0/10):** This is a reserved range that ISPs use for carrier-grade NAT. Tailscale reuses it because these addresses never appear on the public internet, avoiding conflicts with your LAN. When you restrict SSH to this range in UFW, you're saying "only Tailscale peers can connect."

**How to apply:**

```bash
# Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh

# Join your tailnet (opens browser for auth)
tailscale up --ssh --hostname=$(hostname)

# Verify
tailscale status

# Restrict SSH to Tailscale only (after verifying Tailscale SSH works!)
ufw delete allow 22/tcp
ufw allow in on tailscale0 to any port 22 proto tcp comment 'SSH via Tailscale'
```

**Tailscale SSH mode:** The `--ssh` flag enables Tailscale's built-in SSH server. This means you can use `tailscale ssh deploy@<hostname>` without configuring SSH keys at all — Tailscale handles authentication via your identity provider. Your regular OpenSSH server still works over the tailnet for compatibility.

**What could go wrong:**
- **Locking yourself out by closing port 22 too early:** If Tailscale isn't working and you've already closed public SSH, you're locked out. ALWAYS verify Tailscale SSH works from another device before closing port 22. The Ansible role verifies Tailscale connectivity before modifying UFW.
- **Tailscale outage:** If Tailscale's coordination servers go down, existing connections survive but new ones can't be established. Emergency access: use Hetzner's web console (VNC) to repair Tailscale. Keep public SSH closed.
- **Auth key expiry:** Tailscale auth keys can expire. Use a reusable, pre-authorized key and be aware it's valid for 90 days by default. Generate a new one in the Tailscale admin console.
- **Tailscale + Docker:** Tailscale runs in userspace by default. If you also use it as a Docker network (exit node, subnet router), configuration gets complex. For basic SSH access, the default setup is fine.

**Automation:** `ansible/roles/tailscale/`

**Exit node (optional):** Set `tailscale_advertise_exit_node: true` in the inventory and run `make tailscale INVENTORY=<path>` to offer the server as an exit node. It persists IPv4 and IPv6 forwarding in `/etc/sysctl.d/99-tailscale.conf` and runs `tailscale set --advertise-exit-node`. Use it when a laptop sits on a network whose URL filter blocks one of your own hosts. An admin still has to approve the node in the Tailscale console, and each device opts in from its Tailscale menu. UFW needs no change: Tailscale's `ts-forward` chain runs before UFW's routed-deny rules. Check that `ip -6 route show default` says `proto static` first, because IPv6 forwarding makes Linux ignore router advertisements. Hetzner Cloud routes IPv6 statically.

> **Further reading:**
> - [How Tailscale Works](https://tailscale.com/blog/how-tailscale-works) — the official deep dive; beautifully written, covers NAT traversal, DERP relays, the coordination server, and why the control plane never sees your traffic. One of the best technical blog posts on the internet.
> - [About WireGuard (Tailscale Docs)](https://tailscale.com/kb/1035/wireguard) — explains the WireGuard foundation: Noise protocol framework, ChaCha20-Poly1305, and why it's "the most secure VPN protocol"
> - [WireGuard whitepaper](https://www.wireguard.com/papers/wireguard.pdf) — the original academic paper; readable at ~16 pages and explains the cryptographic design choices
> - [Understanding Mesh VPNs (Tailscale)](https://tailscale.com/learn/understanding-mesh-vpns) — conceptual overview of mesh vs. hub-and-spoke VPN architectures

---

### 2.2 sysctl network hardening

**What it does:** Configures kernel parameters via sysctl to harden the network stack against various attacks.

**Why it matters:** The Linux network stack has sensible defaults for general use, but a public-facing server needs stricter settings. These parameters disable features that are either dangerous (ICMP redirects), unnecessary (source routing), or leak information (TCP timestamps).

**The parameters and their attack vectors:**

```ini
# --- IP Spoofing Protection ---
# Reverse path filtering: kernel verifies that the source address of incoming
# packets could actually be reached via the interface they arrived on. Drops
# packets with forged source addresses.
# Attack: IP spoofing for DDoS amplification, bypassing IP-based ACLs
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1

# --- ICMP Redirect Protection ---
# ICMP redirects tell your server to change its routing table. A legitimate
# use is when a router tells you about a better route. On a server with one
# NIC and one gateway, there's never a legitimate redirect.
# Attack: MITM by redirecting traffic through attacker's machine
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0

# --- Source Routing ---
# Source routing lets the sender specify the path packets take. This is a
# debugging feature from the 1980s that has no business being enabled on a
# production server.
# Attack: bypass firewalls and IDS by specifying a route around them
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv6.conf.default.accept_source_route = 0

# --- Broadcast Protection ---
# Smurf attack: attacker sends ICMP echo to your broadcast address with a
# spoofed source. Every host on your network replies to the spoofed source,
# amplifying the attack.
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1

# --- TCP Hardening ---
# RFC1337: prevents TIME-WAIT assassination. Without this, an attacker can
# RST a TIME-WAIT connection and potentially hijack the next connection that
# reuses those port numbers.
net.ipv4.tcp_rfc1337 = 1

# TCP timestamps leak your server's uptime (precision to milliseconds).
# An attacker can use this to fingerprint your OS, estimate when you last
# rebooted (and thus when you last applied kernel patches), and in some cases
# infer sequence numbers for TCP hijacking.
# Trade-off: disabling timestamps slightly reduces TCP performance for
# high-latency connections (PAWS protection is lost). For a game server or
# web app, this is negligible.
net.ipv4.tcp_timestamps = 0

# --- IPv6 ---
# If you don't use IPv6, disable it entirely. An unconfigured IPv6 stack is
# attack surface for free.
# Note: Hetzner assigns IPv6 by default. If you use it, keep these at 0.
# net.ipv6.conf.all.disable_ipv6 = 1
# net.ipv6.conf.default.disable_ipv6 = 1
```

**How to apply:**

Write these to `/etc/sysctl.d/99-hardening.conf` and run:

```bash
sysctl -p /etc/sysctl.d/99-hardening.conf
```

**What could go wrong:**
- **TCP timestamps and load balancers:** Some load balancers rely on TCP timestamps for PAWS (Protection Against Wrapped Sequences). On a single VPS with no external load balancer, disabling timestamps is safe.
- **Disabling IPv6 breaks things:** Docker sometimes relies on IPv6 for container networking. Hetzner DNS resolution can use IPv6. If you disable IPv6, test thoroughly. The safe default is to leave IPv6 enabled but harden it (disable redirects, source routing).
- **rp_filter and asymmetric routing:** If your server has multiple network interfaces with different routes, strict rp_filter (value 1) can drop legitimate packets. A bare single-NIC Hetzner VPS is fine — but **once you install Tailscale**, the kernel sees `tailscale0` as a second logical interface, and strict mode can drop tailnet ICMP/TCP because the reverse path resolves through `eth0`. Tailscale 1.40+ auto-corrects to `rp_filter=2` at startup, but a kernel-update auto-reboot from `unattended-upgrades` reapplies `99-hardening.conf` before tailscaled is up, briefly reverting the value. If you run Tailscale on this host, drop a higher-numbered file like `/etc/sysctl.d/99-tailscale-rp-filter.conf` containing `net.ipv4.conf.all.rp_filter = 2` so it always wins on boot.

**Automation:** `ansible/roles/base/` (`templates/99-hardening.conf.j2`).

> **Further reading:**
> - [Linux Kernel sysctl Security Hardening (nixCraft)](https://www.cyberciti.biz/faq/linux-kernel-etcsysctl-conf-security-hardening/) — comprehensive sysctl reference with per-parameter explanations
> - [Linux hardening with sysctl (Linux Audit)](https://linux-audit.com/system-hardening/linux-hardening-with-sysctl/) — focuses on the "why" behind each parameter
> - [RFC 1337: TIME-WAIT Assassination Hazards](https://www.rfc-editor.org/rfc/rfc1337) — the actual RFC that explains the TCP TIME-WAIT attack; short and readable
> - [IP Spoofing (Cloudflare)](https://www.cloudflare.com/learning/ddos/glossary/ip-spoofing/) — clear explanation of spoofing and why rp_filter matters

---

### 2.3 sysctl kernel hardening

**What it does:** Restricts access to kernel information and debugging interfaces that unprivileged processes shouldn't need.

**Why it matters:** If an attacker gains code execution as a non-root user (e.g., through a vulnerability in your web app), these settings limit what they can learn about the system and what escalation techniques they can use.

**How to apply:**

Add these to the same `/etc/sysctl.d/99-hardening.conf` file from section 2.2, then apply with `sysctl -p /etc/sysctl.d/99-hardening.conf`.

```ini
# --- Kernel Information Disclosure ---
# Restrict dmesg to root. dmesg contains hardware info, driver messages,
# and sometimes memory addresses that help with kernel exploits.
kernel.dmesg_restrict = 1

# Hide kernel symbol addresses. These addresses are essential for writing
# kernel exploits (they need to know where to jump). kptr_restrict=2 hides
# them from everyone including root (unless you read /proc/kallsyms as root).
kernel.kptr_restrict = 2

# --- Process Isolation ---
# Restrict ptrace to parent processes only. ptrace lets one process inspect
# another's memory. An attacker could use it to read secrets from other
# processes (database passwords, API keys in environment variables).
# 0 = no restriction, 1 = parent only, 2 = admin only, 3 = disabled entirely
kernel.yama.ptrace_scope = 1

# --- BPF Hardening ---
# Disable unprivileged BPF. BPF (Berkeley Packet Filter) is powerful and
# has been a source of many kernel vulnerabilities. If your apps don't need
# BPF (most don't), restrict it to root.
kernel.unprivileged_bpf_disabled = 1
net.core.bpf_jit_harden = 2

# --- Misc ---
# Disable kexec (loading a new kernel at runtime). An attacker with root
# could use this to load a backdoored kernel.
kernel.kexec_load_disabled = 1

# Disable SysRq key combinations. On a cloud VPS you access via SSH, the
# magic SysRq key is useless. But if an attacker has console access, SysRq
# can bypass security measures.
kernel.sysrq = 0

# Restrict perf events. perf is a profiling tool that has had multiple
# vulnerabilities. Unless you're actively profiling, restrict it.
kernel.perf_event_paranoid = 3

# Disable io_uring for unprivileged users. io_uring is a high-performance
# async I/O interface that has been a prolific source of kernel CVEs since
# its introduction in 2019.
kernel.io_uring_disabled = 2

# --- ASLR Enhancement ---
# Increase Address Space Layout Randomization entropy. ASLR randomizes
# where code and data are placed in memory, making exploits harder.
# Default is 28 bits; 32 bits provides 16x more entropy.
vm.mmap_rnd_bits = 32
vm.mmap_rnd_compat_bits = 16
```

**What could go wrong:**
- **io_uring and modern apps:** Some high-performance applications (like recent versions of liburing-based tools) use io_uring. Disabling it breaks them. Docker containers aren't affected unless they specifically use io_uring system calls.
- **perf_event_paranoid = 3:** This breaks `perf` for debugging. If you need to profile your application, temporarily set it to 2 (`sysctl -w kernel.perf_event_paranoid=2`), profile, then set it back.
- **ptrace_scope = 1:** Breaks `strace` on arbitrary processes. You can still strace your own children or use `sudo strace`. GDB also needs adjustment.

**Automation:** `ansible/roles/base/` (same sysctl template).

> **Further reading:**
> - [Linux Hardening Guide (Madaidan's Insecurities)](https://madaidans-insecurities.github.io/guides/linux-hardening.html) — the most thorough, opinionated kernel hardening reference on the internet; covers every sysctl parameter, boot parameter, and sandboxing technique with precise reasoning. Required reading.
> - [ASLR — Ubuntu Security Documentation](https://documentation.ubuntu.com/security/security-features/process-memory/aslr/) — explains how Ubuntu implements ASLR and what `mmap_rnd_bits` controls
> - [Kernel Self Protection Project](https://kernsec.org/wiki/index.php/Kernel_Self_Protection_Project) — Linux kernel initiative to reduce kernel attack surface; documents the rationale behind many of these parameters
> - [io_uring vulnerability tracker](https://security.googleblog.com/2023/06/learnings-from-kctf-vrps-42-linux.html) — Google's analysis of io_uring as a vulnerability goldmine (which is why we disable it)

---

### 2.4 Docker and UFW — the hidden backdoor

**What it does:** Documents and mitigates Docker's habit of bypassing UFW by directly manipulating iptables.

**Why it matters:** This is the #1 surprise in Linux server security. You carefully configure UFW to only allow ports 22, 80, and 443. You verify with `ufw status`. Everything looks locked down. Then you run `docker run -p 8080:80 nginx` and port 8080 is accessible from the entire internet. UFW never sees this traffic because Docker inserts its rules into the `DOCKER` iptables chain, which is evaluated before UFW's chains.

**How Docker's networking works internally:**
1. Docker creates a virtual bridge (`docker0` or a custom network)
2. Each container gets a virtual ethernet pair (veth) connected to the bridge
3. When you publish a port (`-p 8080:80`), Docker adds NAT rules to iptables:
   - `PREROUTING -p tcp --dport 8080 -j DNAT --to-destination 172.17.0.2:80`
   - `FORWARD -d 172.17.0.2 -p tcp --dport 80 -j ACCEPT`
4. These rules are in the `DOCKER` chain, which is evaluated in the `FORWARD` and `PREROUTING` chains — before UFW's `ufw-before-forward` chain

**The result:** Your UFW rules are completely irrelevant for Docker-published ports. `ufw deny 8080` does nothing because the packet is DNATed and forwarded before UFW's input chain processes it.

**Mitigation strategies (pick one):**

> **For Coolify users:** Option A is what you want. Coolify already uses Traefik as a reverse proxy and handles port binding correctly for application containers. The main risk is Coolify's own dashboard port (8000) during bootstrap — see the [Coolify-specific hardening](#coolify-specific-hardening) section.

**Option A — Bind to localhost only (recommended):**

```bash
# Instead of:
docker run -p 8080:80 nginx          # Accessible from internet!

# Do:
docker run -p 127.0.0.1:8080:80 nginx  # Only accessible locally
```

Then use a reverse proxy (Caddy, Traefik, Nginx) on the host to route traffic. Coolify does this automatically with Traefik.

**Option B — `ufw-docker` (canonical UFW + Docker integration):**

[chaifeng/ufw-docker](https://github.com/chaifeng/ufw-docker) is the community-standard tool for making UFW and Docker actually cooperate, and it's the integration that [Coolify themselves recommend](https://coolify.io/docs/knowledge-base/server/firewall) for users who want a host-level firewall layer alongside Docker. It modifies `/etc/ufw/after.rules` to add a `DOCKER-USER` block that defaults to deny-forward-from-external, then exposes a `ufw route allow ...` syntax for opening specific ports. UFW's own boot mechanism handles persistence — no `iptables-persistent` package, no separate systemd unit.

> ⚠️ **Do not `apt install iptables-persistent` as a way to persist DOCKER-USER rules.** On Ubuntu, that package conflicts with `ufw` at the apt-resolver level — installing one silently removes the other. You can confirm this on any host with `apt install --simulate ufw` (the resolver will plan a `Remv iptables-persistent` if both are present). The fallout is a host that thinks it has a firewall but doesn't. The Ansible `base` role refuses to run when `iptables-persistent` is installed, exactly to prevent the next `make harden` from silently triggering this drift. See "Recovery from a silent UFW removal" below if you've already hit it.

Install ufw-docker (pin the upstream tag; bump it deliberately):

```bash
UFW_DOCKER_VERSION=251123
sudo curl -fsSL "https://github.com/chaifeng/ufw-docker/raw/${UFW_DOCKER_VERSION}/ufw-docker" \
  -o /usr/local/bin/ufw-docker
sudo chmod +x /usr/local/bin/ufw-docker

# Modifies /etc/ufw/after.rules — backs up the original automatically
sudo ufw-docker install
sudo ufw reload

# Allow forwarded traffic to specific Docker-published ports.
# Note: this is `ufw route allow`, not `ufw allow` — ufw-docker rules
# operate on the FORWARD chain, not INPUT.
sudo ufw route allow proto tcp from any to any port 80
sudo ufw route allow proto tcp from any to any port 443
```

After this, anything Docker publishes that you haven't `ufw route allow`d (Coolify dashboard 8000, Traefik dashboard 8080, GlitchTip 8001, etc.) is unreachable from outside, even though Docker still binds them on `0.0.0.0`.

Verify:

```bash
sudo ufw status verbose                   # should show route allow rules
sudo grep -A 1 'BEGIN UFW AND DOCKER' /etc/ufw/after.rules | head -5
```

**Option C — Disable Docker iptables (risky):**

In `/etc/docker/daemon.json`:

```json
{ "iptables": false }
```

This breaks Docker's internal networking. Container-to-container communication stops working unless you manually configure routes. Not recommended unless you deeply understand iptables.

**What could go wrong:**
- **Coolify and Docker ports:** Coolify manages containers and publishes ports automatically. It uses Traefik as a reverse proxy, so application containers should only be exposed through Traefik (ports 80/443). But Coolify's own dashboard runs on port 8000, which Docker publishes. This is why we need the bootstrap → lockdown flow.
- **Docker Compose and port binding:** If your compose file says `ports: "8080:80"`, that's `0.0.0.0:8080`. You need `ports: "127.0.0.1:8080:80"`. Easy to forget, especially with third-party compose files.
- **`ufw allow` vs `ufw route allow`:** Easy mistake — `ufw allow 80/tcp` only opens the INPUT chain, which Docker traffic skips. To open a Docker-published port through ufw-docker you need `ufw route allow`, which operates on the FORWARD chain.

**Automation:** The `ansible/roles/ufw/` role implements Option B (ufw-docker) when `ufw_docker_mitigation: true`. Coolify's own recommendation is to also rely on your provider firewall (the Hetzner Cloud Firewall, which the `terraform/stacks/hardened-vps` stack already provisions) as the primary external layer.

> **Further reading:**
> - [Docker and UFW security flaw (GitHub issue #690)](https://github.com/docker/for-linux/issues/690) — the canonical issue thread; hundreds of comments documenting the problem since 2019
> - [ufw-docker (GitHub)](https://github.com/chaifeng/ufw-docker) — a tool that patches UFW to work correctly with Docker; explains the iptables chain ordering in detail
> - [Docker networking internals](https://docs.docker.com/engine/network/) — official Docker docs explaining bridge networks, port publishing, and iptables rules

---

### 2.5 Strong SSH cryptography

**What it does:** Restricts SSH to use only modern, high-security cryptographic algorithms, removing legacy ciphers that may have weaknesses.

**Why it matters:** The default SSH configuration supports algorithms dating back to the 2000s for backwards compatibility. Some of these have known weaknesses (e.g., SHA-1 based MACs, CBC-mode ciphers vulnerable to padding oracle attacks). By restricting to modern algorithms, you eliminate these attack vectors.

**Configuration** (add to `/etc/ssh/sshd_config.d/hardening.conf`):

```
# Key exchange: only post-quantum and modern elliptic curve
KexAlgorithms sntrup761x25519-sha512@openssh.com,curve25519-sha256,curve25519-sha256@libssh.org

# Ciphers: only AEAD ciphers (authenticated encryption)
Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com

# MACs: only ETM (encrypt-then-MAC) variants with SHA-2
MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com

# Host keys: prefer Ed25519
HostKeyAlgorithms ssh-ed25519,ssh-ed25519-cert-v01@openssh.com
```

**The algorithms explained:**
- **sntrup761x25519:** Hybrid post-quantum + classical key exchange. Protects against future quantum computers that could break X25519 alone. Available in OpenSSH 9.0+.
- **chacha20-poly1305:** ChaCha20 stream cipher + Poly1305 MAC. Designed by Daniel Bernstein. Faster than AES on CPUs without hardware AES (ARM, older x86). Constant-time implementation, no timing side channels.
- **aes256-gcm:** AES in Galois/Counter Mode. Hardware-accelerated on modern x86 CPUs (AES-NI instruction set). AEAD cipher — authentication is built in.
- **hmac-sha2-512-etm:** Encrypt-then-MAC with SHA-512. ETM is cryptographically stronger than MAC-then-encrypt (which is vulnerable to padding oracle attacks).
- **Ed25519:** Elliptic curve signature scheme. 128-bit security level with compact 32-byte keys. Faster and more secure than RSA-2048.

**What could go wrong:**
- **Old SSH clients can't connect:** If you SSH from a machine with OpenSSH < 7.3 (released 2016), it might not support these algorithms. macOS and recent Linux have been compatible for years. Windows OpenSSH (built-in since Windows 10 1803) supports them. Putty 0.75+ supports them.
- **sntrup761 unavailability:** Some older OpenSSH versions (< 9.0) don't have sntrup761. The config lists it first but falls back to curve25519. `ssh -Q kex` on your client shows supported algorithms.

**Automation:** `ansible/roles/ssh_hardening/` (part of the sshd template).

> **Further reading:**
> - [OpenSSH: Post-Quantum Cryptography](https://www.openssh.org/pq.html) — official OpenSSH page on their post-quantum key exchange (sntrup761, ML-KEM); explains the hybrid approach and why it matters
> - [Post-Quantum SSH at GitHub](https://github.blog/engineering/platform-security/post-quantum-security-for-ssh-access-on-github/) — GitHub's writeup on deploying post-quantum SSH at scale
> - [Comparing SSH Keys: RSA vs ECDSA vs Ed25519](https://blog.vitalvas.com/post/2025/03/01/comparing-ssh-keys-rsa-ecdsa-ed25519/) — side-by-side comparison of key types with security levels and performance
> - [How to secure SSH with Ed25519 (Cryptsus)](https://cryptsus.com/blog/how-to-secure-your-ssh-server-with-public-key-elliptic-curve-ed25519-crypto.html) — deep dive into Ed25519: the math, the security properties, and practical setup
> - [Daniel J. Bernstein's Curve25519 paper](https://cr.yp.to/ecdh/curve25519-20060209.pdf) — the original paper introducing the curve that powers modern SSH, WireGuard, and TLS 1.3; academic but surprisingly approachable

---

### 2.6 Swap and memory tuning

**What it does:** Creates a swap file and tunes the kernel's memory management for server workloads.

**Why it matters:** A server without swap can be killed by the OOM (Out of Memory) killer when memory pressure spikes. The OOM killer picks the "most expendable" process to kill, which might be your database or application server. With swap, the system has a buffer — it slows down instead of killing processes.

**How to apply:**

```bash
# Create 2GB swap file
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Tune swappiness
echo 'vm.swappiness = 10' >> /etc/sysctl.d/99-hardening.conf
sysctl -p /etc/sysctl.d/99-hardening.conf
```

**Swappiness explained:** The `vm.swappiness` parameter (0-200, default 60) controls how aggressively the kernel moves memory pages to swap. A value of 10 means "only swap when absolutely necessary." For a server with limited RAM running Docker containers, this is ideal — you want swap as a safety net, not as routine overflow.

**TCP BBR congestion control** (add to `/etc/sysctl.d/99-hardening.conf`):

```ini
net.core.somaxconn = 1024
net.ipv4.tcp_congestion_control = bbr
```

BBR (Bottleneck Bandwidth and Round-trip propagation time) is Google's TCP congestion control algorithm. It significantly improves throughput and reduces latency compared to the default CUBIC, especially on lossy or high-latency connections. For a game server serving players worldwide, this is a measurable improvement.

**What could go wrong:**
- **SSD wear from excessive swapping:** If swappiness is too high on an SSD (like Hetzner's NVMe drives), constant swapping wears the drive. swappiness 10 avoids this.
- **BBR and fairness:** BBR can be unfair to competing CUBIC flows on the same link. On a dedicated VPS, this isn't an issue since you own the link.

**Automation:** `ansible/roles/base/`

> **Further reading:**
> - [BBR congestion control (Google Research)](https://research.google/pubs/bbr-congestion-based-congestion-control/) — the original Google Research paper on BBR; explains why it outperforms CUBIC
> - [Linux OOM Killer — how it works](https://www.kernel.org/doc/gorman/html/understand/understand016.html) — Mel Gorman's chapter on the OOM killer from "Understanding the Linux Virtual Memory Manager"; the definitive reference

---

### 2.7 Filesystem mount hardening

**What it does:** Adds restrictive mount options to `/tmp`, `/var/tmp`, and `/dev/shm` that prevent executing binaries, using SUID programs, or creating device files in these directories.

**Why it matters:** These world-writable directories are the #1 staging ground for attackers. The typical post-exploitation playbook is:
1. Exploit a web app vulnerability to upload a binary
2. Write it to `/tmp` (always writable, always available)
3. `chmod +x /tmp/payload && /tmp/payload`

With `noexec` on `/tmp`, step 3 fails. The attacker can still write the file, but can't execute it. Combined with `nosuid` (prevents SUID escalation) and `nodev` (prevents creating device files), you eliminate an entire class of post-exploitation techniques.

**`/dev/shm` is especially dangerous:** It's a tmpfs backed by RAM — fast and never touches disk. Malware authors love it because payloads loaded from `/dev/shm` leave no disk forensic trace.

**How it works under the hood:**

On a default Ubuntu install, `/tmp` is just a regular directory on your root filesystem (`/`). It inherits whatever mount options the root filesystem has — which includes `exec` (allows running binaries). There's nothing special about it.

The key concept: mount options like `noexec` are per-filesystem, not per-directory. You can't set `noexec` on just one directory within a filesystem — it applies to the entire mounted filesystem. So to give `/tmp` different options than `/`, you need it to be its own separate mount. That's what the fstab entries below do — they tell Linux to mount a separate tmpfs (RAM-backed filesystem) on top of each directory, replacing the regular directory with a restricted filesystem.

This has a side benefit: since tmpfs lives in RAM, `/tmp` becomes faster and temp files don't wear your SSD. Files in tmpfs are also wiped on reboot, which is the expected behavior for `/tmp` anyway.

`/dev/shm` is already a tmpfs by default on Ubuntu, but without the `noexec` restriction. The fstab entry overrides it with stricter options. `/var/tmp` gets a bind mount to `/tmp` — this makes `/var/tmp` point to the same tmpfs, so it inherits the same restrictions. Without it, `/var/tmp` would still be on the root filesystem with `exec` allowed.

**How to apply:**

Add all three lines to `/etc/fstab`:

```
tmpfs /tmp        tmpfs rw,noexec,nosuid,nodev,size=2G,mode=1777 0 0
tmpfs /dev/shm    tmpfs rw,noexec,nosuid,nodev,size=1G           0 0
/tmp  /var/tmp    none  bind                                      0 0
```

Then reboot to apply (a reboot is the cleanest way since processes are actively using `/tmp`):

```bash
reboot
```

After reboot, verify the mounts are active with the correct options:

```bash
mount | grep -E '/tmp|/dev/shm'
# You should see noexec,nosuid,nodev in the output
```

**What could go wrong:**
- **Build tools that execute from /tmp:** Some package installers (`dpkg`, `apt`) and build systems extract and execute scripts in `/tmp`. If an `apt upgrade` fails with "Permission denied", temporarily remount: `mount -o remount,exec /tmp`, do the upgrade, then remount with `noexec`.
- **Docker and /dev/shm:** Docker containers have their own `/dev/shm` (not the host's), so container workloads are unaffected. The host's `/dev/shm` restriction only applies to host processes.
- **Applications that need /tmp execution:** Some Java applications and snap packages need to execute from `/tmp`. Test before deploying.

**Automation:** `ansible/roles/base/` (fstab entries for `/tmp`, `/dev/shm`, `/var/tmp`).

---

### 2.8 Core dumps disabled

**What it does:** Prevents processes from writing memory dumps to disk when they crash.

**Why it matters:** When a process crashes, the kernel can write its entire memory contents to a "core dump" file. This includes everything the process had in memory: environment variables (API keys, database passwords), session tokens, encryption keys, user data. An attacker who can trigger a crash (e.g., via a crafted request that causes a segfault) and read the core dump gets all of these secrets for free.

Even without an attacker, core dumps sitting on disk are a liability — they contain secrets that survive process termination.

**How to apply:**

Core dumps are controlled by three independent systems on Ubuntu, so you need to disable all three. Here's the order:

**Step 1 — sysctl:** Add this line to `/etc/sysctl.d/99-hardening.conf` (the same file from sections 2.2 and 2.3):

```ini
# Disable core dumps for SUID programs
fs.suid_dumpable = 0
```

**Step 2 — PAM limits:** Create the file `/etc/security/limits.d/hardening.conf`:

```
# Disable core dumps for all users
*    hard    core    0
```

**Step 3 — systemd-coredump:** Create the directory and config file `/etc/systemd/coredump.conf.d/hardening.conf`:

```bash
mkdir -p /etc/systemd/coredump.conf.d
```

```ini
[Coredump]
Storage=none
ProcessSizeMax=0
```

**Step 4 — Apply everything:**

```bash
sysctl -p /etc/sysctl.d/99-hardening.conf
systemctl daemon-reload
```

The sysctl and systemd changes take effect immediately. The PAM limits apply to new login sessions (your current session is unaffected — log out and back in, or reboot).

**Why three files?** Each controls a different layer: sysctl prevents the kernel from dumping SUID binaries, PAM limits prevent any user process from requesting a core dump, and the systemd config disables Ubuntu's default core dump collector (`systemd-coredump`). An attacker only needs one of these to be missing to get a dump.

**What could go wrong:**
- **Debugging crashes becomes harder:** Without core dumps, you lose the ability to post-mortem debug with `gdb`. If you need to debug a crash, temporarily re-enable: `ulimit -c unlimited` in the debugging session.
- **systemd-coredump:** Ubuntu uses systemd-coredump by default, which stores dumps in `/var/lib/systemd/coredump/`. The systemd config above disables this.

**Automation:** `ansible/roles/base/` (sysctl template, limits file, and systemd coredump config).

---

### 2.9 Default umask

**What it does:** Sets the default file creation permission mask so new files are not world-readable.

**Why it matters:** Ubuntu's default umask is `022`, meaning every file you create is readable by all users (`-rw-r--r--`) and every directory is listable by all users (`drwxr-xr-x`). On a multi-user system this enables information disclosure; on a single-user server it's less critical but still violates the principle of least privilege.

A umask of `027` means: owner gets full access, group gets read/execute, others get nothing. Files are created as `-rw-r-----`, directories as `drwxr-x---`.

**How to apply:**

Edit `/etc/login.defs`:

```
UMASK 027
```

Or for stricter (`077` — owner only):

```
UMASK 077
```

**What could go wrong:**
- **Web server file permissions:** If your app creates files that a web server needs to read (e.g., static assets), a strict umask may break this. Docker containers have their own umask, so containerized apps are unaffected.
- **Shared directories:** If multiple services need to access the same files, `027` may be too restrictive. `027` is the safe default for a single-operator server.

**Automation:** `ansible/roles/base/` (sets `UMASK` in `/etc/login.defs`).

---

### 2.10 Time synchronization

**What it does:** Ensures your server's clock is accurate and synchronized with trusted time sources using NTP (Network Time Protocol).

**Why it matters:** An inaccurate clock breaks more than you'd think:
- **TLS certificate validation:** Certificates have validity windows. A clock that's off by more than a few minutes can cause TLS handshakes to fail (your server rejects valid certs as "not yet valid" or "expired").
- **fail2ban timing:** `findtime` and `bantime` depend on accurate timestamps. A wrong clock means fail2ban's sliding windows are wrong.
- **Log correlation:** If you're investigating an incident, timestamps that don't match reality make forensics nearly impossible.
- **Kerberos / OAuth:** Token-based auth systems have tight time tolerances.
- **Replay attacks:** An attacker who can skew your clock can replay expired tokens or certificates.

Ubuntu 24.04 ships with `systemd-timesyncd` enabled by default, which syncs with `ntp.ubuntu.com`. This is adequate for most setups. For higher security, use `chrony` with multiple trusted sources.

**How to apply:**

```bash
# Verify current time sync
timedatectl status

# If using systemd-timesyncd (default), check it's running
systemctl status systemd-timesyncd

# For higher security, switch to chrony
apt install chrony -y
systemctl enable chrony
```

Edit `/etc/chrony/chrony.conf` to use multiple trusted sources:

```
pool ntp.ubuntu.com        iburst maxsources 4
pool time.cloudflare.com   iburst maxsources 2
pool time.google.com       iburst maxsources 2

# Require at least 3 sources to agree before adjusting
minsources 3
```

**What could go wrong:**
- **NTP port blocked:** NTP uses UDP port 123. If your outbound firewall blocks this (section 3.7), time sync breaks. The Hetzner firewall allows outbound by default.
- **Time jumps:** Large clock adjustments can confuse applications. `chrony` handles this gracefully with slewing (gradual adjustment) rather than stepping (instant jump).

**Automation:** `ansible/roles/base/` (ensures `systemd-timesyncd` or `chrony` is running and configured).

> **Further reading:**
> - [chrony documentation](https://chrony-project.org/documentation.html) — official docs; covers NTS (Network Time Security) for authenticated NTP
> - [Falsehoods programmers believe about time](https://gist.github.com/timvisee/fcda9bbdff88d45cc9061606b4b923ca) — humbling list that illustrates why time is harder than you think

---

## Tier 3 — Advanced / optional

These provide additional hardening but add complexity. Apply them based on your threat model and comfort level. The Ansible automation does NOT apply these by default — they require opt-in.

### 3.1 Kernel boot parameters

**What it does:** Configures kernel hardening features at boot time via GRUB command line parameters.

**Why it matters:** Some security features can only be enabled at boot, before the kernel initializes memory and process management. These parameters harden memory allocation, enable security modules, and mitigate CPU vulnerabilities.

**Key parameters:**

```
# Memory hardening
init_on_alloc=1        # Zero newly allocated pages (prevents data leaks between processes)
init_on_free=1         # Zero freed pages (same, slightly more expensive)
page_alloc.shuffle=1   # Randomize page allocator free lists (makes heap exploits harder)
slab_nomerge           # Prevent slab merging (makes use-after-free exploits harder)
randomize_kstack_offset=1  # Randomize kernel stack offset per syscall

# Disable legacy features
vsyscall=none          # Disable vsyscalls (old syscall mechanism, used in ROP gadgets)

# CPU vulnerability mitigations (enabled by default on Ubuntu but worth being explicit)
spectre_v2=on
l1tf=full,force
spec_store_bypass_disable=on

# Security modules
apparmor=1
lsm=landlock,lockdown,yama,apparmor
```

**How to apply:**

Edit `/etc/default/grub` and append the parameters (space-separated) to the `GRUB_CMDLINE_LINUX_DEFAULT` line:

```
GRUB_CMDLINE_LINUX_DEFAULT="quiet splash init_on_alloc=1 init_on_free=1 page_alloc.shuffle=1 slab_nomerge randomize_kstack_offset=1 vsyscall=none spectre_v2=on l1tf=full,force spec_store_bypass_disable=on apparmor=1 lsm=landlock,lockdown,yama,apparmor"
```

Then apply and reboot:

```bash
update-grub
reboot
```

**Performance impact:** `init_on_alloc=1` and `init_on_free=1` have a 1-5% CPU overhead depending on allocation patterns. For a web/game server, this is negligible. `slab_nomerge` increases memory usage slightly by preventing the kernel from combining similar-sized allocations.

**What could go wrong:**
- **Boot failure:** A wrong GRUB parameter can prevent booting. Hetzner's rescue mode lets you mount the disk and fix GRUB.
- **Performance regression:** If your workload is allocation-heavy (e.g., a JVM with large heap), `init_on_free=1` can be noticeable. Test with your workload.

> **Further reading:**
> - [Linux Hardening Guide (Madaidan) — Kernel section](https://madaidans-insecurities.github.io/guides/linux-hardening.html#kernel) — the most detailed public reference for kernel boot parameters; explains each parameter's security impact
> - [Kernel command-line parameters (kernel.org)](https://www.kernel.org/doc/html/latest/admin-guide/kernel-parameters.html) — the official kernel documentation; authoritative but not beginner-friendly
> - [Spectre/Meltdown mitigations (kernel.org)](https://www.kernel.org/doc/html/latest/admin-guide/hw-vuln/) — official docs on CPU vulnerability mitigations in the kernel

---

### 3.2 AppArmor

**What it does:** Mandatory Access Control (MAC) system that confines programs to a limited set of resources. Unlike traditional Unix permissions (which are discretionary — the file owner decides), AppArmor policies are enforced by the kernel regardless of the process's UID.

**Why it matters:** If your web application is compromised, AppArmor limits what the attacker can access — even if they're running as the same user as your app. The app can only read/write files explicitly listed in its profile.

**Is it already installed?** Ubuntu 24.04 normally includes AppArmor. Check the loaded profiles and each workload's actual label. An enabled AppArmor service does not automatically confine every host program.

**How to check the current state:**

```bash
# See all loaded profiles and whether they're in enforce or complain mode
aa-status

# You should see output like:
# apparmor module is loaded.
# 42 profiles are loaded.
# 20 profiles are in enforce mode.
# ...
```

**How AppArmor relates to Docker:** Docker generates `docker-default` for ordinary containers. It adds mount and sensitive kernel-path restrictions while retaining broad application compatibility. Its file/network rules are not a general allowlist, and raw sockets are not universally blocked. Capabilities, seccomp and network isolation supply separate controls. The container profile does not automatically confine the Docker daemon.

Inspect only the declared label, then check the kernel label:

```bash
docker inspect --format '{{.AppArmorProfile}}' your-container
docker exec your-container cat /proc/self/attr/current
```

Require the expected enforcing label. Inspecting the full container JSON can expose credentials. Test a new disposable container after runtime or AppArmor updates too. [Docker's profile documentation](https://docs.docker.com/engine/security/apparmor/) and [current built-in template](https://github.com/moby/profiles/blob/main/apparmor/template.go) describe the policy; check the deployed version before changing it.

**Custom profiles:** Add workload-specific restrictions after testing real filesystem, network and migration needs. Keep resource limits, no-new-privileges, reduced capabilities and data/network isolation alongside AppArmor.

**Load a reviewed profile after an isolated canary:**

```bash
# Syntax/cache-independent check without changing kernel policy:
apparmor_parser -Q -T /etc/apparmor.d/your-reviewed-profile
# Load this tested profile:
apparmor_parser -r /etc/apparmor.d/your-reviewed-profile
```

An allow-all profile can grant a namespace exception rather than confinement.
On these headless VPSs, Nautilus is absent and no process uses its profile, so its
unused exception is persistently disabled by a named link under
`/etc/apparmor.d/disable/`. Only that named live profile was removed; all other
kernel profiles and container controls stayed unchanged. Missing package
profiles need migration/payload review before restoration or baseline acceptance.

---

### 3.3 AIDE — file integrity monitoring

**What it does:** Compares selected system files with a reviewed hash baseline. A scheduled job without a readable baseline provides no file-integrity coverage.

**Why it matters:** Application RCE can become persistence in executables, systemd units, cron, PAM or SSH settings. AIDE adds evidence about changes; root can still alter a local checker or its database.

**Establish trust before initializing:** On an existing host, review incident evidence, package verification, unexpected processes, accounts and startup units. Compare security-critical executables with signed distribution packages. If host compromise is suspected, rebuild from trusted media and restore verified data. Creating a baseline does not prove a host was clean.

Use one explicit configuration and database path. Exclude volatile Docker/containerd state, runtime files and logs, and retain checks for operating-system binaries, `/etc`, boot files, cron and service definitions. Send logs off-host separately. The check must report a missing database as a failure.

**Never automatically accept the current filesystem:** Remove unconditional APT hooks that run `aide --update` and replace the baseline. Such a hook can bless unrelated malicious changes during a legitimate upgrade. After an update, review the precise package/configuration changes before promoting a new baseline. Keep the previous database and a signed or otherwise independently protected copy.

**Prove detection:** In an isolated fixture, initialize the same policy, change a harmless monitored file, and require a nonzero difference result. Then run the production check and verify its freshness/alert path. A successful process exit or a line saying “no changes” is insufficient when the same log reports a missing database.

Use the existing configured alert transport with verified TLS. Healthy runs stay quiet; failures and unexpected changes alert. Avoid a second daily cron job alongside systemd, and do not solve mail errors by handing an unprivileged checker broad credential-file access.

**Recovery:** Preserve findings and the old baseline. Investigate before accepting a change. Restore the previous checker/configuration if deployment fails; do not overwrite production data or discard incident evidence to get a green result.

---

### 3.4 Rootkit detection

**Tools:** `rkhunter` and `chkrootkit`

**What they do:** Scan for known rootkit signatures, suspicious files, and unusual system state (hidden processes, modified binaries).

```bash
apt install rkhunter chkrootkit -y
rkhunter --update
rkhunter --check --skip-keypress
chkrootkit
```

**Limitations:** Signature-based detection only finds known rootkits. A sophisticated attacker with a custom rootkit won't be detected. These tools are most useful against automated/commodity attacks.

---

### 3.5 Log monitoring

**What it does:** Tools like `logwatch` aggregate and summarize log files, sending daily reports.

```bash
apt install logwatch -y
logwatch --detail med --output stdout --range today
```

**Alternative:** For a more modern approach, consider shipping logs to an external service (Grafana Loki, Datadog, etc.) so they survive even if the server is compromised.

---

### 3.6 Encrypted DNS

**What it does:** DNS queries are normally sent in plaintext UDP. Anyone on the network path can see what domains you're resolving. Encrypted DNS (DNS-over-TLS or DNS-over-HTTPS) prevents this.

**When it matters:** If you're worried about DNS-based surveillance or DNS poisoning attacks. For most Hetzner VPS setups, the default DNS resolvers are local to Hetzner's network and already reasonably trustworthy — encrypted DNS adds marginal benefit.

> **Note:** This section is intentionally a stub. DNS configuration is environment-specific and a misconfiguration can break all name resolution on your server (no DNS = no apt updates, no Docker pulls, no outbound connections). If you want to pursue this, see the [dnscrypt-proxy wiki](https://github.com/DNSCrypt/dnscrypt-proxy/wiki) for complete setup instructions, including how to integrate with `systemd-resolved` on Ubuntu 24.04. An alternative is configuring `systemd-resolved` directly for DNS-over-TLS with Cloudflare (`1.1.1.1`) or Quad9 (`9.9.9.9`) — see the [systemd-resolved docs](https://www.freedesktop.org/software/systemd/man/resolved.conf.html).

---

### 3.7 Outbound firewall restrictions

**What it does:** Instead of allowing all outbound traffic, restrict outgoing connections to specific ports and destinations.

```bash
ufw default deny outgoing
ufw allow out 22/tcp     # SSH
ufw allow out 53/udp     # DNS
ufw allow out 80/tcp     # HTTP (for apt)
ufw allow out 123/udp    # NTP
ufw allow out 443/tcp    # HTTPS
```

**Why it matters:** If an attacker compromises your server, outbound restrictions prevent them from:
- Exfiltrating data to arbitrary hosts
- Downloading additional tools/malware
- Establishing reverse shells on non-standard ports
- Using your server as a proxy

**What could go wrong:** Docker, Tailscale, and many services need outbound connectivity. Restricting outbound traffic is high-maintenance — every new service needs a rule. For a single-operator VPS, the benefit may not justify the ongoing effort.

---

### 3.8 Lynis security auditing

**What it does:** Lynis scans your system and produces a hardening score with specific, actionable recommendations. It checks hundreds of settings across SSH, filesystems, kernel, networking, authentication, and more.

**Why it matters:** After applying hardening, you need a way to verify nothing was missed and to catch regressions. Lynis is the standard tool for this — trusted by enterprises, used in CIS benchmark validation, and completely open source.

**How to apply:**

```bash
apt install lynis -y

# Full audit
lynis audit system

# The report is at /var/log/lynis-report.dat
# Suggestions are listed at the end of stdout
```

Lynis outputs a "Hardening index" (0-100). A freshly hardened server using this guide typically scores 75-85. Getting above 90 requires Tier 3 measures.

**How to read the output:**
- **[WARNING]** — serious issues that should be fixed
- **[SUGGESTION]** — improvements ranked by impact
- **[OK]** — checks that passed

Run Lynis periodically (monthly) or after major changes to catch drift.

**Automation:** `ansible/roles/lynis/` (installs Lynis and runs an audit).

---

### 3.9 SUID/SGID binary audit

**What it does:** Identifies binaries with the SUID or SGID bit set — these run with elevated privileges regardless of who executes them.

**Why it matters:** SUID binaries are the classic privilege escalation vector. A vulnerability in any SUID-root binary gives an attacker instant root access. Ubuntu ships with dozens of SUID binaries, most of which your server never needs.

**How to audit:**

```bash
# Find all SUID binaries
find / -perm -4000 -type f 2>/dev/null

# Find all SGID binaries
find / -perm -2000 -type f 2>/dev/null
```

**Common SUID binaries you can safely strip:**

| Binary | What it does | Safe to strip on a server? |
|--------|-------------|---------------------------|
| `/usr/bin/chfn` | Change finger info | Yes — nobody needs finger info on a VPS |
| `/usr/bin/chsh` | Change login shell | Yes — manage shells via config management |
| `/usr/bin/newgrp` | Change primary group | Yes — rarely needed |
| `/usr/bin/mount` | Mount filesystems | Usually yes — non-root shouldn't mount |
| `/usr/bin/umount` | Unmount filesystems | Usually yes |

**How to strip:**

```bash
chmod u-s /usr/bin/chfn /usr/bin/chsh /usr/bin/newgrp
```

**What could go wrong:**
- **Stripping sudo or su:** Don't. You'll lock yourself out of privilege escalation entirely.
- **Package updates restore SUID:** `apt upgrade` will restore the SUID bit on updated binaries. Re-audit after upgrades.

---

### 3.10 Kernel module loading restriction

**What it does:** After boot, prevents loading new kernel modules entirely.

**Why it matters:** Kernel modules run with full kernel privileges. A rootkit loaded as a kernel module has complete control over the system and is nearly undetectable. By disabling module loading after boot, even root can't load a malicious module.

**How to apply:**

```bash
# After boot is complete and all needed modules are loaded:
sysctl -w kernel.modules_disabled=1
```

Or add to `/etc/sysctl.d/99-hardening.conf`:

```ini
kernel.modules_disabled = 1
```

**What could go wrong:**
- **This is irreversible until reboot.** Once set, you can't load any kernel module — not even legitimate ones. Plugging in a USB device that needs a module, loading a filesystem driver, or adding a network module all fail.
- **Docker and modules:** Docker sometimes needs to load the `br_netfilter` or `overlay` modules. If these aren't loaded before the restriction takes effect, Docker networking breaks. The Ansible role loads required modules first, then restricts.
- **VPN modules:** WireGuard/Tailscale may need the `wireguard` module. On modern kernels it's built-in, but check with `lsmod | grep wireguard`.

**Automation:** `ansible/roles/base/` (optional, via `sysctl_disable_module_loading` variable; loads required modules before restricting).

---

### 3.11 Resource limits

**What it does:** Configures per-user resource limits to prevent processes from consuming excessive system resources.

**Why it matters:** Without limits, a single runaway process (or a deliberate fork bomb: `:(){ :|:& };:`) can consume all PIDs, memory, or file descriptors, crashing every service on the server. Limits are your safety net against both bugs and attacks.

**How to apply:**

Create `/etc/security/limits.d/hardening.conf`:

```
# Prevent fork bombs (max processes per user)
*    hard    nproc     4096

# Limit open file descriptors (prevent fd exhaustion)
*    hard    nofile    65535
*    soft    nofile    65535

# Disable core dumps (see section 2.8)
*    hard    core      0
```

**What could go wrong:**
- **nproc too low for Docker:** Docker can spawn many processes. 4096 is generous for a server, but if you're running many containers, increase it.
- **nofile too low for databases:** Databases like MongoDB and PostgreSQL need many open file descriptors. 65535 is usually sufficient; check your database docs.

**Automation:** `ansible/roles/base/` (deploys limits config file).

---

### 3.12 auditd — system call auditing

**What it does:** The Linux Audit Framework (`auditd`) records system calls, file access, privilege escalation attempts, and user commands at the kernel level. It's the most comprehensive logging system available on Linux.

**Why it matters:** If your server is compromised, `auditd` logs tell you exactly what the attacker did: what files they read, what commands they ran, what processes they spawned. Regular logs only capture what applications choose to log; `auditd` captures everything at the kernel level.

**How to apply:**

**Step 1 — Install auditd:**

```bash
apt install auditd audispd-plugins -y
```

**Step 2 — Configure log rotation** to prevent audit logs from filling your disk. Edit `/etc/audit/auditd.conf` and find/change these settings:

```ini
# Maximum size of a single log file in MB. When this is reached, auditd
# rotates to a new file.
max_log_file = 50

# How many rotated log files to keep. With 50MB x 10 files = 500MB max
# disk usage for audit logs. Adjust based on your disk size.
num_logs = 10

# What to do when max_log_file is reached: ROTATE creates a new file
# (the safe choice). Other options: IGNORE (keep writing, risky),
# SYSLOG (send to syslog), SUSPEND (stop logging), HALT (shut down the system).
max_log_file_action = ROTATE

# What to do when disk space is low. SUSPEND stops logging rather than
# crashing your server. On a VPS with limited disk, this matters.
space_left_action = SYSLOG
admin_space_left_action = SUSPEND
disk_full_action = SUSPEND
```

**Step 3 — Create audit rules.** Create the file `/etc/audit/rules.d/hardening.rules`:

```
# Delete any pre-existing rules (clean slate)
-D

# Set buffer size (how many audit messages to queue in kernel memory).
# 8192 is generous — increase if you see "audit backlog limit exceeded" in dmesg.
-b 8192

# Log all commands executed by root. This is the most valuable rule —
# if an attacker gets root, you'll see every command they ran.
# -a = add rule, always,exit = log on syscall exit
# -F arch=b64 = 64-bit syscalls, -F euid=0 = effective user is root
# -S execve = the "execute program" syscall, -k = searchable tag
-a always,exit -F arch=b64 -F euid=0 -S execve -k root_commands

# Log changes to authentication files. These are the files an attacker
# would modify to add a backdoor user, change passwords, or grant sudo.
# -w = watch this file, -p wa = trigger on writes (w) and attribute changes (a)
-w /etc/passwd -p wa -k auth_changes
-w /etc/shadow -p wa -k auth_changes
-w /etc/sudoers -p wa -k auth_changes
-w /etc/sudoers.d -p wa -k auth_changes
-w /etc/ssh/sshd_config -p wa -k ssh_changes
-w /etc/ssh/sshd_config.d -p wa -k ssh_changes

# Log privilege escalation attempts
# -p x = trigger on execute
-w /usr/bin/sudo -p x -k privilege_escalation
-w /usr/bin/su -p x -k privilege_escalation

# Log changes to audit config itself (an attacker might try to disable auditing)
-w /etc/audit/ -p wa -k audit_config_changes
-w /etc/audit/rules.d/ -p wa -k audit_config_changes

# Make audit config immutable — once loaded, rules cannot be changed
# without a reboot. This prevents an attacker from disabling auditing
# at runtime, even with root access. Remove this line while you're still
# testing and tuning rules, then add it back once you're happy.
-e 2
```

**Step 4 — Load the rules and enable auditd:**

```bash
systemctl enable auditd
systemctl restart auditd

# Verify rules are loaded
auditctl -l
```

**Step 5 — Reading the logs.** auditd's raw logs (`/var/log/audit/audit.log`) are dense and hard to read. Use the reporting tools instead:

```bash
# Summary of all activity (the report you saw earlier)
aureport --summary

# What commands did root run recently?
ausearch -k root_commands --start recent --interpret

# Were any auth files modified?
ausearch -k auth_changes --start recent --interpret

# Any privilege escalation?
ausearch -k privilege_escalation --start today --interpret

# Failed syscalls (permission denials, AppArmor blocks, etc.)
aureport --syscall --failed --summary

# Anomaly events (unusual system behavior)
aureport --anomaly
```

The `--interpret` flag translates numeric UIDs, syscall numbers, and timestamps into human-readable text. Without it, you'd see `uid=0` instead of `uid=root` and `syscall=59` instead of `syscall=execve`.

**What could go wrong:**
- **Disk space without rotation:** Without the log rotation config in step 2, auditd will write logs indefinitely. On an active server with Docker, audit logs can grow by hundreds of MB per day. The rotation config caps total usage at ~500MB.
- **Performance:** Auditing every system call has overhead. The rules above are targeted (only root commands and auth files), keeping impact minimal. Avoid broad rules like `-a always,exit -S open` (log every file open) — these generate massive log volumes and measurable CPU overhead.
- **The `-e 2` immutable flag:** Once loaded, you can't modify audit rules without rebooting. This is the point (it prevents an attacker from disabling auditing), but it means you need to reboot after any rule change. Leave `-e 2` commented out while testing, then uncomment when you're done tuning.
- **Docker noise:** Docker container activity generates audit events (process creation, network syscalls, etc.). The rules above focus on host-level activity (root commands, auth files), so Docker noise is minimal. Avoid adding rules that watch `/var/lib/docker/` or you'll be flooded.

> **Further reading:**
> - [Red Hat: Linux Audit system reference](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/7/html/security_guide/chap-system_auditing) — the most thorough auditd guide available

---

### 3.13 SSH two-factor authentication

**What it does:** Adds a TOTP (Time-based One-Time Password) second factor to SSH, requiring both an SSH key and a 6-digit code from an authenticator app (Google Authenticator, Authy, etc.).

**Why it matters:** SSH keys can be stolen (malware on your laptop, backup leaked, key agent forwarded to a compromised host). 2FA means a stolen key alone isn't enough — the attacker also needs your phone.

**How to apply:**

```bash
apt install libpam-google-authenticator -y
```

As your deploy user:

```bash
google-authenticator -t -d -f -r 3 -R 30 -w 3
# Scan the QR code with your authenticator app
```

Edit `/etc/pam.d/sshd`:

```
auth required pam_google_authenticator.so
```

Edit `/etc/ssh/sshd_config.d/hardening.conf`:

```
AuthenticationMethods publickey,keyboard-interactive
KbdInteractiveAuthentication yes
```

**What could go wrong:**
- **Locked out if you lose your phone:** Keep the emergency backup codes from the initial setup. Store them securely (password manager, not on the server).
- **Automated tools break:** Any script that SSHes in (Ansible, CI/CD) can't type a TOTP code. Exempt specific users or use Tailscale SSH for automated access.
- **Tailscale SSH bypasses 2FA:** Tailscale SSH authenticates via your identity provider, not PAM. If you use Tailscale SSH exclusively, PAM-based 2FA on OpenSSH becomes irrelevant (but still protects the fallback OpenSSH path).

**When to use:** High-value servers (production databases, payment systems) or if you don't use Tailscale. For a solo dev with Tailscale, the value is marginal — Tailscale already provides strong identity verification.

---

### 3.14 Cloudflare Tunnel

**What it does:** Creates an outbound-only encrypted tunnel from your server to Cloudflare's edge network. Traffic reaches your server through this tunnel — no inbound ports needed at all.

**Why it matters:** This is the most aggressive network lockdown possible:
- Zero inbound ports open (not even 80 or 443)
- Your server's real IP is completely hidden
- DDoS traffic is absorbed by Cloudflare's network
- TLS termination happens at Cloudflare's edge
- No Hetzner Cloud Firewall or UFW complexity needed for web traffic

**How to apply:**

```bash
# Install cloudflared
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | gpg --dearmor -o /usr/share/keyrings/cloudflare-main.gpg
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  > /etc/apt/sources.list.d/cloudflared.list
apt update && apt install cloudflared -y

# Authenticate and create tunnel
cloudflared tunnel login
cloudflared tunnel create my-tunnel
```

Configure `~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: /root/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: app.example.com
    service: http://localhost:3000
  - hostname: coolify.example.com
    service: http://localhost:8000
  - service: http_status:404
```

```bash
cloudflared tunnel route dns my-tunnel app.example.com
cloudflared service install
systemctl enable cloudflared
```

**What could go wrong:**
- **Cloudflare dependency:** Your site goes down if Cloudflare goes down. For most users, Cloudflare's uptime exceeds what you'd achieve yourself.
- **WebSocket support:** Cloudflare Tunnels support WebSockets. For game servers with persistent connections, test latency — the extra hop through Cloudflare adds 5-20ms.
- **Cost:** The free plan covers most use cases. You pay for Cloudflare's premium features, not the tunnel itself.

**Trade-off vs. Tailscale:** Tailscale secures admin access (SSH). Cloudflare Tunnel secures public access (web traffic). They complement each other: Tailscale for you, Cloudflare for your users.

---

### 3.15 Backups

**What it does:** Creates regular, tested, off-server copies of your data.

**Why it matters:** Backups are security. They protect against:
- **Ransomware:** Attacker encrypts your disk, demands payment. You restore from backup instead.
- **Accidental destruction:** `terraform destroy` on the wrong stack, `rm -rf` in the wrong directory, a failed upgrade that corrupts data.
- **Hardware failure:** Hetzner disks can fail (rare but real).
- **Compromised server:** If an attacker modifies your data, you can restore a known-good state.

**The 3-2-1 rule:**
- **3** copies of your data (original + 2 backups)
- **2** different storage types (local + remote)
- **1** copy offsite (different provider or region)

**For a Docker/Coolify VPS:** use consistent logical database dumps and explicit persistent-file sources. Copying a live database volume can produce an unusable backup. The Hatchkit runner performs native dumps, encrypts them with restic, downloads the uploaded archive, verifies its SHA-256 and only then advances retention. Failed capture, upload or verification must preserve existing recovery points.

New policies retain 30 verified generations per project (`keepLast`, accepted range 3–365). An existing three-generation policy needs an explicit migration; a changed template cannot create missing history retroactively. Daily retention gives roughly a month of history only when daily captures succeed. Keep longer protected checkpoints because an intrusion may remain unnoticed for weeks.

Keep a second encrypted recovery history under credentials the VPS cannot use to delete it. Use a separate bucket/account or offline copy, record its retention and storage size, and prove restoration before relying on it. Do not enable object locking underneath an active restic repository that still prunes: its mutable index/snapshot lifecycle needs a separate archival design. Keep the recovery password in independently recoverable custody.

For immutable recovery copies, use a full independent restic tree for each
generation, with source-ETag copy conditions, identical before/after inventories,
destination verification and a completion marker written last. Count incomplete
generations toward the storage cap and serialize writers with a conditional
lease. Never apply object-age expiry to a shared content-addressed repository:
a recent snapshot may depend on an old pack. Verify locks using the actual
constrained writer and verify that VPS credentials cannot access the destination.
Keep the copy credential outside both VPSs; exclude asset buckets. Obtain explicit
approval naming the records and destination before transferring personal data.
The prepared `protected-recovery` template contains the guarded generation engine,
S3 adapter and bounded metadata loader/restore selector, with fixture coverage.
Selection needs an explicit generation and recovery cutoff, validates every
object and reports native restore and incident cleanliness as unverified. It
rejects oversized, truncated or invalid UTF-8 metadata and shares one deadline
across metadata loading and object verification. Its scheduler, independent
recovery credential integration, actual protected restore drill, independent
alerts and live lock tests remain activation requirements. Verify the execution
plan's request budget too: the current copy ceiling exceeds Workers Free limits.

Schedule isolated native restore drills weekly and an application recovery exercise at least quarterly. Drill containers must have no published ports, no production data mounts and no external network. Record each project's result, restored engine, elapsed time and application-startup result. A checksum check alone does not prove the database can be imported or the application can start.

The restored archives contain personal data and credentials. Keep drill files root-private, dispose only of task-owned disposable containers/volumes, and require explicit approval for a new upload destination. Metadata-only freshness reports must exclude records, SQL, logs, environment values and backup keys.

> **Further reading:**
> - [restic documentation](https://restic.readthedocs.io/) — excellent backup tool with encryption, deduplication, and S3 support
> - [Hetzner Backup documentation](https://docs.hetzner.com/cloud/servers/getting-started/enabling-backups/) — Hetzner's built-in snapshot/backup service

---

## Coolify-specific hardening

Coolify has a unique lifecycle that requires a two-phase security approach. If you're hardening a server that already has Coolify running, read the SSH compatibility section first — the SSH hardening from section 1.2 will break Coolify's server management if not adjusted.

> **When to apply:** If following this guide sequentially and planning to use Coolify, read this entire section first. Apply the SSH Match block during section 1.2 (before installing Coolify). Apply the DOCKER-USER rules after Coolify is installed and you've audited `docker ps` for exposed ports.

### SSH hardening and Coolify compatibility

**The problem:** Coolify manages your server by SSHing into it as `root` from inside its own Docker container (via `host.docker.internal` on port 22). The SSH hardening in section 1.2 blocks this in two ways:

- `PermitRootLogin no` — blocks root login entirely
- `AllowUsers deploy` — only allows your user, not root

After applying section 1.2, Coolify's dashboard will show "Not reachable & Not usable by Coolify" on the localhost server. Deploys, container management, and server validation all stop working.

**The fix:** Allow root login *only* from Docker's internal network (private IP ranges), while keeping it blocked from the public internet. Edit `/etc/ssh/sshd_config.d/hardening.conf`:

First, update the `AllowUsers` line to include root:

```
AllowUsers deploy root
```

Then add a `Match` block at the **very end** of the file (Match blocks must come last in SSH config — any directives after a Match block are scoped to that match, not global):

```
# Allow Coolify to SSH in as root from Docker's internal network.
# prohibit-password means key-only (no password auth).
# This does NOT allow root login from the internet — the global
# PermitRootLogin no still applies to all other addresses.
Match Address 172.16.0.0/12,10.0.0.0/8,192.168.0.0/16,127.0.0.1
    PermitRootLogin prohibit-password
```

Validate and restart:

```bash
sshd -t && systemctl restart sshd
```

Then go to Coolify's dashboard → Servers → localhost → click "Validate Server". It should go green.

**Why this is safe:** The `Match Address` block only applies to connections originating from private RFC 1918 IP ranges and localhost — these are Docker's internal bridge networks. Traffic from the public internet arrives on your server's public IP and matches the global `PermitRootLogin no` rule instead. An attacker on the internet cannot spoof a source address from these ranges because your kernel's `rp_filter` (section 2.2) drops packets with forged source addresses.

**If you're setting up Coolify on a fresh server:** Apply the SSH hardening from section 1.2 with the `Match` block included from the start, before installing Coolify. This avoids the "it was working, now it's broken" moment.

### Phase 1 — Bootstrap (ports open)

During initial setup, Coolify needs:
- **Port 8000:** Dashboard web UI (used to create admin account, configure domain, set up HTTPS)
- **Port 6001/6002:** WebSocket connections for real-time dashboard updates

These must be accessible from your IP to complete the initial setup.

### Phase 2 — Lockdown (ports closed)

After you've:
1. Created an admin account
2. Configured your domain (e.g., `coolify.example.com`)
3. Verified HTTPS is working via Traefik

Run the lockdown:

```bash
# Via Ansible
make lockdown STACK=node-realtime

# Or manually
ufw delete allow 8000/tcp
ufw delete allow 6001/tcp
ufw delete allow 6002/tcp
```

After lockdown, Coolify's dashboard is only accessible via its domain (proxied through Traefik on ports 80/443). If you have Tailscale, you can also access it via `http://<tailscale-ip>:8000`.

### Docker port safety with Coolify

Coolify uses Traefik as its reverse proxy. Application containers should NOT have their ports published directly. Instead, Traefik routes traffic based on domain names:

```
Internet → :443 → Traefik → Docker internal network → Your container :3000
```

This means your application container doesn't need any published ports — it's only accessible via Traefik's internal Docker network. This is the correct and secure setup.

**Red flag:** If you see your app containers with `-p 0.0.0.0:3000:3000` in `docker ps`, something is misconfigured. The port is accessible from the internet regardless of UFW.

### Auditing what Coolify exposes

After setting up Coolify and deploying services, run `docker ps` and look at the PORTS column. You'll likely see something like this:

```
# GOOD — port only on Docker internal network (no 0.0.0.0)
tiao-client     80/tcp
postgres        5432/tcp
valkey          6379/tcp

# EXPECTED — Traefik needs 80/443 public for web traffic
coolify-proxy   0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp

# PROBLEM — additional ports bound to 0.0.0.0
coolify-proxy   0.0.0.0:8080->8080/tcp     ← Traefik dashboard/API
glitchtip-web   0.0.0.0:8001->8001/tcp     ← Error tracking UI
```

When you see `0.0.0.0:<port>`, that port is bound to all network interfaces on the host. As explained in section 2.4, Docker publishes these ports by inserting iptables rules that bypass UFW entirely. The only reason these aren't reachable from the internet right now is the Hetzner Cloud Firewall — which only allows ports 22, 80, and 443 inbound. But relying on a single layer is fragile:

- If you (or Terraform, or a script) ever modify the Hetzner firewall to open more ports, these services are instantly exposed
- Traffic between VMs in the same Hetzner project bypasses the cloud firewall entirely, so another compromised VM could reach them
- It's a single point of failure — defense in depth means not trusting any one layer

**Why this happens:** Coolify and the services it deploys configure their Docker port bindings. You don't always control how a third-party Docker image publishes ports. Traefik's `8080` is its dashboard/API port (enabled by Coolify's Traefik config with `--api.insecure=true`). Services like GlitchTip may expose management ports alongside their main application port. The result is `0.0.0.0` bindings you didn't explicitly ask for.

**How to fix — install ufw-docker (section 2.4, Option B):**

Once you have ufw-docker installed and `ufw-docker install` has run (see section 2.4), the FORWARD chain default is *deny*: anything Docker publishes is unreachable from outside until you explicitly allow it via `ufw route allow`. So you don't need to enumerate the leaked ports (8080, 8001, etc.) at all — they're blocked by the default. You only need to *opt in* the ports that should be reachable:

```bash
# Allow Traefik on 80/443 (the only ports your apps should be on)
sudo ufw route allow proto tcp from any to any port 80
sudo ufw route allow proto tcp from any to any port 443
```

Verify it works:

```bash
# From the VPS itself — should still respond (traffic doesn't traverse FORWARD)
curl -s http://localhost:8080

# From your local machine — should be blocked
curl -s --max-time 3 http://<your-vps-ip>:8080
```

**What this does internally:** ufw-docker adds a block to `/etc/ufw/after.rules` that hooks into the `DOCKER-USER` chain (which Docker evaluates *before* its own `DOCKER` chain). The block default-denies external→container forwarding and integrates with UFW's `ufw-user-forward` chain, so `ufw route allow` rules become FORWARD-chain allows. Persistence is via UFW's normal boot mechanism — no `iptables-persistent`, no separate systemd unit.

**Ongoing maintenance:** Every time you deploy a new service through Coolify, re-check `docker ps` for new `0.0.0.0` bindings. By default they're already unreachable from outside (default-deny). If you *want* one to be reachable, `sudo ufw route allow proto tcp from any to any port <PORT>`. If a Coolify dashboard port (8000, 6001, 6002) was opened during bootstrap and you're closing it now, `sudo ufw route delete allow proto tcp from any to any port <PORT>`.

### Recovery from a silent UFW removal

If you previously ran `apt install iptables-persistent` (or followed an older version of this guide that recommended it), you may be in this exact state:

- `dpkg -l ufw` shows `rc  ufw  …` — package removed, config files retained
- `/usr/sbin/ufw` does not exist
- `/etc/ufw/` still has `user.rules`, `before.rules`, etc.
- `apt history.log` shows `Remove: ufw:amd64` in the same transaction as `Install: iptables-persistent:amd64`

The conflict is bidirectional. You can confirm by running `apt install --simulate ufw` — the resolver will plan to `Remv iptables-persistent` and `Inst ufw`. So the migration to the canonical setup (UFW + ufw-docker) involves losing iptables-persistent on purpose. Plan it, don't drift into it.

On the VPS as root:

```bash
# 1. Audit current state. Snapshot everything before we change anything.
sudo iptables-save > /root/iptables-pre-migration.v4
sudo cat /etc/iptables/rules.v4 > /root/rules.v4-pre-migration  # what netfilter-persistent restores at boot
sudo iptables -L DOCKER-USER -nv --line-numbers                  # what's live right now

# 2. Identify hand-added DOCKER-USER rules in the snapshot above. Anything
#    beyond the `RELATED,ESTABLISHED ACCEPT` baseline that you (not Docker)
#    added is what you need to recreate as `ufw route allow` rules later.
#    Typical case: just :80 and :443 needed. Anything else (e.g., a custom
#    `docker0 -> eth0 ACCEPT` you added to fix a connectivity bug) noted
#    separately.

# 3. Install ufw + ufw-docker. This step REMOVES iptables-persistent. Your
#    in-memory iptables rules survive until reboot, so Docker apps stay up
#    while we set up the replacement. (apt install --simulate ufw confirms
#    the resolver's plan before you commit.)
sudo apt install -y ufw

UFW_DOCKER_VERSION=251123
sudo curl -fsSL "https://github.com/chaifeng/ufw-docker/raw/${UFW_DOCKER_VERSION}/ufw-docker" \
  -o /usr/local/bin/ufw-docker
sudo chmod +x /usr/local/bin/ufw-docker
sudo ufw-docker install
sudo ufw reload

# 4. Add a `ufw route allow` for every port that needs forwarding.
#    Coolify with Traefik typically only needs 80 and 443.
sudo ufw route allow proto tcp from any to any port 80
sudo ufw route allow proto tcp from any to any port 443

# 5. Make sure UFW itself is enabled. Pre-existing /etc/ufw/user.rules
#    (from before the silent removal) will be reused.
sudo ufw enable
sudo ufw status verbose

# 6. Reboot to confirm everything comes up cleanly under the new setup.
#    If something doesn't, /root/iptables-pre-migration.v4 is your rollback:
#    sudo iptables-restore < /root/iptables-pre-migration.v4
sudo reboot
```

If you're using the Ansible role with `ufw_docker_mitigation: true`, the base role refuses to run while `iptables-persistent` is installed — do step 3 above (the `apt install ufw` will remove iptables-persistent), then re-run `make harden`. The role's `ufw-docker install` and `ufw route allow` tasks are idempotent and safe to re-run.

---

## Ongoing security operations

Hardening is a recurring operating practice. Inventory the host OS/kernel, Docker Engine, containerd, runc, Tailscale, application runtimes, application dependencies and final deployed image packages. Resolve floating tags to running versions and scan immutable image IDs. Keep SBOM/package reports private on the host. Verify the scanner release signature/checksum and record its version and vulnerability-database age. A failed, stale or partial inventory is an incomplete check, never a clean result.

After setup settles, aim for one short weekly human review. Frequent server
checks continue independently; healthy and materially unchanged results stay
quiet. Batch ordinary maintenance and non-urgent decisions. Interrupt promptly
for applicable urgent exposure, failed backups, unexplained integrity changes,
failed remediation and genuinely lost coverage. Keep overdue risks visible with
bounded reminders. Send no empty weekly email and do not delay urgent work until
the weekly review. Scanner counts are a triage queue, not a human task: establish
vendor applicability and exposure and prepare/test a concrete fix before asking
the operator for a decision.

Investigate alert evidence before suppressing it. AIDE reports changes or a
failed check, not a process finding count; zero process-style findings must not
make a failed file check appear clean. Preserve exact maintenance manifests and
review each changed path before a separate baseline promotion. Keep prior trusted
databases. An interrupted daily scan is a real coverage gap even when the quick
check stayed healthy; distinguish SIGTERM from a proved timeout or OOM.

Very young `runc:[2:INIT]` processes can expose `/runc` during container exec.
Re-observe that exact transition once after 50 ms for the whole process table.
This is not an allowance: persistent, older or differently named `/runc`
processes remain findings. Preserve executable/identity race checks and test both
legitimate exec completion and a persistent forgery.

For an online SQLite maintenance snapshot, leave the source journal unchanged.
Convert only the newly created snapshot to DELETE journal mode, run integrity
checks, close it and require no WAL/SHM sidecars before copying it out. Refuse a
pre-existing snapshot or sidecar; never delete unknown files or allowlist the
maintenance name. Test the actual helper on isolated synthetic WAL data.

Compare running versions with vendor advisories, repository GHSAs and the CISA known-exploited catalog. An empty product advisory feed does not establish dependency security. Check vendor bulletins that are not published as GHSAs, supported-release lifecycles and distribution backports. Preserve the upstream package/version evidence when assessing a scanner match; a scanner severity alone does not prove an exposed attack path.

If CISA's canonical download is unavailable, use its own
[`cisagov/kev-data` mirror](https://github.com/cisagov/kev-data), which CISA says
normally synchronizes within minutes. Validate count, CVE identifiers and release
time; malformed, future-dated or more than 14-day-old catalogs leave coverage
incomplete. Record which source and catalog release were used. Never replace a
failed feed with an empty catalog.

Repeated image checks may reuse a report for at most 24 hours only when the
immutable image ID, scanner version and verified vulnerability database match.
Use the report's provenance time, not its filesystem modification time. A new
database invalidates every cached report. Re-enumerate running images after the
scan; a deployment race leaves the inventory incomplete until another check.

Keep the last complete image ledger while recording refresh progress and failed
attempts separately. A normal refresh is not lost coverage. Initial inventory is
an explicit setup state, not a clean result; require progress within 20 minutes
and completion within two hours. Failed/stalled scans or a completed inventory
older than 36 hours remain actionable. Never erase known findings because their
replacement scan failed. A failed CISA lookup cannot extend an existing urgent
deadline.

Assess actively exploited issues and public unauthenticated RCEs immediately; patch or isolate within 24 hours. Confirmed applicable critical findings use the same target; other high-severity findings have a 72-hour target. Review routine patches weekly and supported versions monthly. Record first seen, affected resource/package, installed and fixed versions, exposure, owner, due date, action and live verification. Rebuilding the same vulnerable package must not reset its deadline. Keep the full ledger even when email shows only the first findings. Actionable overdue risks get at most one daily reminder; unreviewed scanner matches do not. Any exception needs evidence, compensating controls, a named owner and an expiry.

Local checks cannot reliably report their own disappearance. Send fixed health timestamps and counts to an independently operated monitor using one ping-only credential per host. The monitor needs its own schedule, state and verified delivery path. Alert on missing publishers, stale checks, failed delivery and incomplete scans. Test a missed-run condition and monitor the external monitor's own last sweep/deployment from a separate observer. Root can forge local health, so retain independent probes and off-host evidence as well.

Give each notification one owner. The host watcher owns package findings; the
external monitor checks its coverage and delivery rather than mailing the same
package counts again. Notification identity must ignore image/replica churn and
run timestamps while preserving changed fixes, exploitation status, overdue
transitions and real errors. Retry failed delivery. Keep partial recovery quiet
when no new problem appeared; send one meaningful all-clear when coverage fully
recovers. Delivery tests must be clearly labelled and explicitly requested after
initial setup; a monitor code update does not send another test by default.

AIDE fingerprints exclude only its start/end run timestamps, retaining actual
file timestamps and differences. Relocate maintenance Python bytecode under the
private `/var/cache/hatchkit-security/python` cache through service environment
and administrative SSH commands. Review existing bytecode against authored
source before removing it from the monitored tree. Keep authored-code coverage.
Under the EFI system partition, omit the unstable FAT inode number while
retaining hashes and other metadata. Preserve old AIDE baselines and explicitly
review every difference before accepting an update.

For a maintenance baseline handoff, require the parsed added/removed/changed
paths to match AIDE's summary counts. Compare authored files with the reviewed
source hashes, inspect generated configuration semantically, and investigate
package removals against package-manager history. Preserve generated bytecode
before removing it from the monitored import tree. Record an explicit manifest
hash, reject changes made after review, and check the complete candidate against
the current filesystem before atomically promoting it. Retain the previous
database and run the production checker afterward. This is an operator-reviewed
procedure; never schedule automatic acceptance.

Unreviewed image-package matches go into one nonempty weekly review, after Monday
09:00 Australia/Sydney on the next watcher run. A missed run catches up later in
the same week; successful delivery advances the week, failed delivery retries.
Use readable service-name labels, list at most five rebuild/package candidates
and retain the rest privately. Do not send daily overdue lists or a new email for
routine scanner churn. Preserve original first-seen/deadline history. Migrating an
acknowledged old digest counts as the current week's review without another mail.

For image-package findings, the deadline follows the advisory and package on the
host, independent of image ID, container name and affected package version.
Updating to another version that still matches the same advisory is not
remediation. Keep separate raw version rows, but carry the earliest first-seen
time/deadline and any known-exploited classification when old per-version clocks
merge. A package update must not buy another patch window. Applicability reviews
remain bound to their exact reviewed version/image and execution predicate.

Known-exploited package matches, explicitly reviewed affected internet exposure,
direct runtime/service advisories, failed checks and incomplete coverage bypass
the weekly gate. These remain separate from unreviewed matches; an urgent alert
does not carry the entire raw inventory again. Keep retry and bounded overdue
reminders for actionable findings. Scanner scores and fixed-version suggestions
still need vendor verification; neither counts nor a published fix establish
application reachability. Formatting or deployment churn alone must not resend
an acknowledged alert.

Record narrow applicability assessments with primary evidence, a named owner
and an expiry. The optional root-private `image-assessments.json` binds the
review to exact image/workload/package/advisory identities and revalidates the
supported execution predicate on every run. Raw matches and original deadlines
remain visible. Current reviewed matches leave the unreviewed weekly queue;
expiry or a changed boundary creates an immediate coverage alert. Known
exploitation and explicitly affected internet exposure always bypass the review.
Never grant an indefinite version-wide exception or automatically renew one.

The first supported predicate covers three BusyBox awk/ash script-input flaws
for the fixed, read-only static error-page server. It requires HTML-only,
non-executable content, no CGI/configuration override and the unchanged image
and direct `httpd` command. The [upstream review](https://lists.busybox.net/pipermail/busybox/2026-July/092392.html)
explains the older High scanner metrics and current local Medium/Low CNA
scores. This does not assess unrelated BusyBox/httpd issues or a shell-using
application. Reviews expire within seven days and require new evidence before
renewal. See `cli/src/templates/update-watch/README.md` and the fixture tests.

Use deterministic timers, version/range matching, image scans, policy validation, backups, health checks and rollback for enforcement. An LLM can correlate advisories, assess exposure, prepare patches, review exceptions and escalate deadlines. Treat feed text, logs and repository content as untrusted data. They cannot authorize actions or change the patch policy. Do not give a triage model unrestricted root credentials. App-based LLM schedules also depend on their connected computer/app being available; keep uptime checks and agreed host jobs independent of the Mac.

Use LLM assistance in an operator-requested review. Scheduled or always-on model
review needs separate explicit authorization. The previously created
`vps-security-review` chat heartbeat is paused at the operator's request; do not
resume it or create a replacement scheduled agent as part of maintenance.

An automatic patch runner needs a reviewed allowlist: same supported release line, fixed trusted registries, verified artifacts, no package removals, no database major upgrades or destructive migrations, fresh verified recovery points, one service at a time, functional checks and a bounded rollback. Stop and alert on unexpected versions, changed upstream compatibility code, failed backup/health/rollback, conflicting deployments or an expired exception. Record before/after IDs and results without secrets. Keep built-in updaters enabled until a tested replacement is operating and the operator approves the handover.

Container policy must survive deployment. Start with measured memory/CPU/PID limits, `no-new-privileges`, dropped capabilities, a supported non-root user and a read-only root plus explicit writable volumes/tmpfs. Test migrations, uploads, queues, temporary files and graceful shutdown per service; database entrypoints may need narrowly scoped initialization capabilities. Preserve data ownership. A runtime `docker update` alone does not make a rolling deployment retain its limits. Verify the newly created container after a real redeploy and alert on drift.

Prove the resource rollback command on a disposable container before applying
new limits. Docker can ignore zero memory and NanoCPU values in an update;
`docker update --memory 0 --cpus 0` does not reliably recover an originally
unlimited container. Keep its original configuration and volumes and test a
healthy recreation for that recovery case. Recover ambiguous canonical writes
by comparing only the exact policy values you own, never by overwriting a whole
application record or another deployment's settings.

A setup-option flag is not proof that an application selected a database backend.
Configure the intended backend explicitly in a disposable test, query its actual
schema, and restart initialized data. Include an isolated application restore
from a verified backup on the original host, with no published ports or external
network and private temporary records removed after the containers stop. Where
initialization changes ownership and then changes permissions, test both actions:
`CHOWN` does not replace `FOWNER`. Add only the capability demonstrated necessary.

Test the actual production thread/user settings and native backup capture under
the proposed permissions. A restore-only configuration can accidentally redirect
new backups into its read-only import mount; preserve production's writable backup
location separately. Check configuration bind mounts explicitly: a read-only root
does not override a writable bind. Require the real application to reconnect to
the replacement database and keep functional checks inside the rollback boundary.
Tie permission proof to exact candidate/live IDs and an expiry; a passing test on
another image or an earlier deployment cannot authorize the current rollout.

Keep a rooted `io.hatchkit.security.original-image` reference in both rebuilt
image metadata and canonical service labels. Preserve it across every rebuild;
pointing at another local security image can silently remove upstream advisory
coverage. Recover an uncertain origin from retained snapshots and immutable
layer ancestry before changing it. Missing or conflicting origins must produce
a coverage warning. Image package scanning remains necessary for dependency
coverage even when the upstream product has no advisory feed.

Exercise the actual controller parser in a rolled-back transaction with jobs
suppressed before deployment. Compare component IDs, named data volumes,
environment, ports, pull policy, image identity, labels and permission/resource
settings. Then deploy one component through the normal controller path and
verify the running result plus application/database and backup checks. A parser
probe alone does not establish deployment durability. Retain original-host
configuration snapshots and image anchors for recovery; never copy rendered
credentials between hosts as a shortcut.

Preserve upstream database repository basenames in derived image aliases and
test the controller's classification using the actual service context. An
arbitrary local image name can make the next deployment treat a database as a
different component. Check generated bind modes too: the current service parser
can discard long-form `read_only`. For existing managed files, compare stored
contents with the live hashes before converting only those mounts to supported
short-form `source:target:ro`. Preserve managed-file ownership and contents, and
verify the generated deployment before calling the policy durable.

Expand application CPU/memory controls in small named batches. For each app,
capture multiple memory/process samples and a fresh CPU interval, require tested
headroom, preserve container/image/start/restart identity, and verify health
before and after the update. Persist only fields that the installed controller
supports. Verify native policy values and add explicit replica-aware drift rules.
CPU/memory persistence does not establish PID or permission containment.

Recheck controller capabilities after upstream upgrades. A prior parser defect
may be fixed without a custom controller. The current valid-option fixture can
preserve PID, read-only, tmpfs and no-new-privileges flags while still failing to
reject invalid values; enforce a narrow valid input set and inspect actual
generated Compose plus kernel state. A helper-only parse is insufficient.

For a native app-generation probe, use an uncommitted clone with jobs/events
suppressed and a helper that has no network, daemon socket or host-data mounts.
Compare complete base/candidate Compose with only the explicitly tested control
fields removed from the difference. Filter ORM-computed attributes against the
physical schema before cloning, and compare protected real records from physical
tables. Roll back synthetic rows and remove the helper and its exact new empty
configuration directory. Never call a full deployment merely to test parsing.

Qualify each app image with an isolated production-mode canary, for example
UID 1000, read-only root, cap-drop ALL, no-new-privileges, a PID cap, capped
memory, memory/swap and CPU, and a noexec/nosuid/nodev temporary directory.
Exercise the app's real flows (registration, writes, WebSocket updates,
persistent sessions/data after restart) and denied root writes on synthetic
data. A native same-image deployment then verifies those live permissions,
kernel cgroups, original data files/volumes, read-only integrity/query checks
and unchanged runtime credentials. Each app profile needs its own functional
canary and native deployment proof.

A PostgreSQL/Redis app's canary uses the same tested permission profile and
exercises its authentication, writes, live WebSocket sessions, Redis and restart
persistence, with synthetic data on an internal network and fixtures removed
afterwards. Prove native generation and admission rollback and capture an
original-host database dump and image anchor first. Activate a stronger drift
profile only after a native deployment verifies the same image, original
database identities, kernel controls and durable options, with the canonical
`live` tracking tag intact. These checks do not establish a restored backup.

Keep synthetic clients bounded and match the actual application protocol. Capture
timeout diagnostics privately, close only owned clients, and verify cleanup and
unchanged production identities even on failure. Do not export a timeout's full
command or privileged log. Never bypass a failed admission or freshness guard.

For an image-based app, pin the observed repository manifest for the hardening
deployment while preserving its canonical tracking tag for future releases.
The inspected native rollback flag selects that immutable image; it does not
restore a database or volume. Review the exact installed implementation first.
Require normal idle-queue admission, lock application/server rows, save only the
tested option field, and defer the single native job until the outer transaction
commits. Prove admission rollback before the live request. Record the planned
deployment UUID before submission; inspect ambiguous outcomes instead of retrying.
Capture a fresh online SQLite snapshot, exact runtime/canonical configuration and
an image recovery anchor on the original host. Preserve failed containers during
recovery and reject unknown image/data identities before any write. Keep original
data in place; a configuration rollback must not automatically restore old data.

Compare all original runtime secrets exactly. Permit only explicitly verified
native deployment metadata differences: source/container identifiers and public
default values derived from the controller's canonical model. Compare physical
application/settings rows too; explain managed hashes, timestamps and status
separately. Never export rendered configuration, database snapshots or private
diagnostics through the operator machine.

Review package locations before treating scanner matches as runtime reachability.
An image can contain a separate Undici copy under npm while its
Node runtime reports its own built-in version, or keep frontend build
packages in its final pnpm store. Keep raw matches/deadlines until separately
reviewed or removed by a tested rebuild. Prefer fresh production dependency stages
and omit unused build/package-manager tooling. If startup currently calls npx,
bundle the required locked tool first; deleting it blindly breaks startup.
Rescan exact final image bytes and verify native rollout before closing findings.

Unknown drift-policy fields must fail incomplete rather than silently pass.
Use config schema 2 with newer controls so a stale schema-1-only checker cannot
pretend to enforce them. Keep existing profiles and review checker/policy updates
against the trusted integrity baseline before acceptance.

Prove rollback against synthetic data on the same host before production changes.
Docker ignores zero memory/NanoCPU values in an update: returning to unlimited
settings may require exact original-config recreation. Preserve image, command,
environment, data mounts and health checks, retain a failed production container,
and prove fixture cleanup without touching production. Accept only specifically
reviewed serialization differences; changed mount identity or security settings
must fail recovery checks. Keep measured receipts and original snapshots private
on their host. Do not turn this maintenance procedure into an unreviewed bulk job.

Keep database-only networks internal and separate from public proxy networks. Permit only the application/database pairs that need access; block container access to cloud metadata and host management endpoints. Observe outbound requirements before enforcing an allowlist, including DNS, mail, storage, API callbacks and IPv6. A proxy sharing the database network weakens isolation. A read-only Docker socket mount still permits mutating API calls: remove it where possible or use an authenticated, method/path-restricted discovery API without granting container creation, exec or archive access. Document any management component that still has host-level trust.

Provider metadata requires its own narrow rule before broad established-session
or Docker egress accepts. The prepared `metadata-guard.py` template adds only an
owned, tagged `DOCKER-USER` jump and exact-address drops for `docker0`/`br-*`
forwarding. It preserves host metadata access and other rules. Reject unexpected
ownership, hook ordering, bridge names or backend changes. Prove TCP-only
reachability before/after, exact owned rollback/reapply, app DNS/outbound TLS,
routes and IPv4/IPv6 origin controls before enabling it on another host.

Persist the rule through Docker lifecycle and separately check it on a timer.
Include its oldest status timestamp in the independent heartbeat; a fresh
publisher must not hide a missing guard. Keep credentials unchanged and manually
review authored integrity changes. Protect both address families, but do not
claim an IPv6 datapath test when applications have no IPv6 route. Hetzner's
[hcnet metadata documentation](https://docs.hetzner.com/cloud/technical-details/hcnet/)
lists `169.254.169.254` and `fe80::a9fe:a9fe`. Applying these drops does not require
switching the provider network stack. Broader outbound and database isolation
remain separate controls.

For Traefik's non-Swarm Docker provider, the `docker-discovery` template restricts
requests and redacts environment, commands, mounts, health logs and unrelated
labels. Put it on a dedicated internal network with Traefik only, require a
unique service-local credential, publish no port and run the broker rootless
with a read-only root, no capabilities, no-new-privileges and tested resource
limits. Routing labels can still carry sensitive values; preserve network and
authentication boundaries. The broker itself retains daemon trust.

Before removing a production socket, prove discovery/events, idle renewal,
restart recovery, secret redaction and denial from an app network using the
actual Traefik image. Preserve existing TLS, ports, app routes and image bytes.
Persist changes through the native deployment configuration, keep private
original-host recovery state and test the local image pull policy. A normal
saved-config restart and forced default regeneration have different behavior:
regeneration needs review because it can remove the broker and restore a socket.

Monitor explicit reviewed container controls every five minutes. Check limits,
kernel no-new-privileges, runtime UID, health, mounts, networks, Docker endpoint
and socket absence as applicable. Never learn a policy from the current running
fleet automatically. Combine its freshness with the process heartbeat using the
older timestamp; missing control checks must trigger lost coverage externally.
Transmit fixed counts/booleans/timestamps only and preserve publisher credentials.

Include pending host distribution packages in advisory coverage. Refresh APT
metadata with TLS/signature checks intact. On refresh failure, retain at most
64 KiB of diagnostic output in the host's root-private
`host-package-refresh.private.log` (0600). Reports may include only an allowlisted
failure category and fixed repair hint: certificate verification, signing,
DNS, connection, lock contention, timeout, execution or unknown. Repository URLs
and raw output can contain credentials; never copy them into email or heartbeat
payloads. A successful later refresh clears the active failure category while
leaving the last private failure diagnostic available for review. This does not
make an incomplete advisory check healthy or reset a finding deadline.

Refresh APT
indexes with authentication errors treated as failures, a bounded timeout and
no package installation or service restart. Inspect all available trusted Ubuntu
security-pocket versions; a newer updates candidate or a pinned candidate must
not hide a security fix. A failed refresh, absent trusted security source or
refresh proof older than eight hours is incomplete coverage. The watcher uses
high review priority for these pending fixes and a 72-hour deadline; this is not
a CVE severity claim. Correlate vendor advisories and exposure separately, and
apply the 24-hour patch-or-isolate target when exploitation/public RCE applies.
The four-hour host timer stays unchanged. Repeated scheduled/manual checks reuse
successful public GitHub responses for at most one hour, retaining their actual
retrieval timestamps in report metadata. Cache use never renews those timestamps;
expired, future-dated, malformed or unsafe files force a new read. Failed reads
never become successful cache entries. Keep no more than 64 response files of
1 MiB each in the root-private cache. `update-watch.py check --fresh-feeds` skips
positive cache reads for a specific new disclosure, while still respecting an
API-reported primary rate-limit reset. Persist that backoff across process runs;
do not repeatedly probe other repositories after the address reaches its quota.
Missing or expired feed data remains incomplete coverage until a real successful
read. The cache adds no credential or alternate network identity.
The read-only scan command never refreshes indexes. Preserve normal package
phasing and resolve dependency changes in the reviewed maintenance step.

Both proxy rollouts passed real canaries and native restarts with unchanged
Traefik image bytes, application routes/TLS, ports and data mounts. Their brokers
have isolated internal networks, authentication, redaction and tested
128 MiB/0.5 CPU/64-PID containment. Eight shared and thirteen dedicated reviewed
profiles feed external freshness monitoring. Profiles cover different tested
controls; a CPU/memory-only app profile does not establish PID or permission
containment. Sentinel and the restricted brokers still hold daemon trust, and
containers without an explicit reviewed policy remain outside these checks.

Keep repository manifest digests separate from image configuration IDs when
pinning a proxy. Verify that the inspected manifest resolves locally to the
exact image running before the change. Probe the application's actual public
route, including required RPC prefixes; an unrouted container health path must
not trigger a proxy restart. Existing Python or Node applications can provide
the negative network-access probe without installing another runtime in them.

Compare saved proxy tags with the actual original runtime during recovery
preparation. A stale saved tag must not downgrade a rollback. Retain the original
canonical bytes, then pin the recovery variant to the observed immutable image
with `pull_policy: never`. Verify target resolution, private Compose parsing and
explicit pull skipping without starting the service. Private recovery YAML stays
on its controller host. Recovery remains usable after scan/canary expiry, while
concurrent canonical or controller changes still require review.

Retain private transaction records on the original controller host outside its
container, with mode 0600 and immutable hash-addressed versions. Container-local
files can disappear on replacement. If an old record is missing, require the
original backup bytes to match the recorded pre-change hash, prove the current
canonical hash and exact runtime images unchanged, and label the reconstruction.
Do not invent missing historical timestamps or transfer private configuration
through an operator machine. Reconstructing a record must not start services or
change live canonical configuration.

Inspect native restart side effects as well as Compose services. The installed
controller can create `coolify-proxy-error-pages` outside Compose for static
error/maintenance pages. Account for this exact component explicitly and keep
rejecting unrelated container changes. Verify its image, command, read-only
`/www` mount, no public ports/socket and actual static response before bounding
it. The tested resource profile is 128 MiB memory, 256 MiB combined memory/swap,
0.25 CPU and 64 PIDs; `error-pages-policy.example.json` records these checks.
The separately tested permission extension adds read-only root, no capabilities
and no-new-privileges while retaining the root user. The example includes these
controls and an explicit read-only HTML-bind requirement; use it only after a
same-host compatibility canary. Docker retains resource updates across restarts,
and native setup starts an existing helper. Deleting/recreating it can restore
upstream defaults; keep drift alerts and review that lifecycle in controller
compatibility work.

Close incident credentials at their issuer: removing an environment variable does not revoke an OAuth client secret, mail API key or controller token. Identify the exact credential and dependent clients, create/test the replacement, then revoke the old credential and verify rejection. Keep provider account audit evidence and original incident artifacts. Never print credential values into the patch ledger.

For a Go service dependency rebuild, pin the existing application commit and a
supported patched Go builder by digest. Verify the actual dependency versions
embedded in the resulting binary, test with the build network disabled, preserve
embedded frontend assets, update final-image packages and scan the exact final
image. A scanner's suggested fix floor can lag vendor guidance; Listmonk's
24 October rebuild required [Echo 4.15.4](https://github.com/labstack/echo/security/advisories/GHSA-vfp3-v2gw-7wfq), rather than the earlier reported 4.15.3.
Use synthetic isolated data to exercise authentication, image processing,
uploads, deletion and restart recovery before touching the production volume.

Listmonk's tested runtime profile is 1 GiB memory, 1.25 GiB combined memory/swap,
one CPU, 128 PIDs, read-only root, a 32 MiB temporary directory, no capabilities
and `no-new-privileges`. Its existing root user remains because uploads are
root-owned; this does not establish a non-root deployment. The reusable
`cli/src/templates/docker-discovery/listmonk-runtime.compose.yml` fragment and
`listmonk-policy.example.json` are review inputs, never automatically applied.
Replace the example selector, confirm actual mount destinations and user, merge
the rule into the existing policy and test with the real service configuration.
Do not overwrite other reviewed profiles or change upload ownership implicitly.

For Plausible, preserve the exact application commit, locked dependencies and
embedded frontend while rebuilding with patched Elixir/Erlang runtimes. Verify
precompiled native artifacts against the locked package's checksums and compile
with the network disabled. Exercise PostgreSQL and ClickHouse queries, database
setup, MJML rendering, HTML parsing, frontend redirects and restart recovery on
isolated synthetic data. Follow redirects only within that fixture's origin.

The tested proxy-TLS deployment uses UID 999, 1 GiB memory, 1.25 GiB combined
memory/swap, one CPU, 256 PIDs, read-only root, a 64 MiB temporary directory,
no capabilities and `no-new-privileges`. Its unused built-in certificate tooling
was removed only after runtime proof that built-in HTTPS and SiteEncrypt were
disabled. A wrapper rejects either an `HTTPS_PORT` environment value or secret
file. Keep the explicit existing startup command; enabling built-in TLS requires
a separately tested image. The reusable `plausible-runtime.compose.yml` and
`plausible-policy.example.json` fragments live beside the Listmonk templates.

Inventory anonymous Docker volumes before redeploying. Bind the existing
Plausible data volume explicitly as an external volume by its verified name;
absence must fail rather than create an empty replacement. Validate the resolved
generated app and database environment, commands, immutable image identities and
all data volumes on their original host before starting. Rendered credentials
stay there; only fixed proof fields and hashes pass to the controller. Preserve
native database image naming because the controller uses it to classify
components. If a local tag is missing, verify its exact running image identity
before restoring that alias; never substitute an unrelated image or restart the
database to repair a tag.

Exercise the controller parser in a rolled-back transaction with jobs suppressed
and compare component IDs, volume identities, existing environment values,
commands, health checks, ports and routing. Permit controller metadata additions
only when exact names and values match the installed generator. Validate the
actual generated deployment file with `docker compose config --quiet` before
starting the component: a valid YAML roundtrip alone does not prove Compose
accepts its types. In particular, omit an empty `cap_add` field when a serializer
would emit an object. Keep `cap_drop: [ALL]` and verify zero effective kernel
capabilities afterward. Retain the old image and private database/upload recovery
points; restore canonical configuration and the exact original runtime on
failure. Recovery must remain available after scan/canary freshness expires.

Use `hatchkit-host-integrity-quick.service` for the bounded process check after
maintenance, followed by `hatchkit-file-integrity.service` for production AIDE,
the container-policy check and the health publisher. The daily
`hatchkit-host-integrity.service` deliberately samples CPU and outbound peers for
an hour; it is not a quick post-deployment check. Preserve its scheduled timer
and previous complete findings when correcting a mistaken manual invocation.

For a controller operator token, preserve the intended owner, team, permissions
and expiry during an equivalent rotation. Store the replacement in the normal
operator credential store, read it back, and test a real authenticated endpoint
before revoking the exact old token. Verify the old token receives an
authentication rejection and the replacement still works. Keep operator tokens
off application hosts and CI; use one application's deploy webhook for CI.
Interrupted rotations must stop safely: retain the old credential until storage
verification succeeds, prevent duplicate issuance, and remove any temporary
plaintext recovery credential once the verified replacement is stored. A denied
credential-store request stops the operation without a different access route.

Source templates: `cli/src/templates/update-watch`, `file-integrity`, `security-controller` and `backups`; Ansible's `file_integrity` role; and `infra/coolify-runtime` compatibility tests. Review every upstream Coolify change before relying on its custom Docker option parser: unsupported or truncated options must not be silently accepted as persistent containment.

---

## Emergency recovery

### "I locked myself out of SSH"

1. **Hetzner web console:** Cloud Console → Server → Console (VNC). Gives you a terminal directly on the VM, bypassing SSH entirely.
2. **Hetzner rescue mode:** Boot into a rescue system, mount your disk, fix `/etc/ssh/sshd_config` or `/etc/ufw/user.rules`.
3. **Hetzner API:** `hcloud server reset <id>` if the server is hung.

### "fail2ban banned my IP"

```bash
# From Hetzner console or a different IP:
fail2ban-client set sshd unbanip <your-ip>

# Or temporarily stop fail2ban:
systemctl stop fail2ban
# Fix the issue, then restart
systemctl start fail2ban
```

### "Tailscale is down and SSH is restricted to tailnet"

```bash
# Work inside Hetzner's authenticated web console. Keep public SSH closed.
systemctl status tailscaled
journalctl -u tailscaled -n 100
# Repair its package/configuration or restore the preceding verified version.
# Verify a fresh SSH connection over the tailnet before leaving the console.
```

### "Unattended upgrades broke something"

```bash
# Check what was upgraded:
cat /var/log/unattended-upgrades/unattended-upgrades.log

# Downgrade a specific package:
apt install <package>=<version>

# Disable auto-reboot temporarily:
echo 'Unattended-Upgrade::Automatic-Reboot "false";' > /etc/apt/apt.conf.d/99-no-reboot
```

---

## Hardening checklist

Use this to verify your server after manual setup or to audit an existing server:

```
Tier 1:
[ ] Non-root user created with SSH key
[ ] Root login disabled (PermitRootLogin no)
[ ] Password auth disabled (PasswordAuthentication no)
[ ] SSH restricted to specific users (AllowUsers)
[ ] SSH crypto restricted to modern algorithms
[ ] Hetzner Cloud Firewall active (22, 80, 443 only)
[ ] UFW enabled with default deny incoming
[ ] fail2ban running and configured for SSH
[ ] Unattended upgrades enabled with auto-reboot
[ ] Unused services disabled (snapd, etc.)

Tier 2:
[ ] Tailscale installed and SSH restricted to tailnet
[ ] sysctl hardening applied (network + kernel)
[ ] Docker ports bound to 127.0.0.1 (not 0.0.0.0)
[ ] Swap configured (2GB, swappiness=10)
[ ] /tmp, /dev/shm mounted with noexec,nosuid,nodev
[ ] Core dumps disabled (sysctl + limits + systemd)
[ ] Umask set to 027 in /etc/login.defs
[ ] Time synchronization verified (timedatectl status)
[ ] No Coolify bootstrap ports open (after setup)

Audit (run periodically):
[ ] Lynis audit score > 75 (lynis audit system)
[ ] No unexpected SUID binaries (find / -perm -4000)
[ ] No world-writable files outside /tmp (find / -perm -o+w)
[ ] fail2ban has no false-positive bans on your IP
[ ] Backups exist and have been test-restored
```

---

## Sources

This guide synthesizes recommendations from:

- [Burak Eregar — Secure VPS Setup Gist](https://gist.github.com/burakeregar/5b8a7bca382ae43342db30f3c04788fc)
- [How To Secure A Linux Server (imthenachoman)](https://github.com/imthenachoman/How-To-Secure-A-Linux-Server)
- [Linux Hardening Guide (vez.mrsk.me)](https://vez.mrsk.me/linux-hardening)
- [Mo Abukar — Hetzner VPS Terraform Security Hardening](https://moabukar.medium.com/running-clawdbot-24-7-on-a-hetzner-vps-terraform-security-hardening-and-the-bits-the-docs-miss-096d3bcf7a37)
- [r/hetzner — How to make your VPS secure](https://www.reddit.com/r/hetzner/comments/1mcci3m/how_to_make_your_vps_secure/)
- [Hetzner Community — Security Ubuntu Settings](https://community.hetzner.com/tutorials/security-ubuntu-settings-firewall-tools/)

---

## Learning Resources

Curated reading for building a deeper understanding of Linux security. Organized from "start here" to "go deeper."

### Start here — the best comprehensive guides

These are the ones to read end-to-end if you're new to server hardening:

| Resource | Why it's great |
|----------|---------------|
| [How To Secure A Linux Server (imthenachoman)](https://github.com/imthenachoman/How-To-Secure-A-Linux-Server) | The most complete open-source hardening guide. Covers everything from SSH to kernel hardening to intrusion detection. Well-maintained, community-reviewed. |
| [Linux Hardening Guide (Madaidan's Insecurities)](https://madaidans-insecurities.github.io/guides/linux-hardening.html) | The most opinionated and technically deep guide. Written by a Whonix security researcher. Covers kernel parameters, sandboxing, memory allocators, and things other guides skip. |
| [ArchWiki: Security](https://wiki.archlinux.org/title/Security) | The ArchWiki is legendary for a reason. This page links to hardening guides for every subsystem (SSH, firewall, kernel, AppArmor, disk encryption). Distribution-agnostic despite the name. |
| [Linux Hardening Guide (vez.mrsk.me)](https://vez.mrsk.me/linux-hardening) | Practical and concise. Great sysctl reference with copy-paste configs. |

### Understand the fundamentals

These explain the "why" and "how" behind the tools:

**Networking & Firewalls:**
- [A Deep Dive into iptables and Netfilter Architecture (DigitalOcean)](https://www.digitalocean.com/community/tutorials/a-deep-dive-into-iptables-and-netfilter-architecture) — if you read one thing about Linux firewalls, make it this. Explains chains, tables, hooks, and packet flow with clear diagrams.
- [How Tailscale Works](https://tailscale.com/blog/how-tailscale-works) — one of the best technical blog posts on the internet. Covers WireGuard, NAT traversal, DERP relays, and mesh networking. Beautifully illustrated.
- [WireGuard whitepaper](https://www.wireguard.com/papers/wireguard.pdf) — the original paper (~16 pages). Explains the Noise protocol framework and why WireGuard has such a small attack surface.

**SSH & Cryptography:**
- [ssh-audit hardening guides](https://www.sshaudit.com/hardening_guides.html) — generates algorithm configs for your exact OpenSSH version. The gold standard.
- [OpenSSH: Post-Quantum Cryptography](https://www.openssh.org/pq.html) — why SSH now uses hybrid post-quantum key exchange by default.
- [Curve25519 paper (Daniel J. Bernstein)](https://cr.yp.to/ecdh/curve25519-20060209.pdf) — the math behind Ed25519, X25519, and modern SSH/TLS. More approachable than you'd expect.

**Kernel & Memory:**
- [Kernel Self Protection Project](https://kernsec.org/wiki/index.php/Kernel_Self_Protection_Project) — the Linux kernel's own initiative to reduce attack surface. Documents the design rationale behind hardening features.
- [ASLR — Ubuntu Security Docs](https://documentation.ubuntu.com/security/security-features/process-memory/aslr/) — how ASLR works in Linux and what `mmap_rnd_bits` controls.
- [Google: Learnings from kCTF VRP (io_uring)](https://security.googleblog.com/2023/06/learnings-from-kctf-vrps-42-linux.html) — data-driven analysis of why io_uring is a vulnerability goldmine.

### Industry standards & compliance

If you want to understand how enterprises approach hardening:

- [CIS Benchmarks for Ubuntu](https://www.cisecurity.org/benchmark/ubuntu_linux) — the industry-standard hardening checklist. Free PDF download (requires registration). Level 1 is practical; Level 2 is paranoid. Our guide implements most of Level 1.
- [Ubuntu Security Guide (USG)](https://ubuntu.com/security/certifications/docs/usg/cis) — Canonical's automated CIS compliance tool for Ubuntu Pro. Shows what "enterprise hardening" looks like.
- [NIST National Vulnerability Database](https://nvd.nist.gov/) — where CVEs live. Search for any package name to see its vulnerability history.

### Go deeper — security research & internals

For when you want to understand the attack side:

- [Linux (in)security (Madaidan)](https://madaidans-insecurities.github.io/linux.html) — a frank assessment of Linux's security weaknesses compared to other OSes. Eye-opening even if you disagree with the conclusions.
- [Docker and UFW security flaw (GitHub #690)](https://github.com/docker/for-linux/issues/690) — the canonical issue thread from 2019. Hundreds of comments documenting the Docker/UFW bypass.
- [BBR congestion control (Google Research)](https://research.google/pubs/bbr-congestion-based-congestion-control/) — the paper behind TCP BBR; explains why it outperforms CUBIC.
- [RFC 1337: TIME-WAIT Assassination](https://www.rfc-editor.org/rfc/rfc1337) — the TCP attack that `tcp_rfc1337=1` prevents. Short and readable.

### Trusted reference sites

Bookmark these — they're consistently high-quality for Linux sysadmin topics:

| Site | What makes it great |
|------|-------------------|
| [ArchWiki](https://wiki.archlinux.org/) | The best Linux documentation on the internet. Community-maintained, distro-agnostic in practice, incredibly thorough. |
| [DigitalOcean Community Tutorials](https://www.digitalocean.com/community/tutorials) | Well-edited, step-by-step server administration guides. Consistently excellent. |
| [nixCraft](https://www.cyberciti.biz/) | Running since 2002. Battle-tested sysadmin guides with a security focus. |
| [Linux Audit](https://linux-audit.com/) | Focused specifically on Linux security auditing and hardening. |
| [Tailscale Blog](https://tailscale.com/blog) | Exceptionally well-written technical posts on networking, NAT, DNS, and VPN architecture. |
| [Cloudflare Learning Center](https://www.cloudflare.com/learning/) | Clear, visual explanations of networking and security concepts (DDoS, DNS, TLS, etc.). Great for building mental models. |

### Proxy access to databases when the native parser joins shared networks

Inspect the installed generator before relying on a network split. The current
native service parser adds its resource network back to each component; simply
adding an internal backend network does not remove that shared path. A compatible
host guard can deny direct proxy-to-database traffic while the full split is
prepared. Explicitly select database names; never infer a permit policy from the
current fleet.

The tested guard hooks each actual proxy host-veth ingress with its own nftables
netdev table and drops IP traffic to the selected database addresses. Test on an
internal synthetic network, including undo/reapply and proxy replacement. Verify
application connectivity and real routes after applying to production. Match the
kernel ingress device so packet source-address spoofing cannot bypass the direct
access rule. Do not claim this prevents Layer 2 ARP spoofing or substitutes for
removing unnecessary raw-socket capabilities.

Same-bridge traffic can bypass iptables forwarding when bridge netfilter is not
enabled. Test the real path; do not enable a global bridge filtering switch just
to make an untested rule appear effective. Verify nft's device binding in native
output when an older JSON renderer omits it. Kernel deletion of a lost veth's
chains is an exact lifecycle case, not permission to accept other firewall drift.
A five-second poll plus command latency, and a 30-second restart backoff after a
failed cycle, leave a convergence window. Missing
containers, failed reconciliation and stale checks remain externally visible.
Retain original-host recovery evidence and review authored source/config/units
against the trusted AIDE database before separate promotion. Never export runtime
credentials or rendered deployment configuration for this procedure.

### Native proxy permission rollout

Use the exact running image for a synthetic proxy canary. Test real ports 80/443,
certificate-verified TLS with a synthetic CA/certificate, routing, discovery
start/die events, idle streams and cold recovery. Prove zero effective/bounding
capabilities and kernel no-new-privileges. The tested 512 MiB memory, 768 MiB
combined memory/swap, one CPU, 128 PIDs, read-only root and restricted 16 MiB tmpfs
are a starting profile that still requires current same-host sizing. A short
maintenance sample does not replace monitoring future demand and latency.

Prepare the entire native candidate and preserve every unrelated configuration
field. Validate the generated Compose without starting services. Keep the
controller image/native action identity, submission intent and private original
configuration; inspect ambiguous outcomes instead of dispatching twice. Finish
the owned activity before recovery. Verify original image/data/mounts, credentials,
commands, routing labels, TLS identities, companion permissions and unrelated
application identities after the native restart. Use the current certificate/data
state for recovery; a configuration rollback must not restore an old database.

Writable bind mounts remain writable under a read-only container root. Narrow
proxy configuration and certificate write access separately, with a tested
renewal/recovery path. Preserving a compatible existing data mount is not proof
that this remaining host-filesystem boundary is closed.


#### Native static error-page helper

A native proxy start can create `coolify-proxy-error-pages` outside Compose.
Inspect the installed controller's `setupProxyErrorPageContainer` method before
allowing this side effect. Admit only its exact reviewed image, static HTTP
command, isolated `coolify` network and read-only `/www` bind. Require an
administrator-owned HTML-only directory without CGI, executable files or HTTP
configuration overrides. A renamed image is not sufficient evidence.

The tested shared-host profile uses 128 MiB memory, 256 MiB combined memory/swap,
0.25 CPU, 64 PIDs, read-only root, no capabilities and no-new-privileges. Test
HTTP on actual port 80 and restart using synthetic HTML, then test the real
proxy-to-helper route. Preserve the original helper until recovery is checked;
disable its restart policy while it is stopped. Verify unrelated workloads do
not restart. Review each host's exact image independently.

Normal native setup starts an existing helper and preserves these controls.
Deletion/recreation can restore the controller's unsafe defaults. Call the real
native setup once after hardening and verify unchanged container identity,
start/restart counters, static content and kernel controls. Do not claim
controller-wide enforcement. Drift monitoring must require both the reviewed
image and the HTML bind's actual read-only flag; a read-only container root
alone does not protect a writable bind. `readOnlyMountDestinations` expresses
that separate requirement and rejects missing or writable mount metadata.

Record the extra image in final-image advisory coverage. A functional static
page canary proves compatibility; it does not clear package advisories or justify
copying an exception from a different BusyBox image. Retain original deadlines
until the new image has its own scan and vendor applicability review.


A capability-free root process still obeys filesystem permissions. Inspect the
ownership and access ACLs on every mount root and traversed directory before a
proxy rollout. A synthetic TLS canary with a root-owned fixture does not cover
a production directory owned by another UID with mode 0700. Reproduce that
ownership/mode in the synthetic fixture, prove access fails before the proposed
fix, then retest real TLS and cold recovery after it. Where compatible, a named
UID-0 read/traverse ACL on two explicit directories avoids restoring broad DAC
capabilities or changing owner/group/other access. It grants no directory write
permission. Verify the exact ACL after the native restart and retain its prior
form for recovery. Check later controller operations for permission resets.


### Diagnose independent coverage alerts

A successful publisher service means its HTTP request completed or was deferred
by rate limiting. Check the actual health metadata before claiming every check
is healthy. The aggregated process check includes the quick process snapshot
and each explicitly required container/network guard; an incomplete aggregate
does not identify its failing component by itself.

Keep root-private local delivery receipts with the exact fixed health metadata
and the separately summarized required components. Preserve only timestamps,
booleans, counts, bounded error types and fixed coverage-reason codes. Exclude
container names, commands, file content, application records and credentials.
The receipt history keeps 48 recent attempts and separately retains 16 recent
attention samples through later healthy runs, under a 1 MiB bound. Record intent
before sending and distinguish accepted, rate-limited and failed delivery.
Serialize writers, atomically replace mode-0600 history, and fail visibly on
malformed or oversized history. Do not silently reset evidence.

`/var/lib/hatchkit-backups/health-publisher-history.json` supports attribution of
future incomplete alerts; it cannot reconstruct missing historical snapshots.
It does not change remote alert rules, establish a maintenance exemption or
clear vulnerability findings. Use the normal heartbeat after a code-only update,
with exact metadata equivalence and unchanged credential/unit metadata. Review
the authored source and parent timestamps against trusted AIDE hashes before
separate baseline promotion. Diagnostic Python imports must keep bytecode in
`/var/cache/hatchkit-security/python`, outside monitored source directories.


### Lock startup tools into the image

A patched Node executable does not update npm's bundled dependencies or an
application's separate Undici copy. Inspect actual package paths and the built-in
`process.versions.undici` separately. A newer npm release can still carry a
vulnerable dependency; do not treat the latest CLI version as proof of remediation.
For the October Undici content-encoding denial of service, upstream patched
6.29.1, 7.30.1 and 8.12.2; select the compatible branch for each actual package.
[Upstream advisory](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c).

Generic server templates now run the locked production dependency's local
`dotenvx` binary with explicit `.env.production`, at build and runtime. They do
not download a CLI through `npx` or `pnpm dlx` at startup. Require
`@dotenvx/dotenvx` in the server package's production dependencies and its frozen
lockfile; fail the build if the deployed production bundle lacks its executable.
Keep the server's own working directory for build-time decryption. Existing
operator-provided environment values retain precedence. These template changes
require rebuilding an application before affecting its running container.

The legacy standalone Node template defaults to 24.22.1 instead of Node 20.
Revisit that pinned default when vendor security floors change. Update and scan
both build and runtime stages. Keep unused package-manager/development tooling
out of a runtime only after proving the app, maintenance tools and deployment
path do not require it; preserve a working rollback and inspect the final image.

### Test the actual database backend before image replacement

A healthy web page or an empty SQLite fixture does not validate an application
using embedded MariaDB. Confirm the deployed backend and runtime version. A
logical import into a fresh database proves recovery, but does not test the old
system tables that an image replacement will encounter.

For a same-branch MariaDB patch, first verify the normal registered backup. If
a physical test copy is needed, stop only that application cleanly, copy its
data on the original host, and restart the original immutable container ID in a
failure-safe recovery path. Keep the outage bounded and verify its original
image, configuration, volume and health. Never copy a running raw InnoDB
directory and call it a consistent snapshot.
For an embedded database, PID-1 exit alone is insufficient evidence of a clean
database shutdown. Use its synchronous administrative shutdown and confirm the
database process exited. A recovery handler must also handle a still-running app
whose database is down; merely calling `docker start` cannot recover that state.
Freeze only that container's restart policy during the capture so a database
client error cannot restart its writer while files are copied. Recover the exact
original policy even on interruption, and retain stopped-state diagnostics.
Node's exit status after intentional SQL shutdown does not replace database
shutdown proof. Verify the entire capture/recovery procedure on disposable data
before using it against production.
Keep an unused candidate image referenced until validation and deployment finish;
routine image cleanup can remove it while canaries are being prepared. An
unstarted, offline `/bin/true` container with a read-only root, no capabilities
and small resource limits can hold that immutable ID. Verify the anchor and image
again before changing deployment configuration. Preserve failed attempt evidence;
if rebuilding is necessary, rescan the new final ID and reuse a still-valid data
snapshot rather than stopping production merely to repeat a failed image lookup.
An image anchor is not deletion-protected backup history.

Run the physical copy with no network or published ports and explicit resource
limits. Verify the original database can read it, then start the candidate on
that same copy, check tables and real numeric checksums, restart it and exercise
the app's required browser engine. If image rollback is part of the recovery
plan, test the old image against the upgraded copy itself. An untouched old copy
does not prove that path. This test does not authorize a database major downgrade
or automatic restoration of old production data. Retain private diagnostics
before removing owned fixtures; remove disposable records on the original host.

Run a physical canary before a native database replacement, as for Uptime Kuma.
The controller and service may be on different hosts: keep private canonical
YAML on the controller and private data/runtime snapshots on the service host.
Only hashes, immutable IDs and result metadata need to cross that boundary.
After a successful physical test, take a fresh normal registered backup, stop
SQL synchronously and deploy only that component through its native path.
Verify exact image bytes, original data volume, runtime controls, restart policy,
networks, ports, existing environment values, database binding and application
functions. Current Coolify versions can add their four default location metadata
variables during parsing. Require an exact match to the controller's own default
values; never use that behavior to permit arbitrary environment drift.

Prepare rollback before replacing production. A database image rollback needs a
fresh SQL-clean stopped-candidate proof, exact volume identity and a tested
compatible old image. Restore only the qualified canonical configuration and
reuse the current data; do not silently roll production data back to a snapshot.
Keep original-image and candidate anchors until postchecks finish. Re-run the
normal image scan and watcher afterward; continuing advisory/package clocks must
keep their original deadlines across package-version changes.

### Add app PID limits without changing the rest of the runtime

Measure both current tasks and the cgroup's lifetime PID peak. Existing lower
limits stay in place; a 512-PID starting limit needs ample measured headroom and
application checks. Before applying it, exercise the real native Compose
generator on an uncommitted clone. Preserve existing run options and require an
exact hash match before appending the PID option. The generated configuration
must differ only by `pids_limit`; suppress jobs/events and roll back clone rows.
A generator's scratch helper may need Bash even when the deployed image does
not. Use a qualified isolated helper while keeping the app's immutable image
reference in the generated Compose. Never install a shell into production merely
to satisfy that helper.

Prove enforcement with a capped, offline fixture using the actual app image and
synthetic processes: fork attempts must receive EAGAIN and increment the kernel
PID-denial counter. Give it no production credentials, mounts, ports or network.
Retain failure diagnostics before removing it. Then persist only the custom PID
option and update that same running container, one app at a time. Verify its
kernel limit, unchanged image/data/configuration/start time, health, and zero new
PID denials. Keep exact owned-value recovery for both canonical options and the
runtime cap; restoring an unset limit may use Docker's equivalent `-1` unlimited
value. Refuse to overwrite concurrent changes. Add drift checks only after the
actual live profiles pass, and separately review their exact integrity diff.

New app Compose templates set `pids_limit: 512` for the app/server/client services.
This bounds process/thread exhaustion; memory, CPU, privileges, writable paths
and network boundaries still need their own tested profiles.

### Review database egress before enforcing destination limits

Inspect actual replication, foreign servers, remote storage, distributed tables,
dictionary definitions and loaded modules before denying database destinations.
Counts alone do not establish an outbound requirement: ClickHouse dictionaries
can query the same local server, and Valkey 9.1 includes a built-in Lua module.
Bind any exception review to exact definitions, versions and image bytes. Keep
query details and credentials on the original host; read catalog metadata rather
than application records. A host observer can inspect the server behind Tini
without adding ptrace privileges to the container.

The prepared `database-egress.py` template permits only explicitly named app
peer IPv4 destinations on each database's host veth. It preserves ARP and drops
other destinations and protocols, including IPv6. This is destination control;
it does not establish Layer 2 separation or stateful transport filtering. Review
dual-stack database needs separately before enabling them. Missing peers lose
their permission and make coverage incomplete until rediscovered. Reconciliation
runs every five seconds; unexpected failures use the service's restart backoff.
Do not claim atomic isolation during topology changes.

Before live use, prove allowed and denied endpoints on an isolated network,
including missing peers and database replacement. The canary must
remove its fixtures and leave the existing production firewall unchanged. Live installation is a separate step: refresh feature and
topology checks, retain exact original files, prepare owned-table rollback, test
real app/database paths and backups, and review the precise integrity diff.

The dated `install-database-egress.py` admits only the exact bundle, prior
publisher/base guard bytes and reviewed baseline. Feature and network receipts
must be less than 20 minutes old and bind the actual guard source hashes. Its
live fixture has no published port, host bind or credentials. All seven reviewed
app/database TCP paths must pass; all five database paths to the unrelated
fixture must fail after activation. The fixture handles ordinary socket resets
so short TCP probes cannot terminate it. Failed attempts and cleanup receipts
remain on the original host.

Recovery stops only the new units, verifies the current table against recorded
owned rules (including exact device-loss subtraction), removes that table and
restores only the original publisher/authored paths. It must refuse unexplained
firewall or source drift. It never accepts an AIDE baseline. The separate scoped
review checks publisher SHA-256 and SHA-512 against the trusted baseline, exact
new payloads and enable links, and only explained parent-directory metadata.

When activated, require its status in the existing external heartbeat with
`HATCHKIT_DATABASE_EGRESS_REQUIRED=1`. Missing, failed or stopped reporting must
make the combined process check incomplete/unhealthy; retain the oldest component
timestamp. Export fixed health metadata only, never destination lists or raw
diagnostics. The source template is prepared; it is not activated on a host merely
because it exists in a scaffold.
An actual fresh-data shutdown/recovery test has passed for Kuma, including the
app-running/database-down case. The private host parent remains 0700; an explicit
0755 container bind root lets MariaDB's node UID traverse it despite umask 0077.
Keep that distinction in disposable fixtures and retain failed-attempt evidence.

ClickHouse backup credentials must enter the container through stdin into an
XML-escaped, mode-0600 temporary client configuration, removed by an exit trap.
Never expand runtime passwords into shell or client process arguments. The
registered native-capture validation can run entirely on the original VPS when
external upload is not authorized. Preserve registration scope: an unregistered
cache is not silently added to rolling backups. SQL/ZIP capture checks establish
backup compatibility; they do not replace the separate restore drills.

An exact-image canary for an app with a SQLite volume can qualify a read-only
root, empty capability bounding set, no-new-privileges and a capped noexec
`/tmp`, with the existing SQLite volume writable. Check API readiness, the app's
own functions, SQLite integrity and synthetic restart persistence. Production
verification must preserve the original volume/device/inode and database identity;
never use an older database restore to undo a permissions change. If a native
deployment records a tracking tag other than `live`, preserve that exact tag
while selecting current immutable image bytes. Do not change release channels
to satisfy a generic guard. The template fragment remains opt-in and needs each
app's own functional/writable-path proof, especially Next.js caches and assets.

For a reviewed Next standalone image, `/app/.next/cache` is a separate 128 MiB
UID-1000 noexec/nosuid/nodev tmpfs; `/tmp` remains capped at 64 MiB. Existing
persistent asset exports stay on their original writable volume. The disconnected
canary exercises the real entrypoint and dotenvx command with synthetic runtime
values and public image exports. It tests pages, publication, retained static
bytes/ranges, mixed-release RSC rejection and restart identity. This proves that
specific layout, not every Next app's ISR or upload behavior. Preserve exact
asset-store inode/manifest/head and runtime credentials through native rollout.
Snapshot recovery stays on the original host; configuration rollback must not
replace the store with an older snapshot.

A Mongo/Redis game's permission canary runs its exact application, MongoDB and Redis images on
an isolated internal network with fresh synthetic data. It exercises guest
authentication, game creation, authenticated WebSocket snapshots, native preview
rendering and game/session persistence across an app restart. Keep its measured
512-PID limit rather than reusing another app's 256-PID profile. Read-only root,
empty capability bounding set and no-new-privileges are separate kernel checks.
The original-host preflight captures only the already-registered Mongo source
through the existing native backup function, validates gzip integrity and starts
no upload; it does not claim a new restore drill.

A failed native submission is ambiguous until audited. Inspect its exact queue,
current canonical fields, runtime/configuration and settings before any retry.
A stale admission that differs only in `updated_at`, with zero queued jobs and
unchanged runtime/settings, can be redone: retain all original
intent/probe/submission evidence, then make a fresh rolled-back admission and an
immediate native submission. Do not weaken the exact-hash guard. Never discard an unknown intent or retry
when a queue exists, a release changed or any unexplained configuration differs.

Mongo-only tRPC permission checks must cover authenticated state persistence.
Each canary writes and reads its app's own records and persists a profile
across restart.
These exact-image canaries use fresh Mongo volumes, an internal-only network,
synthetic auth values and a read-only synthetic environment file masking the
image's production file. This prevents a file-overloading loader from pulling in
production connections. Verification opt-out is confined to the fixture; native
deployment preserves production credentials and auth settings byte for byte.
External email and provider delivery are outside these disconnected tests.
Preserve 512 PIDs, capped memory/CPU, immutable image bytes, recorded tracking tag
and original backend identities. Take registered local native Mongo captures,
then prove native generation and admission before each serial replacement.
The matching Node Compose and drift-policy templates both default to 512 PIDs;
retain a separately measured lower limit where it has already been qualified.

New host security notices still require action after the original runtime patch.
Ubuntu [USN-8956-1](https://ubuntu.com/security/notices/USN-8956-1), published
26 October, supplied the separate system Brotli fix `libbrotli1 1.1.0-2ubuntu0.1`
for Noble. The watcher caught that pending package on every host. Its generic APT
review priority does not establish vendor severity; review the vendor notice
immediately and apply the 24-hour patch-or-isolate target when it identifies public
code execution. Updating Node's embedded decoder does not update the host library
or every copy in application images.

The host workflow pins one exact package, requires a removal-free simulation,
trusted Ubuntu security origins and a retained authenticated original package.
Patch one host, verify container/data/start identities, firewall, tailnet and
kernel controls, then proceed to the next. Restart identified library consumers
and check them again. Verify installed bytes against the signed package before
reviewing the exact integrity diff; never accept an entire current filesystem.
Refresh the watcher and require coverage of every actual running image ID before
recording completion. A resolved host package does not close image-package findings.

For an app on a Mongo replica set, the exact-image permission canary uses a fresh synthetic Mongo
replica set, not a production URI or copied database configuration. It exercises
signed-session signup, profile/project writes, timer start/stop, authenticated
WebSocket subscription and persistence across restart. Preserve its existing
512-PID limit and original Mongo identity. The tested image performs runtime
storage through its database; its source filesystem writers are build/export
tools and tests. File generation, uploads and external delivery are not
claimed by this canary. Keep the same immutable image and production environment
through native permission rollout, then verify public TLS readiness, qualified
drift rules and the exact AIDE diff before recording completion.

A PostgreSQL accounts service needs its own PostgreSQL and email-verification
fixture. Use the exact images, a fresh database and internal-only synthetic TLS
mail. Keep verification required, reject unverified sign-in, then verify the fake
link, sign in and check synthetic account credits/session persistence after an
app restart. Exercise real startup migrations and preserve any disabled paid-provider
boundary. The fixture CA belongs only to that container; never disable production
TLS checks or copy its credentials. Under umask 0077, explicitly set a synthetic
bind directory's traversal mode after mkdir; keep the host evidence parent 0700.

The native generator must preserve the app's existing capability drop and PID
limit. A successful deployment can reset old crash bookkeeping. Qualify the exact
observed reset against the pinned deployment-job source and unchanged writable
layer; do not allow arbitrary restart metadata or restart-limit changes. Retain
the first rejected verification and all earlier failed fixture evidence. Original
registered PostgreSQL SQL captures stay on the host and are not a new restore drill.

For remaining standalone Redis resource limits, native generation and runtime
compatibility are separate proofs. A non-executing `DatabaseStartCommandExecutor`
binding intercepts the real action's commands; the probe rolls back model and
environment changes and compares the full generated Compose document outside
memory, combined memory/swap, CPU and PID fields. The exact Redis 7.2.16 image
passed 1,000 authenticated writes, AOF restart and a separate cold RDB reload with
the optional 256 MiB/512 MiB/half-CPU/128-PID profile. Use only fresh synthetic data,
no network, and images without inherited credential keys or healthcheck commands.
Require measured headroom and verify cgroups plus new OOM/PID-denial counters.

Some standalone database definitions still reference upstream tags while their
running images contain local security rebuilds. Record that image-persistence gap
and qualify selection before a native restart/redeploy. Resource-only updates
preserve current running bytes and credentials. Configuration undo must remain
available for an owned stopped/OOM container, while refusing any changed image,
mount, credentials, network or unowned privilege setting. It must not restore an
older database snapshot. These source templates and probes do not establish that
the proposed profile is already applied to every live database.

The three qualified dedicated Redis resource profiles were applied serially on
27 October without replacing or restarting a production container. Each update
retained image/credentials/mounts/networks and passed all ten application readiness
checks with no new OOM kills or PID denials. The four fields persist in native
configuration; three exact-image monitoring profiles were added without changing
existing expectations. Public TLS checks cover all 13 configured routes, including
the games' read-only RPC endpoints and only the two reviewed Beauty alias redirects.
The exact policy file and parent timestamps were reviewed before AIDE promotion;
normal host checks and all seven accepted external checks passed.

The stopped-container undo canary preserves writes made after adding limits and
compares all original kernel controls. An unset Docker PID field can still inherit
a daemon/kernel default: never equate it with a literal unlimited cgroup. Retain
failed fixture/verifier attempts and explain each correction. Generator, canary and
undo proofs expire after one hour; measurement expires after 30 minutes. Resume
with fresh, separately retained attempts and reviewed source hashes. Do not extend
those windows or overwrite previous private evidence to make a rollout proceed.

The optional PostgreSQL resource fragment is 512 MiB memory, 1 GiB combined
memory/swap, one CPU and 128 PIDs. The qualified 16.15 image passed synthetic
transactions, custom-format dump/restore, restart persistence and stopped-container
undo preserving the latest writes. Explicitly initialize synthetic SCRAM host
rules when testing password authentication: initdb's default localhost trust can
otherwise make correct-password checks meaningless. Reject both missing and wrong
passwords. This fixture configuration does not establish production authentication
coverage or permission hardening. The two dedicated instances passed serial
resource-only changes without restart; measure each workload before copying the
profile, preserve its image/data/configuration and verify native persistence.

Measure MongoDB's configured WiredTiger ceiling before setting a smaller cgroup
limit. The five observed instances each allowed 3,524,263,936 cache bytes even
though current caches were under 45 MB. A 2 GiB container cap needs a compatible
engine cache setting, not just a Docker update. Qualify the supported startup
cache configuration, replica behavior, persistence and undo together; do not use
generic engine runtime reconfiguration as an unreviewed shortcut. See MongoDB's
[container/cache guidance](https://www.mongodb.com/docs/v7.0/faq/storage/) and
[server parameter guidance](https://www.mongodb.com/docs/v7.0/reference/parameters/).
Use mongosh script mode with /dev/stdin for original-host authentication input,
normalize bounded BSON numeric output explicitly, and retain fixed metadata
instead of raw shell output that could echo credentials. This observation does
not establish that MongoDB containment or canonical-image persistence is complete.

A native Mongo image/cache/resource rollout can close the gap between locally
patched running bytes and a pullable canonical image. The qualified public Mongo
7.0.45 digest excludes the distrusted roots. Four instances retain 7.0.45; the
replica is a tested same-major patch update from 7.0.40 to 7.0.45. The exact old
replica image recovered candidate-written data in the canary. A
512 MiB WiredTiger cache is paired with a 2 GiB memory / 3 GiB combined memory-swap
limit, one CPU and 512 PIDs. Preserve each project's original network and data
volumes, and merge only the cache field into an existing replica/keyfile config.
The native generator must preserve all remaining configuration. Test standalone
and replica transactions, native dump/restore, restart and old-image recovery on
candidate-written synthetic data before a serial production rollout.

The candidate still contains three js-yaml CPU-exhaustion matches. Their reviewed
entrypoint input is the controller-owned startup YAML, mounted read-only; database
protocol input does not feed that parser in the reviewed configuration. Keep the
raw matches and vendor fixes visible, record the exact-image input-boundary
evidence and a seven-day expiry, and apply no blanket suppression or automatic
renewal. See the maintainer's [merge-chain advisory](https://github.com/nodeca/js-yaml/security/advisories/GHSA-52cp-r559-cp3m),
[empty-source advisory](https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh)
and [ordered-map advisory](https://github.com/nodeca/js-yaml/security/advisories/GHSA-5p4m-2wfm-xmqj).

The periodic container policy now supports an exact-image `mongoCacheMaxBytes`
requirement. Authentication stays in container stdin, and only bounded numeric
metadata is returned. Missing credentials, timeout, malformed results or cache
drift cannot report healthy. Keep container policy required by the independent
publisher. Accept only tested unset-DNS serialization and equivalent root-startup
spellings while preserving configured DNS and verifying mongod's real UID. Review
source/policy payloads and parent timestamp changes exactly before AIDE promotion.


Shared service databases need separate measured resource profiles. The qualified
PostgreSQL 16.15 and two 18.6 images preserve their different data-volume layouts;
two lighter workloads use 512 MiB memory / 1 GiB combined memory-swap, one CPU and
128 PIDs, while the busier error-reporting database uses 1 GiB / 1.5 GiB and 256
PIDs. The reviewed Valkey 9.1.2 workload uses 256 MiB / 512 MiB, half a CPU and 128
PIDs. These are tested starting profiles, not universal database defaults. Preserve
image bytes, credentials, existing permissions, commands, volumes and networks.
Save four resource fields in both native raw and rendered Compose, verify the
native parser in rolled-back transactions and apply runtime limits serially.
Check real apps, SQL/PING, kernel controls and database network boundaries after
each change; retain current registered captures and tested current-data recovery.

A running container is insufficient database readiness. Exact-image reviewed
`databaseReady` controls run SELECT 1 or PING with authentication read inside the
container. Bound runtime/output, return no credentials or diagnostics, and fail
incomplete on connection errors. Never execute probes in changed image bytes.
Keep these controls required by the external publisher and prove failure folding
with a function-only probe that changes no live state and sends no delivery test.

A resource rollback that recreates a no-volume Valkey queue needs the latest
writable-layer state. Test graceful SHUTDOWN SAVE, safely suspend automatic
restart, retain the original stopped container, copy only its current validated
RDB archive into the exact original configuration and verify latest synthetic
writes. Keep artifacts on the original VPS and refuse changed identities,
configuration, mounts or network aliases. This planned healthy-process rollback
does not establish crash recovery for an already OOM-killed volatile queue. See
[Valkey CLI authentication](https://valkey.io/topics/cli/) and Docker's
[dynamic resource update guidance](https://docs.docker.com/reference/cli/docker/container/update/).


Include infrastructure binaries such as CoreDNS and Sentinel in runtime and
release review. Container package matches can hide an old compiled Go toolchain;
verify the running binary version rather than a mutable tag. The tailnet resolver
was CoreDNS 1.12.1 / Go 1.24.1. CoreDNS 1.15.0 is built with Go 1.27.3 and lists
security fixes in its [release notes](https://github.com/coredns/coredns/releases/tag/v1.15.0).
Its official image still contained the distrusted roots, so qualify the same
binary with a verified patched public CA bundle and a constrained build context.
Never infer certificate contents from a recent tag or a clean package scan.
Minimal images may lack cat/sh; inspect public CA files through the daemon archive
interface under bounds rather than treating missing executables as proof of trust.

For this stateless DNS role, preserve authoritative tailnet answers and refusal
of unrelated names, exact IPv4 tailnet-only UDP/TCP bindings, read-only root/config,
UID 65532 and no-new-privileges. Test the binary's NET_BIND_SERVICE file-capability
requirement explicitly; dropping its bounding capability can prevent execution.
Qualify 128 MiB memory / 256 MiB combined memory-swap, quarter CPU and 64 PIDs with
real UDP/TCP/AAAA/negative queries, latency, restart and old-image recovery.
Persist the reviewed Docker API configuration and fixed image ID in protected
host configuration. A narrow systemd launcher/reconciliation timer may recreate
only a missing reviewed container; unknown changes must fail visibly. Keep Docker
and Tailscale boot ordering explicit and never fall back to a public bind.

Require exact port-binding and dual-transport DNS checks in the independent
publisher's container policy. Limit DNS packet size and total deadline, validate
transactions, reject public probe destinations and keep raw diagnostics out of
reports. A function-only fault probe can test alert folding without changing live
state or sending mail. Review every added launcher/config/unit/symlink and parent
timestamp against source fingerprints before promoting AIDE; no scheduled baseline
learning. Retain the stopped old container for rollback and refresh the normal
image ledger without resetting deadlines for surviving packages.

Coolify's installed 4.5.0 generator includes environment escaping for the fixed
[Sentinel token-injection advisory](https://github.com/coollabsio/coolify/security/advisories/GHSA-rpr8-p7jc-x844),
which affects versions below 4.0.0-beta.466. The inspected generator still hardcodes
the raw Docker socket and host PID namespace and exposes no resource-limit fields.
Do not claim Sentinel socket isolation from a read-only mount or temporary runtime
settings. Its native lifecycle needs a supported configuration or a separately
reviewed integration before containment can be called durable.
