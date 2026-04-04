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

**What it does:** Creates a dedicated user (e.g., `rico`) with sudo privileges and SSH key authentication. Root login is subsequently disabled.

**Why it matters:** The `root` account is the #1 target for automated attacks. Every bot on the internet tries `ssh root@<your-ip>` with common passwords. Even with key-only auth, running as root means any process you launch has unrestricted system access. A bug in your application could `rm -rf /` or read `/etc/shadow`. A non-root user with sudo means you get root when you explicitly ask for it, and your regular processes run with limited privileges.

**The attack vector:** Credential stuffing. Botnets scan IPv4 ranges and try thousands of username/password combinations per minute. Hetzner IPs are in well-known ranges and get targeted within minutes of a server going live.

**How to apply:**

```bash
# Create user with no password (key-only auth)
adduser --disabled-password --gecos "" rico

# Grant passwordless sudo
echo "rico ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/rico
chmod 440 /etc/sudoers.d/rico

# Set up SSH key
mkdir -p /home/rico/.ssh
cp /root/.ssh/authorized_keys /home/rico/.ssh/authorized_keys
chown -R rico:rico /home/rico/.ssh
chmod 700 /home/rico/.ssh
chmod 600 /home/rico/.ssh/authorized_keys
```

**What could go wrong:**
- **Locking yourself out:** If you disable root login before verifying the rico user can SSH in, you're locked out. Always test from a second terminal before closing your root session.
- **Passwordless sudo debate:** Some guides require a password for sudo. For a single-operator server with key-only SSH, passwordless sudo is fine — the SSH key IS your authentication factor. Requiring a password you'd have to store somewhere doesn't add meaningful security.
- **Hetzner rescue mode:** If you do lock yourself out, Hetzner's rescue system lets you mount your disk and fix the SSH config. It's your safety net.

**Automation:** `cloud-init/ubuntu-24.04-hardened.yaml` creates this user on first boot. The SSH key comes from Terraform (`hcloud_ssh_key`).

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
AllowUsers rico
```

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
- **MaxStartups:** `3:50:10` means: after 3 unauthenticated connections, start randomly dropping 50% of new ones, hard-cap at 10. This rate-limits brute-force attempts at the connection level, before fail2ban even sees them. Too aggressive and you might block yourself if you have multiple terminal
  tabs connecting simultaneously.

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

**What it does:** UFW (Uncomplicated Firewall) is a user-friendly frontend for
`iptables`/`nftables`. It configures the Linux kernel's built-in packet filter
to drop traffic that doesn't match explicit allow rules.

**Why it matters:** Even though Hetzner's firewall handles the perimeter, UFW
provides a second layer inside the VM. This matters because:
- It protects against lateral movement (if another VM in your Hetzner project
  is compromised, Hetzner's firewall won't help — it's between your project
  and the internet, not between your VMs)
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

**How UFW works internally:** UFW writes iptables rules to
`/etc/ufw/user.rules` and `/etc/ufw/user6.rules`. When enabled, it loads these into the kernel's netfilter framework. The kernel checks every incoming packet against these rules in order (first match wins). Denied packets are either dropped (silently discarded) or rejected (ICMP unreachable sent back).

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
- `backend = systemd` — read from journald instead of log files (more
  reliable on modern Ubuntu)

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
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
```

Verify:

```bash
unattended-upgrades --dry-run --debug
```

**What could go wrong:**
- **Breaking changes in security updates:** Rare but possible. A security patch to OpenSSL could break TLS in your application. The risk is real but small — Ubuntu security updates are conservative and well-tested.
- **Automatic reboot during peak hours:** The `Automatic-Reboot-Time "04:00"` setting helps, but if your users are global, there's no good time. For game servers with active sessions, this is a real concern. Consider disabling auto-reboot and scheduling maintenance windows instead.
- **Disk space:** Old kernels accumulate `Remove-Unused-Kernel-Packages` and  `Remove-Unused-Dependencies` prevent `/boot` from filling up. A full `/boot` partition blocks all future updates — a surprisingly common failure mode.
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

# Disable unnecessary services
systemctl disable --now snapd snapd.socket snapd.seeded 2>/dev/null
systemctl disable --now multipathd 2>/dev/null
systemctl disable --now ModemManager 2>/dev/null
```

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

**How it works internally:** Tailscale assigns each device a 100.x.y.z
address from the CGNAT range (100.64.0.0/10). Traffic between devices is encrypted end-to-end with WireGuard (ChaCha20-Poly1305). The coordination server (Tailscale's infrastructure) handles key exchange and NAT traversal, but never sees your traffic. Direct connections use UDP hole-punching; when that fails, traffic relays through Tailscale's DERP servers (still encrypted).

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
ufw allow from 100.64.0.0/10 to any port 22 proto tcp comment 'SSH via Tailscale'
```

**Tailscale SSH mode:** The `--ssh` flag enables Tailscale's built-in SSH server. This means you can use `tailscale ssh rico@<hostname>` without configuring SSH keys at all — Tailscale handles authentication via your identity provider. Your regular OpenSSH server still works over the tailnet for compatibility.

**What could go wrong:**
- **Locking yourself out by closing port 22 too early:** If Tailscale isn't working and you've already closed public SSH, you're locked out. ALWAYS verify Tailscale SSH works from another device before closing port 22. The Ansible role verifies Tailscale connectivity before modifying UFW.
- **Tailscale outage:** If Tailscale's coordination servers go down, existing connections survive but new ones can't be established. Emergency access: use Hetzner's web console (VNC) to temporarily re-allow port 22.
- **Auth key expiry:** Tailscale auth keys can expire. Use a reusable, pre-authorized key and be aware it's valid for 90 days by default. Generate a new one in the Tailscale admin console.
- **Tailscale + Docker:** Tailscale runs in userspace by default. If you also use it as a Docker network (exit node, subnet router), configuration gets complex. For basic SSH access, the default setup is fine.

**Automation:** `ansible/roles/tailscale/`

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
- **rp_filter and asymmetric routing:** If your server has multiple network interfaces with different routes, strict rp_filter (value 1) can drop legitimate packets. On a single-NIC Hetzner VPS, this isn't an issue.

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

**Option A — Bind to localhost only (recommended):**

```bash
# Instead of:
docker run -p 8080:80 nginx          # Accessible from internet!

# Do:
docker run -p 127.0.0.1:8080:80 nginx  # Only accessible locally
```

Then use a reverse proxy (Caddy, Traefik, Nginx) on the host to route traffic.
Coolify does this automatically with Traefik.

**Option B — DOCKER-USER chain:**

Docker provides the `DOCKER-USER` chain specifically for user rules. It's evaluated before Docker's own rules:

```bash
# Drop all external traffic to Docker containers
iptables -I DOCKER-USER -i eth0 -j DROP

# Allow specific ports
iptables -I DOCKER-USER -i eth0 -p tcp --dport 80 -j ACCEPT
iptables -I DOCKER-USER -i eth0 -p tcp --dport 443 -j ACCEPT

# Save rules to persist across reboots
apt install iptables-persistent
netfilter-persistent save
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

**Automation:** The `ansible/roles/ufw/` role sets up DOCKER-USER chain rules. The guide recommends Option A (localhost binding) as the primary approach.

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

**TCP BBR congestion control:**

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

**How to apply:**

Add to `/etc/fstab`:

```
tmpfs /tmp        tmpfs rw,noexec,nosuid,nodev,size=2G,mode=1777 0 0
tmpfs /dev/shm    tmpfs rw,noexec,nosuid,nodev,size=1G           0 0
```

For `/var/tmp`, bind-mount it to `/tmp` so it inherits the same restrictions:

```
/tmp /var/tmp none bind 0 0
```

Then remount:

```bash
mount -o remount /tmp
mount -o remount /dev/shm
```

**What could go wrong:**
- **Build tools that execute from /tmp:** Some package installers (`dpkg`,
  `apt`) and build systems extract and execute scripts in `/tmp`. If an `apt
  upgrade` fails with "Permission denied", temporarily remount:
  `mount -o remount,exec /tmp`, do the upgrade, then remount with `noexec`.
- **Docker and /dev/shm:** Docker containers have their own `/dev/shm` (not
  the host's), so container workloads are unaffected. The host's `/dev/shm`
  restriction only applies to host processes.
- **Applications that need /tmp execution:** Some Java applications and
  snap packages need to execute from `/tmp`. Test before deploying.

**Automation:** `ansible/roles/base/` (fstab entries for `/tmp`, `/dev/shm`,
`/var/tmp`).

---

### 2.8 Core dumps disabled

**What it does:** Prevents processes from writing memory dumps to disk when
they crash.

**Why it matters:** When a process crashes, the kernel can write its entire
memory contents to a "core dump" file. This includes everything the process
had in memory: environment variables (API keys, database passwords), session
tokens, encryption keys, user data. An attacker who can trigger a crash (e.g.,
via a crafted request that causes a segfault) and read the core dump gets all
of these secrets for free.

Even without an attacker, core dumps sitting on disk are a liability — they
contain secrets that survive process termination.

**How to apply:**

sysctl (`/etc/sysctl.d/99-hardening.conf`):

```ini
# Disable core dumps for SUID programs
fs.suid_dumpable = 0
```

Limits (`/etc/security/limits.d/hardening.conf`):

```
# Disable core dumps for all users
*    hard    core    0
```

systemd (`/etc/systemd/coredump.conf.d/hardening.conf`):

```ini
[Coredump]
Storage=none
ProcessSizeMax=0
```

**What could go wrong:**
- **Debugging crashes becomes harder:** Without core dumps, you lose the
  ability to post-mortem debug with `gdb`. If you need to debug a crash,
  temporarily re-enable: `ulimit -c unlimited` in the debugging session.
- **systemd-coredump:** Ubuntu uses systemd-coredump by default, which
  stores dumps in `/var/lib/systemd/coredump/`. The systemd config above
  disables this.

**Automation:** `ansible/roles/base/` (sysctl template, limits file, and
systemd coredump config).

---

### 2.9 Default umask

**What it does:** Sets the default file creation permission mask so new files
are not world-readable.

**Why it matters:** Ubuntu's default umask is `022`, meaning every file you
create is readable by all users (`-rw-r--r--`) and every directory is
listable by all users (`drwxr-xr-x`). On a multi-user system this enables
information disclosure; on a single-user server it's less critical but still
violates the principle of least privilege.

A umask of `027` means: owner gets full access, group gets read/execute,
others get nothing. Files are created as `-rw-r-----`, directories as
`drwxr-x---`.

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
- **Web server file permissions:** If your app creates files that a web
  server needs to read (e.g., static assets), a strict umask may break this.
  Docker containers have their own umask, so containerized apps are unaffected.
- **Shared directories:** If multiple services need to access the same
  files, `027` may be too restrictive. `027` is the safe default for a
  single-operator server.

**Automation:** `ansible/roles/base/` (sets `UMASK` in `/etc/login.defs`).

---

### 2.10 Time synchronization

**What it does:** Ensures your server's clock is accurate and synchronized
with trusted time sources using NTP (Network Time Protocol).

**Why it matters:** An inaccurate clock breaks more than you'd think:
- **TLS certificate validation:** Certificates have validity windows. A clock
  that's off by more than a few minutes can cause TLS handshakes to fail
  (your server rejects valid certs as "not yet valid" or "expired").
- **fail2ban timing:** `findtime` and `bantime` depend on accurate
  timestamps. A wrong clock means fail2ban's sliding windows are wrong.
- **Log correlation:** If you're investigating an incident, timestamps that
  don't match reality make forensics nearly impossible.
- **Kerberos / OAuth:** Token-based auth systems have tight time tolerances.
- **Replay attacks:** An attacker who can skew your clock can replay expired
  tokens or certificates.

Ubuntu 24.04 ships with `systemd-timesyncd` enabled by default, which syncs
with `ntp.ubuntu.com`. This is adequate for most setups. For higher security,
use `chrony` with multiple trusted sources.

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
- **NTP port blocked:** NTP uses UDP port 123. If your outbound firewall
  blocks this (section 3.7), time sync breaks. The Hetzner firewall allows
  outbound by default.
- **Time jumps:** Large clock adjustments can confuse applications. `chrony`
  handles this gracefully with slewing (gradual adjustment) rather than
  stepping (instant jump).

**Automation:** `ansible/roles/base/` (ensures `systemd-timesyncd` or
`chrony` is running and configured).

> **Further reading:**
> - [chrony documentation](https://chrony-project.org/documentation.html) — official docs; covers NTS (Network Time Security) for authenticated NTP
> - [Falsehoods programmers believe about time](https://gist.github.com/timvisee/fcda9bbdff88d45cc9061606b4b923ca) — humbling list that illustrates why time is harder than you think

---

## Tier 3 — Advanced / optional

These provide additional hardening but add complexity. Apply them based on your
threat model and comfort level. The Ansible automation does NOT apply these by
default — they require opt-in.

### 3.1 Kernel boot parameters

**What it does:** Configures kernel hardening features at boot time via GRUB
command line parameters.

**Why it matters:** Some security features can only be enabled at boot, before
the kernel initializes memory and process management. These parameters harden
memory allocation, enable security modules, and mitigate CPU vulnerabilities.

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

Edit `/etc/default/grub`, add to `GRUB_CMDLINE_LINUX_DEFAULT`, then:

```bash
update-grub
reboot
```

**Performance impact:** `init_on_alloc=1` and `init_on_free=1` have a 1-5%
CPU overhead depending on allocation patterns. For a web/game server, this is
negligible. `slab_nomerge` increases memory usage slightly by preventing the
kernel from combining similar-sized allocations.

**What could go wrong:**
- **Boot failure:** A wrong GRUB parameter can prevent booting. Hetzner's
  rescue mode lets you mount the disk and fix GRUB.
- **Performance regression:** If your workload is allocation-heavy (e.g., a
  JVM with large heap), `init_on_free=1` can be noticeable. Test with your
  workload.

> **Further reading:**
> - [Linux Hardening Guide (Madaidan) — Kernel section](https://madaidans-insecurities.github.io/guides/linux-hardening.html#kernel) — the most detailed public reference for kernel boot parameters; explains each parameter's security impact
> - [Kernel command-line parameters (kernel.org)](https://www.kernel.org/doc/html/latest/admin-guide/kernel-parameters.html) — the official kernel documentation; authoritative but not beginner-friendly
> - [Spectre/Meltdown mitigations (kernel.org)](https://www.kernel.org/doc/html/latest/admin-guide/hw-vuln/) — official docs on CPU vulnerability mitigations in the kernel

---

### 3.2 AppArmor

**What it does:** Mandatory Access Control (MAC) system that confines programs
to a limited set of resources. Unlike traditional Unix permissions (which are
discretionary — the file owner decides), AppArmor policies are enforced by the
kernel regardless of the process's UID.

**Why it matters:** If your web application is compromised, AppArmor limits
what the attacker can access — even if they're running as the same user as
your app. The app can only read/write files explicitly listed in its profile.

Ubuntu ships with AppArmor enabled and profiles for common services. Docker
containers get a default AppArmor profile that blocks most dangerous
operations. For custom applications, you'd write custom profiles.

**How to check:**

```bash
aa-status                    # List loaded profiles and their modes
aa-enforce /etc/apparmor.d/* # Enforce all profiles (vs. complain mode)
```

**When to invest time here:** If you're running untrusted code (user uploads,
plugins) or high-value services (payment processing). For a typical game
server running your own code in Docker, the default Docker AppArmor profile
is sufficient.

---

### 3.3 AIDE — file integrity monitoring

**What it does:** AIDE (Advanced Intrusion Detection Environment) creates a
database of cryptographic hashes for system files. Periodic checks compare
current files against the database, alerting you if anything changed.

**Why it matters:** If an attacker modifies system binaries (rootkit), adds
SSH keys, or changes config files, AIDE detects it. This is your alarm system
for "someone was here."

**How to apply:**

```bash
apt install aide -y
aide --init
mv /var/lib/aide/aide.db.new /var/lib/aide/aide.db

# Daily check via cron
echo '0 5 * * * root /usr/bin/aide --check | mail -s "AIDE report" you@example.com' \
  > /etc/cron.d/aide-check
```

**What could go wrong:**
- **False positives everywhere:** Every `apt upgrade` changes system binaries.
  You'll need to run `aide --update` after every legitimate change.
- **No email configured:** AIDE reports go to email. If you haven't set up
  mail (msmtp, postfix), reports go nowhere.

---

### 3.4 Rootkit detection

**Tools:** `rkhunter` and `chkrootkit`

**What they do:** Scan for known rootkit signatures, suspicious files, and
unusual system state (hidden processes, modified binaries).

```bash
apt install rkhunter chkrootkit -y
rkhunter --update
rkhunter --check --skip-keypress
chkrootkit
```

**Limitations:** Signature-based detection only finds known rootkits. A
sophisticated attacker with a custom rootkit won't be detected. These tools
are most useful against automated/commodity attacks.

---

### 3.5 Log monitoring

**What it does:** Tools like `logwatch` aggregate and summarize log files,
sending daily reports.

```bash
apt install logwatch -y
logwatch --detail med --output stdout --range today
```

**Alternative:** For a more modern approach, consider shipping logs to an
external service (Grafana Loki, Datadog, etc.) so they survive even if the
server is compromised.

---

### 3.6 Encrypted DNS

**What it does:** DNS queries are normally sent in plaintext UDP. Anyone on
the network path can see what domains you're resolving. `dnscrypt-proxy` or
`systemd-resolved` with DNS-over-TLS encrypts these queries.

```bash
apt install dnscrypt-proxy -y
# Configure /etc/dnscrypt-proxy/dnscrypt-proxy.toml
# Point to encrypted resolvers (Cloudflare, Quad9)
```

**When it matters:** If you're worried about DNS-based surveillance or
DNS poisoning attacks. For most VPS setups, Hetzner's DNS resolvers are
trustworthy and on the same network.

---

### 3.7 Outbound firewall restrictions

**What it does:** Instead of allowing all outbound traffic, restrict outgoing
connections to specific ports and destinations.

```bash
ufw default deny outgoing
ufw allow out 22/tcp     # SSH
ufw allow out 53/udp     # DNS
ufw allow out 80/tcp     # HTTP (for apt)
ufw allow out 123/udp    # NTP
ufw allow out 443/tcp    # HTTPS
```

**Why it matters:** If an attacker compromises your server, outbound
restrictions prevent them from:
- Exfiltrating data to arbitrary hosts
- Downloading additional tools/malware
- Establishing reverse shells on non-standard ports
- Using your server as a proxy

**What could go wrong:** Docker, Tailscale, and many services need outbound
connectivity. Restricting outbound traffic is high-maintenance — every new
service needs a rule. For a single-operator VPS, the benefit may not justify
the ongoing effort.

---

### 3.8 Lynis security auditing

**What it does:** Lynis scans your system and produces a hardening score with
specific, actionable recommendations. It checks hundreds of settings across
SSH, filesystems, kernel, networking, authentication, and more.

**Why it matters:** After applying hardening, you need a way to verify
nothing was missed and to catch regressions. Lynis is the standard tool
for this — trusted by enterprises, used in CIS benchmark validation, and
completely open source.

**How to apply:**

```bash
apt install lynis -y

# Full audit
lynis audit system

# The report is at /var/log/lynis-report.dat
# Suggestions are listed at the end of stdout
```

Lynis outputs a "Hardening index" (0-100). A freshly hardened server using
this guide typically scores 75-85. Getting above 90 requires Tier 3 measures.

**How to read the output:**
- **[WARNING]** — serious issues that should be fixed
- **[SUGGESTION]** — improvements ranked by impact
- **[OK]** — checks that passed

Run Lynis periodically (monthly) or after major changes to catch drift.

**Automation:** `ansible/roles/lynis/` (installs Lynis and runs an audit).

---

### 3.9 SUID/SGID binary audit

**What it does:** Identifies binaries with the SUID or SGID bit set — these
run with elevated privileges regardless of who executes them.

**Why it matters:** SUID binaries are the classic privilege escalation vector.
A vulnerability in any SUID-root binary gives an attacker instant root access.
Ubuntu ships with dozens of SUID binaries, most of which your server never
needs.

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
- **Stripping sudo or su:** Don't. You'll lock yourself out of privilege
  escalation entirely.
- **Package updates restore SUID:** `apt upgrade` will restore the SUID bit
  on updated binaries. Re-audit after upgrades.

---

### 3.10 Kernel module loading restriction

**What it does:** After boot, prevents loading new kernel modules entirely.

**Why it matters:** Kernel modules run with full kernel privileges. A rootkit
loaded as a kernel module has complete control over the system and is nearly
undetectable. By disabling module loading after boot, even root can't load
a malicious module.

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
- **This is irreversible until reboot.** Once set, you can't load any
  kernel module — not even legitimate ones. Plugging in a USB device that
  needs a module, loading a filesystem driver, or adding a network module
  all fail.
- **Docker and modules:** Docker sometimes needs to load the `br_netfilter`
  or `overlay` modules. If these aren't loaded before the restriction takes
  effect, Docker networking breaks. The Ansible role loads required modules
  first, then restricts.
- **VPN modules:** WireGuard/Tailscale may need the `wireguard` module. On
  modern kernels it's built-in, but check with `lsmod | grep wireguard`.

**Automation:** `ansible/roles/base/` (optional, via `sysctl_disable_module_loading`
variable; loads required modules before restricting).

---

### 3.11 Resource limits

**What it does:** Configures per-user resource limits to prevent processes
from consuming excessive system resources.

**Why it matters:** Without limits, a single runaway process (or a deliberate
fork bomb: `:(){ :|:& };:`) can consume all PIDs, memory, or file descriptors,
crashing every service on the server. Limits are your safety net against both
bugs and attacks.

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
- **nproc too low for Docker:** Docker can spawn many processes. 4096 is
  generous for a server, but if you're running many containers, increase it.
- **nofile too low for databases:** Databases like MongoDB and PostgreSQL
  need many open file descriptors. 65535 is usually sufficient; check your
  database docs.

**Automation:** `ansible/roles/base/` (deploys limits config file).

---

### 3.12 auditd — system call auditing

**What it does:** The Linux Audit Framework (`auditd`) records system calls,
file access, privilege escalation attempts, and user commands at the kernel
level. It's the most comprehensive logging system available on Linux.

**Why it matters:** If your server is compromised, `auditd` logs tell you
exactly what the attacker did: what files they read, what commands they ran,
what processes they spawned. Regular logs only capture what applications
choose to log; `auditd` captures everything at the kernel level.

**How to apply:**

```bash
apt install auditd audispd-plugins -y

# Example rules — add to /etc/audit/rules.d/hardening.rules

# Log all commands executed by root
-a always,exit -F arch=b64 -F euid=0 -S execve -k root_commands

# Log changes to authentication files
-w /etc/passwd -p wa -k auth_changes
-w /etc/shadow -p wa -k auth_changes
-w /etc/sudoers -p wa -k auth_changes
-w /etc/ssh/sshd_config -p wa -k ssh_changes

# Log privilege escalation
-w /usr/bin/sudo -p x -k privilege_escalation
-w /usr/bin/su -p x -k privilege_escalation

# Make audit config immutable (requires reboot to change)
-e 2
```

```bash
systemctl enable auditd
systemctl restart auditd

# Search audit logs
ausearch -k root_commands --start recent
aureport --summary
```

**What could go wrong:**
- **Disk space:** `auditd` generates a lot of logs. Configure log rotation
  in `/etc/audit/auditd.conf` (set `max_log_file` and `num_logs`).
- **Performance:** Auditing every system call has overhead. The rules above
  are targeted (only root commands and auth files), keeping impact minimal.

> **Further reading:**
> - [Red Hat: Linux Audit system reference](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/7/html/security_guide/chap-system_auditing) — the most thorough auditd guide available

---

### 3.13 SSH two-factor authentication

**What it does:** Adds a TOTP (Time-based One-Time Password) second factor
to SSH, requiring both an SSH key and a 6-digit code from an authenticator
app (Google Authenticator, Authy, etc.).

**Why it matters:** SSH keys can be stolen (malware on your laptop, backup
leaked, key agent forwarded to a compromised host). 2FA means a stolen key
alone isn't enough — the attacker also needs your phone.

**How to apply:**

```bash
apt install libpam-google-authenticator -y
```

As your rico user:

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
- **Locked out if you lose your phone:** Keep the emergency backup codes
  from the initial setup. Store them securely (password manager, not on the
  server).
- **Automated tools break:** Any script that SSHes in (Ansible, CI/CD)
  can't type a TOTP code. Exempt specific users or use Tailscale SSH for
  automated access.
- **Tailscale SSH bypasses 2FA:** Tailscale SSH authenticates via your
  identity provider, not PAM. If you use Tailscale SSH exclusively,
  PAM-based 2FA on OpenSSH becomes irrelevant (but still protects the
  fallback OpenSSH path).

**When to use:** High-value servers (production databases, payment systems)
or if you don't use Tailscale. For a solo dev with Tailscale, the value is
marginal — Tailscale already provides strong identity verification.

---

### 3.14 Cloudflare Tunnel

**What it does:** Creates an outbound-only encrypted tunnel from your server
to Cloudflare's edge network. Traffic reaches your server through this tunnel
— no inbound ports needed at all.

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
- **Cloudflare dependency:** Your site goes down if Cloudflare goes down.
  For most users, Cloudflare's uptime exceeds what you'd achieve yourself.
- **WebSocket support:** Cloudflare Tunnels support WebSockets. For game
  servers with persistent connections, test latency — the extra hop through
  Cloudflare adds 5-20ms.
- **Cost:** The free plan covers most use cases. You pay for Cloudflare's
  premium features, not the tunnel itself.

**Trade-off vs. Tailscale:** Tailscale secures admin access (SSH). Cloudflare
Tunnel secures public access (web traffic). They complement each other:
Tailscale for you, Cloudflare for your users.

---

### 3.15 Backups

**What it does:** Creates regular, tested, off-server copies of your data.

**Why it matters:** Backups are security. They protect against:
- **Ransomware:** Attacker encrypts your disk, demands payment. You restore
  from backup instead.
- **Accidental destruction:** `terraform destroy` on the wrong stack, `rm
  -rf` in the wrong directory, a failed upgrade that corrupts data.
- **Hardware failure:** Hetzner disks can fail (rare but real).
- **Compromised server:** If an attacker modifies your data, you can restore
  a known-good state.

**The 3-2-1 rule:**
- **3** copies of your data (original + 2 backups)
- **2** different storage types (local + remote)
- **1** copy offsite (different provider or region)

**For a Hetzner VPS:**

```bash
# Hetzner Cloud snapshots (easiest, not true offsite)
hcloud server create-image --type snapshot <server-id>

# Automated backup with restic to Hetzner Object Storage (S3)
apt install restic -y
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
restic -r s3:https://nbg1.your-objectstorage.com/backups init
restic -r s3:https://nbg1.your-objectstorage.com/backups backup /var/lib/docker/volumes

# Daily backup via cron
echo '0 3 * * * root restic -r s3:... backup /var/lib/docker/volumes --quiet' \
  > /etc/cron.d/backup
```

**What could go wrong:**
- **Untested backups:** A backup you've never restored from is not a backup.
  Test restoration quarterly.
- **Backup credentials on the server:** If the attacker has your server and
  your backup credentials, they can delete your backups too. Use append-only
  backup credentials where possible.
- **Backing up the wrong things:** For Docker/Coolify, the important data is
  in `/var/lib/docker/volumes/` (databases, uploads) and your `.env` files.
  The server itself is reproducible via Terraform + Ansible.

> **Further reading:**
> - [restic documentation](https://restic.readthedocs.io/) — excellent backup tool with encryption, deduplication, and S3 support
> - [Hetzner Backup documentation](https://docs.hetzner.com/cloud/servers/getting-started/enabling-backups/) — Hetzner's built-in snapshot/backup service

---

## Coolify-specific hardening

Coolify has a unique lifecycle that requires a two-phase security approach.

### Phase 1 — Bootstrap (ports open)

During initial setup, Coolify needs:
- **Port 8000:** Dashboard web UI (used to create admin account, configure
  domain, set up HTTPS)
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

After lockdown, Coolify's dashboard is only accessible via its domain
(proxied through Traefik on ports 80/443). If you have Tailscale, you can
also access it via `http://<tailscale-ip>:8000`.

### Docker port safety with Coolify

Coolify uses Traefik as its reverse proxy. Application containers should NOT
have their ports published directly. Instead, Traefik routes traffic based on
domain names:

```
Internet → :443 → Traefik → Docker internal network → Your container :3000
```

This means your application container doesn't need any published ports — it's
only accessible via Traefik's internal Docker network. This is the correct
and secure setup.

**Red flag:** If you see your app containers with `-p 0.0.0.0:3000:3000` in
`docker ps`, something is misconfigured. The port is accessible from the
internet regardless of UFW.

---

## Emergency recovery

### "I locked myself out of SSH"

1. **Hetzner web console:** Cloud Console → Server → Console (VNC). Gives you
   a terminal directly on the VM, bypassing SSH entirely.
2. **Hetzner rescue mode:** Boot into a rescue system, mount your disk, fix
   `/etc/ssh/sshd_config` or `/etc/ufw/user.rules`.
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
# From Hetzner console:
ufw allow 22/tcp
# SSH in from your public IP, fix Tailscale
# Then re-restrict:
ufw delete allow 22/tcp
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

Use this to verify your server after manual setup or to audit an existing
server:

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

Curated reading for building a deeper understanding of Linux security.
Organized from "start here" to "go deeper."

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
